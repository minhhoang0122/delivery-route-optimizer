// Thí nghiệm lặp (08/11): nhiều bộ 60 đơn ngẫu nhiên trên 30 điểm của kịch bản 60 đơn, trên giao thông của nhiều ngày.
// Mỗi bộ giữ nguyên 60 đơn (khối lượng, số kiện, loại xe) nhưng gán lại điểm giao ngẫu nhiên theo hạt giống,
// nên chạy lại cho cùng kết quả. Không gọi TomTom: dùng ma trận đã ghi (ma_tran_60_HHMM.json là Thứ Hai 26/10,
// ma_tran_60_YYYYMMDD_HHMM.json là các ngày ghi thêm).
//   node experiments/nhieu_bo_don.js [--bo 30] [--ils 300000] [--out experiments/ket_qua_nhieu_bo.json]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { clockSeconds, groupedProblem, insertion, interpolateSlots, plan, routeSchedule } from '../src/index.js';
import { ils, rng, simulate } from './mo_phong.js';

const args = process.argv.slice(2);
const lay = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SO_BO = Number(lay('--bo', 30));
const ILS_CAP = Number(lay('--ils', 300000));
const OUT = lay('--out', new URL('./ket_qua_nhieu_bo.json', import.meta.url));

const fx = name => new URL(`../test/fixtures/${name}`, import.meta.url);
const read = name => JSON.parse(readFileSync(fx(name), 'utf8'));
const kb = read('kich_ban_60.json');
const TYPE = { xe_may: 'motorcycle', xe_tai: 'small_truck' };
const GIO = ['16:00', '16:30', '17:00', '17:30'];
const NGAY = [['20261026', 'Thứ Hai 26/10'], ['20261112', 'Thứ Năm 12/11'], ['20261114', 'Thứ Bảy 14/11']]
  .filter(([d]) => GIO.every(g => existsSync(fx(d === '20261026' ? `ma_tran_60_${g.replace(':', '')}.json` : `ma_tran_60_${d}_${g.replace(':', '')}.json`))));

function slotsOf(d) {
  return GIO.map(label => {
    const m = read(d === '20261026' ? `ma_tran_60_${label.replace(':', '')}.json` : `ma_tran_60_${d}_${label.replace(':', '')}.json`);
    const index = new Map(m.diem.map((p, i) => [p.ma, i]));
    return { label, seconds: clockSeconds(label), travel: (p, a, b) => m.thoi_gian[p][index.get(a)][index.get(b)] };
  });
}
const H = clockSeconds(kb.ca.bat_dau), END = clockSeconds(kb.ca.ket_thuc);
const vehicles = kb.xe.map((x, i) => ({ id: i + 1, type: TYPE[x.loai], profile: x.cau_hinh, capacityKg: x.tai_trong_kg, capacityParcels: x.so_kien_toi_da }));

function problem(orders, truth, travel = null) {
  return {
    depot: 'KHO', objective: 'makespan',
    travel: travel ?? ((p, a, b) => truth(p, a, b, H)), travelAt: travel ? null : truth,
    startSeconds: H, shiftEndSeconds: END, stopSeconds: kb.phuc_vu.moi_diem_giay, serviceSeconds: kb.phuc_vu.moi_don_giay,
    orders: orders.map((d, i) => ({ id: i + 1, code: d.ma, point: d.diem, weightKg: d.khoi_luong_kg, parcels: d.so_kien, vehicleTypes: d.loai_xe.map(t => TYPE[t]) })),
    vehicles,
  };
}
function planned(P, options = {}) {
  const t0 = performance.now();
  const r = plan(P, options);
  const index = new Map(P.orders.map((o, i) => [o.id, i]));
  return { routes: r.routes.map(x => x.orderIds.map(id => index.get(id))), unassigned: r.unassigned, evaluations: r.stats.evaluations, ms: performance.now() - t0 };
}
/** Chỉ số trên giao thông thật (TRUTH) của một kế hoạch lập bằng Pplan. */
function onTruth(TRUTH, Pplan, routes, unassigned = []) {
  let finish = H, used = 0, late = 0, errSum = 0, errMax = 0, n = 0;
  routes.forEach((r, v) => {
    if (!r.length) return;
    const a = routeSchedule(Pplan, v, r), b = routeSchedule(TRUTH, v, r);
    used++; finish = Math.max(finish, b.end); if (b.end > END + 1e-9) late++;
    b.arrivals.forEach((t, k) => { const e = Math.abs(t - a.arrivals[k]); errSum += e; errMax = Math.max(errMax, e); n++; });
  });
  return { finish, vehicles: used, late, unassigned: unassigned.length, etaMean: n ? errSum / n : 0, etaMax: errMax };
}

const BIG = { maxEvaluations: 5_000_000, maxMs: 600_000 };
const rows = [];
const t0 = performance.now();
for (const [d, nhan] of NGAY) {
  const truth = interpolateSlots(slotsOf(d));
  const S16 = slotsOf(d)[0];
  for (let seed = 1; seed <= SO_BO; seed++) {
    const rand = rng(seed * 7919);
    const orders = kb.don.map(o => ({ ...o, diem: kb.diem[Math.floor(rand() * kb.diem.length)].ma }));
    const TRUTH = problem(orders, truth);
    const row = { ngay: d, nhan, seed, points: new Set(orders.map(o => o.diem)).size };
    // Insertion Regret-2 riêng (trên bài toán đã gom đơn cùng điểm, như engine)
    const { Q, expand, expandUnassigned } = groupedProblem(TRUTH);
    let t = performance.now();
    const a = insertion(Q, { rule: 'regret2' });
    row.insertion = { ...onTruth(TRUTH, TRUTH, expand(a.routes), expandUnassigned(a.unassigned)), ms: performance.now() - t };
    const g = insertion(Q, { rule: 'greedy' });
    row.greedy = onTruth(TRUTH, TRUTH, expand(g.routes), expandUnassigned(g.unassigned));
    // Engine mặc định: Regret-2 + Relocate/Swap, giới hạn 100.000 phép / 2 s
    const e = planned(TRUTH);
    row.engine = { ...onTruth(TRUTH, TRUTH, e.routes, e.unassigned), evaluations: e.evaluations, ms: e.ms };
    // Tham chiếu: Iterated Local Search, giới hạn ILS_CAP phép đánh giá
    const x = ils(Q, { maxEvaluations: ILS_CAP, seed });
    row.ils = { ...onTruth(TRUTH, TRUTH, expand(x.best.routes), expandUnassigned(x.best.unassigned)), ms: x.ms };
    // Lập bằng ma trận cố định 16:00, đánh giá trên giao thông thật
    const Ps = problem(orders, truth, (p, a2, b) => S16.travel(p, a2, b));
    const s = planned(Ps, BIG);
    row.static = onTruth(TRUTH, Ps, s.routes, s.unassigned);
    // Đổi tuyến khi đang giao trên giao thông thật (kế hoạch phụ thuộc giờ, đánh giá phụ thuộc giờ)
    const sim = simulate(TRUTH, truth, e.routes, { reroute: 'td' });
    const ok = sim.events.filter(v => v.meets);
    row.reroute = { evaluations: sim.events.length, accepted: ok.length, saving: ok.reduce((z, v) => z + v.realSaving, 0) };
    rows.push(row);
    process.stdout.write(`  ${nhan} bộ ${seed}/${SO_BO}\r`);
  }
}
const ms = performance.now() - t0;

// Tổng hợp
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const stat = xs => ({ mean: mean(xs), min: Math.min(...xs), median: q(xs, 0.5), max: Math.max(...xs) });
const summary = NGAY.map(([d, nhan]) => {
  const R = rows.filter(r => r.ngay === d);
  const gain = R.map(r => (r.insertion.finish - r.engine.finish) / 60);
  const gap = R.map(r => (r.engine.finish - r.ils.finish) / 60);
  return {
    ngay: d, nhan, bo: R.length,
    chuaXep: { insertion: R.filter(r => r.insertion.unassigned).length, greedy: R.filter(r => r.greedy.unassigned).length, engine: R.filter(r => r.engine.unassigned).length },
    veMuon: { engine: R.filter(r => r.engine.late).length, static: R.filter(r => r.static.late).length },
    lsGiamPhut: stat(gain), lsCoCaiThien: R.filter(r => r.insertion.finish - r.engine.finish > 1).length,
    cachIlsPhut: stat(gap), ilsTotHon: R.filter(r => r.engine.finish - r.ils.finish > 1).length,
    engineMs: stat(R.map(r => r.engine.ms)),
    lechStaticPhut: stat(R.map(r => r.static.etaMean / 60)), lechStaticMaxPhut: stat(R.map(r => r.static.etaMax / 60)),
    doiTuyen: { danhGia: R.reduce((s, r) => s + r.reroute.evaluations, 0), dat: R.reduce((s, r) => s + r.reroute.accepted, 0), boCoDoi: R.filter(r => r.reroute.accepted).length },
  };
});
writeFileSync(OUT, JSON.stringify({ chay_luc: new Date().toISOString(), so_bo: SO_BO, ils_cap: ILS_CAP, ms, summary, rows }, null, 1));
console.log(`\n${rows.length} lượt trong ${(ms / 1000).toFixed(0)} s`);
for (const s of summary) console.log(JSON.stringify(s));
