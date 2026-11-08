// Kiểm tra độ bền của kết quả Chương 4 (08/11, theo góp ý phản biện). Không gọi TomTom, chỉ dùng ma trận đã ghi.
//   node experiments/kiem_tra_do_ben.js [--bo 30] [--ils 1000000] [--out experiments/ket_qua_do_ben.json]
// Bốn phần, cùng 30 bộ đơn ngẫu nhiên × 3 ngày giao thông như nhieu_bo_don.js:
//   a) Mốc so sánh gần với cách chia tay: Sweep (chia đơn theo góc quanh kho, mỗi xe một vùng liền nhau, số điểm cân
//      bằng giữa các xe) rồi đi điểm gần nhất (Nearest Neighbor).
//   b) Có khung giờ: lập kế hoạch với khung giờ là ràng buộc cứng (cách hệ thống chạy), so với Iterated Local Search.
//      Khung giờ gắn theo điểm giao như Phụ lục E, nên đơn nào rơi vào điểm có khung giờ thì có khung giờ đó.
//   c) Ngoài mẫu: lập kế hoạch bằng giao thông Thứ Hai rồi chấm trên Thứ Năm, Thứ Bảy; lập bằng 2 mốc 16:00 và 17:00
//      (cấu hình Backend) rồi chấm trên 4 mốc của cùng ngày.
//   d) Độ nhạy theo thời gian dừng mỗi điểm (60/90/180 giây) và hệ số thời gian chạy của xe máy (0,7/0,85/1,0),
//      trên 30 bộ đơn ngày Thứ Hai.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { clockSeconds, groupedProblem, interpolateSlots, plan, routeSchedule } from '../src/index.js';
import { ils, rng } from './mo_phong.js';

const args = process.argv.slice(2);
const lay = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SO_BO = Number(lay('--bo', 30));
const ILS_CAP = Number(lay('--ils', 1_000_000));
const OUT = lay('--out', new URL('./ket_qua_do_ben.json', import.meta.url));

const fx = name => new URL(`../test/fixtures/${name}`, import.meta.url);
const read = name => JSON.parse(readFileSync(fx(name), 'utf8'));
const kb = read('kich_ban_60.json');
const TYPE = { xe_may: 'motorcycle', xe_tai: 'small_truck' };
const GIO = ['16:00', '16:30', '17:00', '17:30'];
const tep = (d, g) => d === '20261026' ? `ma_tran_60_${g.replace(':', '')}.json` : `ma_tran_60_${d}_${g.replace(':', '')}.json`;
const NGAY = [['20261026', 'Thứ Hai 26/10'], ['20261112', 'Thứ Năm 12/11'], ['20261114', 'Thứ Bảy 14/11']]
  .filter(([d]) => GIO.every(g => existsSync(fx(tep(d, g)))));

function slotsOf(d, gio = GIO) {
  return gio.map(label => {
    const m = read(tep(d, label));
    const index = new Map(m.diem.map((p, i) => [p.ma, i]));
    return { label, seconds: clockSeconds(label), travel: (p, a, b) => m.thoi_gian[p][index.get(a)][index.get(b)] };
  });
}
const TRUTH = Object.fromEntries(NGAY.map(([d]) => [d, interpolateSlots(slotsOf(d))]));
const TWO = Object.fromEntries(NGAY.map(([d]) => [d, interpolateSlots(slotsOf(d, ['16:00', '17:00']))]));
const H = clockSeconds(kb.ca.bat_dau), END = clockSeconds(kb.ca.ket_thuc);
const vehicles = kb.xe.map((x, i) => ({ id: i + 1, type: TYPE[x.loai], profile: x.cau_hinh, capacityKg: x.tai_trong_kg, capacityParcels: x.so_kien_toi_da }));
const WIN = new Map(kb.don.filter(d => d.khung_gio).map(d => [d.diem, d.khung_gio]));
const XY = new Map([[kb.kho.ma, kb.kho], ...kb.diem.map(p => [p.ma, p])]);

/** Bài toán trên giao thông `time` (hàm theo giờ). moto: hệ số nhân thời gian chạy của xe máy. */
function problem(orders, time, { windows = false, stop = kb.phuc_vu.moi_diem_giay, moto = 1, objective = 'makespan' } = {}) {
  const t = moto === 1 ? time : (p, a, b, s) => { const x = time(p, a, b, s); return x == null || p !== 'motorcycle' ? x : x * moto; };
  return {
    depot: 'KHO', objective, travel: (p, a, b) => t(p, a, b, H), travelAt: t,
    startSeconds: H, shiftEndSeconds: END, stopSeconds: stop, serviceSeconds: kb.phuc_vu.moi_don_giay,
    orders: orders.map((d, i) => {
      const w = windows && WIN.get(d.diem);
      return {
        id: i + 1, code: d.ma, point: d.diem, weightKg: d.khoi_luong_kg, parcels: d.so_kien, vehicleTypes: d.loai_xe.map(x => TYPE[x]),
        ...(w ? { notBeforeSeconds: clockSeconds(w.tu), notAfterSeconds: clockSeconds(w.den) } : {}),
      };
    }),
    vehicles,
  };
}
const ordersOf = seed => { const rand = rng(seed * 7919); return kb.don.map(o => ({ ...o, diem: kb.diem[Math.floor(rand() * kb.diem.length)].ma })); };
function planned(P, options = {}) {
  const t0 = performance.now();
  const r = plan(P, options);
  const index = new Map(P.orders.map((o, i) => [o.id, i]));
  return { routes: r.routes.map(x => x.orderIds.map(id => index.get(id))), unassigned: r.unassigned.length, ms: performance.now() - t0 };
}
/** Chấm một kế hoạch (chỉ số đơn theo P) trên bài toán Q: giờ xe cuối về kho, số xe về sau giờ hết ca, đơn trễ khung giờ. */
function score(Q, routes, unassigned = 0) {
  let finish = H, lateShift = 0, lateWin = 0, used = 0;
  routes.forEach((r, v) => {
    if (!r.length) return;
    const s = routeSchedule(Q, v, r);
    used++; finish = Math.max(finish, s.end);
    if (s.end > END + 1e-9) lateShift++;
    lateWin += s.lateCount;
  });
  return { finish, vehicles: used, lateShift, lateWin, unassigned };
}

/** Sweep + Nearest Neighbor: chia vùng theo góc, mỗi xe một vùng liền nhau, số điểm gần bằng nhau. */
function sweepNN(P) {
  const k0 = XY.get('KHO');
  const angle = p => Math.atan2(XY.get(p).lat - k0.lat, XY.get(p).lon - k0.lon);
  const byPoint = new Map();
  P.orders.forEach((o, i) => { if (!byPoint.has(o.point)) byPoint.set(o.point, []); byPoint.get(o.point).push(i); });
  const groups = [...byPoint].map(([p, m]) => ({
    p, m, a: angle(p), kg: m.reduce((s, o) => s + P.orders[o].weightKg, 0), pc: m.reduce((s, o) => s + (P.orders[o].parcels ?? 1), 0),
    types: P.vehicles.map(v => m.every(o => P.orders[o].vehicleTypes.includes(v.type))),
  }));
  // Bắt đầu quét ở khe góc rộng nhất để không cắt đôi một cụm điểm
  groups.sort((x, y) => x.a - y.a);
  let gap = -1, at = 0;
  groups.forEach((g, i) => { const nx = groups[(i + 1) % groups.length]; const d = ((nx.a - g.a) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI; if (d > gap) { gap = d; at = (i + 1) % groups.length; } });
  const order = groups.slice(at).concat(groups.slice(0, at));
  const V = P.vehicles.length, load = Array(V).fill(0), parcels = Array(V).fill(0), stops = Array(V).fill(0), mem = Array.from({ length: V }, () => []);
  const fits = (v, g) => g.types[v] && load[v] + g.kg <= P.vehicles[v].capacityKg && parcels[v] + g.pc <= (P.vehicles[v].capacityParcels ?? Infinity);
  const put = (v, g) => { load[v] += g.kg; parcels[v] += g.pc; stops[v]++; mem[v].push(g); };
  // Điểm chỉ xe tải chở được giao cho xe tải trước, phần còn lại chia vùng
  const rest = [];
  for (const g of order) {
    const only = g.types.map((ok, v) => ok ? v : -1).filter(v => v >= 0);
    if (only.length === 1 && fits(only[0], g)) put(only[0], g); else rest.push(g);
  }
  const target = Math.ceil(groups.length / V);
  let v = 0, unassigned = 0;
  for (const g of rest) {
    while (v < V - 1 && stops[v] >= target) v++;
    let u = [v, ...Array.from({ length: V }, (_, i) => i).filter(i => i !== v)].find(i => fits(i, g));
    if (u == null) { unassigned += g.m.length; continue; }
    put(u, g);
  }
  // Thứ tự trong từng xe: đi điểm gần nhất (theo thời gian chạy lúc rời điểm)
  const routes = mem.map((gs, w) => {
    const prof = P.vehicles[w].profile, left = gs.slice(), r = [];
    let at = 'KHO', clock = H;
    while (left.length) {
      let best = 0, bt = Infinity;
      left.forEach((g, i) => { const t = P.travelAt(prof, at, g.p, clock); if (t != null && t < bt) { bt = t; best = i; } });
      const g = left.splice(best, 1)[0];
      clock += bt + P.stopSeconds + g.m.length * P.serviceSeconds;
      r.push(...g.m); at = g.p;
    }
    return r;
  });
  return { routes, unassigned };
}

const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const stat = xs => ({ mean: mean(xs), min: Math.min(...xs), median: q(xs, 0.5), max: Math.max(...xs) });
const phut = s => s / 60;
const t0 = performance.now();
const out = { chay_luc: new Date().toISOString(), so_bo: SO_BO, ils_cap: ILS_CAP };

// a) Sweep + Nearest Neighbor so với engine (không khung giờ)
const sweepRows = [];
for (const [d, nhan] of NGAY) for (let seed = 1; seed <= SO_BO; seed++) {
  const P = problem(ordersOf(seed), TRUTH[d]);
  const e = planned(P), s = sweepNN(P);
  sweepRows.push({ ngay: d, seed, engine: score(P, e.routes, e.unassigned), sweep: score(P, s.routes, s.unassigned) });
}
out.sweep = NGAY.map(([d, nhan]) => {
  const R = sweepRows.filter(r => r.ngay === d);
  const ok = R.filter(r => !r.sweep.unassigned && !r.sweep.lateShift);
  return {
    ngay: d, nhan, bo: R.length,
    sweepChuaXep: R.filter(r => r.sweep.unassigned).length, sweepVeSauCa: R.filter(r => r.sweep.lateShift).length,
    engineChuaXep: R.filter(r => r.engine.unassigned).length, engineVeSauCa: R.filter(r => r.engine.lateShift).length,
    honPhut: stat(R.map(r => phut(r.sweep.finish - r.engine.finish))), engineTotHon: R.filter(r => r.sweep.finish - r.engine.finish > 60 || r.sweep.unassigned > r.engine.unassigned).length,
    sweepHopLe: ok.length,
  };
});
console.log('a) Sweep + NN:', JSON.stringify(out.sweep));

// b) Có khung giờ (ràng buộc cứng): engine, so với không khung giờ và với ILS
const winRows = [];
for (const [d, nhan] of NGAY) for (let seed = 1; seed <= SO_BO; seed++) {
  const orders = ordersOf(seed);
  const P = problem(orders, TRUTH[d], { windows: true }), P0 = problem(orders, TRUTH[d]);
  const e = planned(P), e0 = planned(P0);
  const { Q, expand, expandUnassigned } = groupedProblem(P);
  const x = ils(Q, { maxEvaluations: ILS_CAP, seed });
  const xs = score(P, expand(x.best.routes), expandUnassigned(x.best.unassigned).length);
  winRows.push({ ngay: d, seed, windowed: P.orders.filter(o => o.notAfterSeconds != null).length, engine: score(P, e.routes, e.unassigned), noWin: score(P0, e0.routes, e0.unassigned), ils: xs, ms: e.ms });
  process.stdout.write(`  b) ${nhan} bộ ${seed}/${SO_BO}\r`);
}
out.windows = NGAY.map(([d, nhan]) => {
  const R = winRows.filter(r => r.ngay === d);
  const same = R.filter(r => r.ils.unassigned === r.engine.unassigned);
  return {
    ngay: d, nhan, bo: R.length, donCoKhung: stat(R.map(r => r.windowed)),
    engineChuaXep: R.filter(r => r.engine.unassigned).length, donChuaXep: R.reduce((s, r) => s + r.engine.unassigned, 0),
    ilsChuaXep: R.reduce((s, r) => s + r.ils.unassigned, 0), treKhung: R.reduce((s, r) => s + r.engine.lateWin, 0),
    muonHonKhongKhungPhut: stat(R.map(r => phut(r.engine.finish - r.noWin.finish))),
    cachIlsPhut: stat(same.map(r => phut(r.engine.finish - r.ils.finish))), cachIlsPhanTram: stat(same.map(r => 100 * (r.engine.finish - r.ils.finish) / (r.ils.finish - H))),
    soSanhIls: same.length, engineMs: stat(R.map(r => r.ms)),
  };
});
console.log('\nb) Khung giờ:', JSON.stringify(out.windows));

// c) Ngoài mẫu
const oosRows = [];
const [MON] = NGAY[0];
const S16 = d => { const s = slotsOf(d, ['16:00'])[0]; return (p, a, b) => s.travel(p, a, b); };
for (let seed = 1; seed <= SO_BO; seed++) {
  const orders = ordersOf(seed);
  const tdMon = planned(problem(orders, TRUTH[MON]));
  const stMon = planned(problem(orders, S16(MON)));
  for (const [d] of NGAY) {
    const P = problem(orders, TRUTH[d]);
    const own = planned(P);
    const two = planned(problem(orders, TWO[d]));
    oosRows.push({
      ngay: d, seed,
      own: score(P, own.routes, own.unassigned), tdMon: score(P, tdMon.routes, tdMon.unassigned),
      stMon: score(P, stMon.routes, stMon.unassigned), two: score(P, two.routes, two.unassigned),
    });
  }
}
out.outOfSample = NGAY.map(([d, nhan]) => {
  const R = oosRows.filter(r => r.ngay === d);
  return {
    ngay: d, nhan, bo: R.length,
    phuThuocGioHonCoDinhPhut: stat(R.map(r => phut(r.stMon.finish - r.tdMon.finish))), boPhuThuocGioTotHon: R.filter(r => r.stMon.finish - r.tdMon.finish > 1).length,
    boCoDinhTotHon: R.filter(r => r.tdMon.finish - r.stMon.finish > 1).length,
    thuaSoVoiDungNgayPhut: stat(R.map(r => phut(r.tdMon.finish - r.own.finish))),
    haiMocThuaBonMocPhut: stat(R.map(r => phut(r.two.finish - r.own.finish))),
    veSauCa: { tdMon: R.filter(r => r.tdMon.lateShift).length, stMon: R.filter(r => r.stMon.lateShift).length, two: R.filter(r => r.two.lateShift).length },
  };
});
console.log('c) Ngoài mẫu:', JSON.stringify(out.outOfSample));

// d) Độ nhạy (Thứ Hai, 30 bộ)
out.sensitivity = [];
for (const stop of [60, 90, 180]) for (const moto of [0.7, 0.85, 1]) {
  const R = [];
  for (let seed = 1; seed <= SO_BO; seed++) {
    const orders = ordersOf(seed);
    const P = problem(orders, TRUTH[MON], { stop, moto });
    const e = planned(P), g = planned(P, { insertion: 'greedy' }), tot = planned(problem(orders, TRUTH[MON], { stop, moto, objective: 'total' }));
    const sw = sweepNN(P);
    R.push({ engine: score(P, e.routes, e.unassigned), greedy: score(P, g.routes, g.unassigned), total: score(P, tot.routes, tot.unassigned), sweep: score(P, sw.routes, sw.unassigned) });
  }
  out.sensitivity.push({
    stop, moto,
    engineVePhut: stat(R.map(r => phut(r.engine.finish - H))), engineChuaXep: R.reduce((s, r) => s + r.engine.unassigned, 0),
    greedyChuaXep: R.reduce((s, r) => s + r.greedy.unassigned, 0), sweepChuaXep: R.reduce((s, r) => s + r.sweep.unassigned, 0),
    honGreedyPhut: mean(R.filter(r => r.greedy.unassigned === r.engine.unassigned).map(r => phut(r.greedy.finish - r.engine.finish))),
    honTongPhut: mean(R.filter(r => r.total.unassigned === r.engine.unassigned).map(r => phut(r.total.finish - r.engine.finish))),
    honSweepPhut: mean(R.filter(r => r.sweep.unassigned === r.engine.unassigned).map(r => phut(r.sweep.finish - r.engine.finish))),
    engineVeSauCa: R.filter(r => r.engine.lateShift).length,
  });
}
console.log('d) Độ nhạy:'); for (const s of out.sensitivity) console.log(JSON.stringify(s));
out.ms = performance.now() - t0;
out.rows = { sweep: sweepRows, windows: winRows, outOfSample: oosRows };
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`xong trong ${(out.ms / 1000).toFixed(0)} s`);
