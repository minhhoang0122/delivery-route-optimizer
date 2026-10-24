// Thí nghiệm cho Chương 4 (mục 4.4) trên hai ma trận TomTom đã ghi lúc 16:00 và 17:30 Thứ Hai 12/10/2026:
// 20 đơn ở Đà Nẵng, Kho Hải Châu, 5 xe (3 xe máy, 2 xe tải nhỏ). Chạy lại được, không gọi TomTom:
//   node experiments/chuong4.js            in bảng kết quả
//   node experiments/chuong4.js --json     ghi thêm experiments/ket_qua.json
// Mục thời gian phụ thuộc giờ dùng thêm ma_tran_1630.json và ma_tran_1700.json (ghi bằng ghi_ma_tran.js).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  clockSeconds, evaluateReroute, fifoCheck, insertion, interpolateSlots, localSearch, plan, routeSchedule, routeSeconds, totalSeconds,
} from '../src/index.js';
import { metrics, solve, waitingCost } from './muc_tieu.js';

const read = name => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));
const scenario = read('kich_ban.json');
const MATRICES = { '16:00': read('ma_tran_1600.json'), '17:30': read('ma_tran_1730.json') };
const TYPE = { xe_may: 'motorcycle', xe_tai: 'small_truck' };
const out = {};

const minutes = s => (s / 60).toFixed(1).replace('.', ',');
const pct = r => `${(r * 100).toFixed(1).replace('.', ',')}%`;
function table(headers, rows) {
  console.log(`| ${headers.join(' | ')} |`);
  console.log(`|${headers.map(() => '---').join('|')}|`);
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
  console.log();
}

/** Bài toán theo kịch bản và một ma trận; travel trả null cho chặng không có dữ liệu. */
function problem(matrix, { maxRouteMinutes = null, orders = scenario.don, vehicles = scenario.xe, slow = null, serviceSeconds = 0 } = {}) {
  const index = new Map(matrix.diem.map((d, i) => [d.ma, i]));
  return {
    depot: 'KHO',
    travel: (profile, a, b) => {
      const t = matrix.thoi_gian[profile][index.get(a)][index.get(b)];
      return slow && t != null ? slow(profile, a, b, t) : t;
    },
    orders: orders.map(d => ({ id: scenario.don.indexOf(d) + 1, code: d.ma, point: d.ma, weightKg: d.khoi_luong_kg, vehicleTypes: d.loai_xe.map(t => TYPE[t]) })),
    vehicles: vehicles.map(x => ({ id: scenario.xe.indexOf(x) + 1, type: TYPE[x.loai], profile: x.cau_hinh, capacityKg: x.tai_trong_kg })),
    maxRouteSeconds: maxRouteMinutes ? maxRouteMinutes * 60 : null,
    serviceSeconds,
  };
}

// ---------------------------------------------------------------- 4.4.2 Insertion so với Insertion + Relocate/Swap
console.log('## 4.4.2 Insertion Heuristic so với Insertion Heuristic kết hợp Relocate và Swap\n');
out.e1 = [];
for (const [label, m] of Object.entries(MATRICES)) {
  for (const cap of [null, 60, 45]) {
    const P = problem(m, { maxRouteMinutes: cap });
    const t0 = performance.now();
    const a = insertion(P);
    const t1 = performance.now();
    const b = localSearch(P, a);
    const t2 = performance.now();
    const Ta = totalSeconds(P, a.routes);
    const Tb = totalSeconds(P, b.routes);
    const used = b.routes.filter(r => r.length).length;
    const longest = Math.max(...b.routes.map((r, v) => (r.length ? routeSeconds(P, v, r) : 0)));
    out.e1.push({ matrix: label, cap, insertion: Ta, improved: Tb, evaluations: b.stats.evaluations, moves: b.stats.moves, vehicles: used, longest, unassigned: a.unassigned.length, insertionMs: t1 - t0, searchMs: t2 - t1 });
  }
}
table(['Ma trận', 'Giới hạn chuyến', 'Insertion (phút)', 'Sau Relocate/Swap (phút)', 'Giảm', 'Số xe', 'Chuyến dài nhất (phút)', 'Chưa xếp', 'Phép đánh giá', 'Thời gian tính (ms)'],
  out.e1.map(r => [r.matrix, r.cap ? `${r.cap} phút` : 'không', minutes(r.insertion), minutes(r.improved), pct((r.insertion - r.improved) / r.insertion),
    r.vehicles, minutes(r.longest), r.unassigned, r.evaluations, (r.insertionMs + r.searchMs).toFixed(1).replace(".", ",")]));

// ---------------------------------------------------------------- 4.4.3 Giữ nguyên hay điều chỉnh khi giao thông thay đổi
// Lập kế hoạch trên ma trận 16:00 (giới hạn 60 phút). Với mỗi chuyến và mỗi thời điểm xe vừa giao xong điểm k,
// đánh giá phần còn lại trên ma trận 17:30 (giao thông thật lúc sau) và trên ma trận có một sự cố giả định.
console.log('## 4.4.3 Giữ nguyên và điều chỉnh thứ tự khi giao thông thay đổi\n');
const P16 = problem(MATRICES['16:00'], { maxRouteMinutes: 60 });
const base = plan(P16);
const code = id => scenario.don[id - 1].ma;
const cases = [];
for (const r of base.routes) {
  const v = scenario.xe[r.vehicleId - 1];
  for (let k = 1; k + 3 <= r.orderIds.length; k++) {
    const stops = r.orderIds.slice(k).map(id => ({ id, point: code(id) }));
    cases.push({ vehicle: r.vehicleId, profile: v.cau_hinh, start: code(r.orderIds[k - 1]), stops });
  }
}
const SCENARIOS = {
  'Ma trận 17:30 (giao thông thật)': problem(MATRICES['17:30']).travel,
  // Sự cố giả định: chặng từ điểm kế tiếp tới điểm sau nó chậm 3 lần (như công cụ mô phỏng của Backend)
  'Sự cố giả định ×3': null,
};
out.e2 = [];
for (const [name, travel] of Object.entries(SCENARIOS)) {
  const results = cases.map(c => {
    const t = travel ?? problem(MATRICES['17:30'], {
      slow: (p, a, b, sec) => (a === c.stops[0].point && b === c.stops[1].point ? sec * 3 : sec),
    }).travel;
    return { ...evaluateReroute({ depot: 'KHO', travel: t, profile: c.profile, start: c.start, stops: c.stops }), vehicle: c.vehicle, remaining: c.stops.length };
  });
  const accepted = results.filter(x => x.meetsThreshold);
  const improved = results.filter(x => x.savingSeconds > 0);
  out.e2.push({ name, cases: results.length, improved: improved.length, accepted: accepted.length,
    avgSaving: accepted.length ? accepted.reduce((s, x) => s + x.savingSeconds, 0) / accepted.length : 0,
    maxSaving: Math.max(0, ...results.map(x => x.savingSeconds)), results });
}
table(['Kịch bản', 'Số lần đánh giá', 'Có thứ tự tốt hơn', 'Đạt ngưỡng max(60 s, 5%)', 'Tiết kiệm TB khi đạt (phút)', 'Tiết kiệm lớn nhất (phút)'],
  out.e2.map(e => [e.name, e.cases, e.improved, e.accepted, minutes(e.avgSaving), minutes(e.maxSaving)]));

// ---------------------------------------------------------------- 4.4.4 Tải trọng, loại xe và trường hợp không có tuyến
console.log('## 4.4.4 Kiểm tra tải trọng, loại xe và trường hợp không có tuyến\n');
function violations(P, result) {
  let capacity = 0, type = 0, duplicate = 0;
  const seen = new Set();
  for (const r of result.routes) {
    const v = P.vehicles.find(x => x.id === r.vehicleId);
    const load = r.orderIds.reduce((s, id) => s + P.orders.find(o => o.id === id).weightKg, 0);
    if (load > v.capacityKg + 1e-9) capacity++;
    for (const id of r.orderIds) {
      if (!P.orders.find(o => o.id === id).vehicleTypes.includes(v.type)) type++;
      if (seen.has(id)) duplicate++;
      seen.add(id);
    }
  }
  return { capacity, type, duplicate };
}
const checks = [
  ['20 đơn, 5 xe, không giới hạn', problem(MATRICES['16:00'])],
  ['20 đơn, 5 xe, giới hạn 60 phút', problem(MATRICES['16:00'], { maxRouteMinutes: 60 })],
  ['Chỉ 3 xe máy (đơn chỉ xe tải phải chưa xếp)', problem(MATRICES['16:00'], { vehicles: scenario.xe.filter(x => x.loai === 'xe_may') })],
  ['Xe máy 40 kg duy nhất', problem(MATRICES['16:00'], { vehicles: [scenario.xe[1]] })],
  ['Mất dữ liệu mọi chặng tới DH-1049', (() => {
    const P = problem(MATRICES['16:00']);
    const t = P.travel;
    P.travel = (p, a, b) => (a === 'DH-1049' || b === 'DH-1049' ? null : t(p, a, b));
    return P;
  })()],
];
out.e3 = checks.map(([name, P]) => {
  const r = plan(P);
  const reasons = {};
  for (const u of r.unassigned) reasons[u.reason] = (reasons[u.reason] ?? 0) + 1;
  return { name, placed: r.routes.reduce((s, x) => s + x.orderIds.length, 0), unassigned: r.unassigned.length, reasons, ...violations(P, r) };
});
table(['Kịch bản', 'Đã xếp', 'Chưa xếp', 'Lý do chưa xếp', 'Vượt tải', 'Sai loại xe', 'Trùng đơn'],
  out.e3.map(e => [e.name, e.placed, e.unassigned, Object.entries(e.reasons).map(([k, n]) => `${k} (${n})`).join('; ') || '—', e.capacity, e.type, e.duplicate]));

// ---------------------------------------------------------------- 4.4.5 Độ nhạy của ngưỡng điều chỉnh
console.log('## 4.4.5 Số lần đổi kế hoạch theo ngưỡng điều chỉnh\n');
const all = out.e2.flatMap(e => e.results.filter(x => x.valid));
const THRESHOLDS = [[0, 0], [30, 0.025], [60, 0.05], [120, 0.10], [180, 0.15]];
out.e4 = THRESHOLDS.map(([g, ratio]) => {
  const ok = all.filter(x => x.savingSeconds > 0 && x.savingSeconds >= Math.max(g, ratio * x.currentSeconds));
  return { g, ratio, accepted: ok.length, total: all.length, saving: ok.reduce((s, x) => s + x.savingSeconds, 0) };
});
table(['Ngưỡng', 'Số lần đổi tuyến', 'Trên tổng số lần đánh giá', 'Tổng thời gian tiết kiệm (phút)'],
  out.e4.map(e => [`max(${e.g} s, ${pct(e.ratio)})`, e.accepted, e.total, minutes(e.saving)]));

// ---------------------------------------------------------------- 4.4.6 Thời gian thuật toán và số yêu cầu TomTom
console.log('## 4.4.6 Thời gian thuật toán và số yêu cầu TomTom\n');
out.e5 = [];
for (const n of [5, 10, 15, 20]) {
  const orders = scenario.don.slice(0, n);
  const P = problem(MATRICES['16:00'], { orders, maxRouteMinutes: 60 });
  const runs = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const r = plan(P);
    runs.push({ ms: performance.now() - t0, evaluations: r.stats.evaluations });
  }
  runs.sort((a, b) => a.ms - b.ms);
  const N = n + 1;
  out.e5.push({ n, medianMs: runs[10].ms, evaluations: runs[0].evaluations, legs: 2 * N * (N - 1) });
}
table(['Số đơn', 'Thời gian tính, trung vị 20 lần (ms)', 'Phép đánh giá', 'Chặng cần lấy từ TomTom (2 cấu hình xe)', 'Thời gian lấy ước tính (giây, 0,2 s/chặng)'],
  out.e5.map(e => [e.n, e.medianMs.toFixed(1).replace(".", ","), e.evaluations, e.legs, Math.round(e.legs * 0.2)]));

// ---------------------------------------------------------------- 4.4.2 Ảnh hưởng của mục tiêu và giới hạn thời lượng
// Cùng Insertion, Relocate và Swap, chỉ khác hàm chi phí: tổng thời gian chạy (không giới hạn, giới hạn 60 phút)
// và tổng thời gian khách chờ. Hai dòng đầu dùng chính engine, dòng thứ ba dùng biến thể trong muc_tieu.js.
console.log('## 4.4.2 Ảnh hưởng của mục tiêu và giới hạn thời lượng chuyến\n');
out.e6 = [];
for (const [label, m] of Object.entries(MATRICES)) {
  for (const cap of [null, 60]) {
    const P = problem(m, { maxRouteMinutes: cap });
    const b = localSearch(P, insertion(P));
    out.e6.push({ matrix: label, objective: cap ? 'travel_cap' : 'travel', ...metrics(P, b.routes, b.unassigned) });
  }
  const P = problem(m);
  const w = solve(P, waitingCost);
  out.e6.push({ matrix: label, objective: 'waiting', ...metrics(P, w.routes, w.unassigned) });
}
const OBJ = { travel: 'Tổng thời gian di chuyển, không giới hạn', travel_cap: 'Tổng thời gian di chuyển, giới hạn 60 phút', waiting: 'Tổng thời gian khách chờ' };
table(['Ma trận', 'Mục tiêu', 'Số xe', 'Tổng thời gian di chuyển (phút)', 'Chuyến dài nhất (phút)', 'Khách chờ trung bình (phút)', 'Khách chờ lâu nhất (phút)', 'Chưa xếp'],
  out.e6.map(e => [e.matrix, OBJ[e.objective], e.vehicles, minutes(e.total), minutes(e.longest), minutes(e.waitAvg), minutes(e.waitMax), e.unassigned]));

// ---------------------------------------------------------------- Thời gian phụ thuộc giờ và thời gian phục vụ
// "Giao thông thật" là thời gian chặng theo giờ xe rời điểm, nội suy tuyến tính giữa các khung giờ đã ghi
// (sau khung cuối giữ nguyên giá trị khung cuối). Hai cách lập kế hoạch: một ma trận cố định lấy tại giờ xuất phát
// (cách hiện tại) và tính tiến theo giờ (travelAt). Cả hai kế hoạch được đánh giá lại trên cùng giao thông thật.
console.log('## Lập kế hoạch với thời gian di chuyển phụ thuộc giờ\n');
const SLOT_FILES = { '16:00': 'ma_tran_1600.json', '16:30': 'ma_tran_1630.json', '17:00': 'ma_tran_1700.json', '17:30': 'ma_tran_1730.json' };
const SLOTS = Object.entries(SLOT_FILES)
  .filter(([, f]) => existsSync(new URL(`../test/fixtures/${f}`, import.meta.url)))
  .map(([label, f]) => { const m = read(f); return { label, seconds: clockSeconds(label), departAt: m.departAt, travel: problem(m).travel }; });
if (SLOTS.length < 4) console.log(`Thiếu ma trận khung giờ trung gian, chỉ nội suy giữa ${SLOTS.map(x => x.label).join(' và ')}.\n`);
const truth = interpolateSlots(SLOTS);
const fifo = fifoCheck(SLOTS, Object.keys(MATRICES['16:00'].thoi_gian), MATRICES['16:00'].diem.map(d => d.ma));
const SERVICE = 180;

/** Đánh giá các tuyến của một kế hoạch: giờ dự kiến theo cách lập (P) so với giờ trên giao thông thật (Ptruth). */
function againstTruth(P, Ptruth, routes, unassigned) {
  let predicted = 0, actual = 0, longest = 0, over = 0, used = 0;
  const errors = [];
  routes.forEach((r, v) => {
    if (!r.length) return;
    const a = routeSchedule(P, v, r);
    const b = routeSchedule(Ptruth, v, r);
    used++;
    predicted += a.seconds;
    actual += b.seconds;
    longest = Math.max(longest, b.seconds);
    if (b.seconds > 3600) over++;
    b.arrivals.forEach((t, k) => errors.push(Math.abs(t - a.arrivals[k])));
  });
  return {
    vehicles: used, unassigned: unassigned.length, predicted, actual, longest, over60: over, stops: errors.length,
    etaMeanSeconds: errors.length ? errors.reduce((s, x) => s + x, 0) / errors.length : 0, etaMaxSeconds: Math.max(0, ...errors),
  };
}

out.td = {
  slots: SLOTS.map(x => ({ label: x.label, departAt: x.departAt })), serviceSeconds: SERVICE,
  fifo: { checked: fifo.checked, violations: fifo.violations.length, marginSeconds: fifo.margin }, rows: [],
};
for (const dep of ['16:00', '16:45']) {
  const t0 = clockSeconds(dep);
  for (const cap of [60, null]) {
    const opts = { maxRouteMinutes: cap, serviceSeconds: SERVICE };
    const Ptruth = { ...problem(MATRICES['16:00'], opts), travelAt: truth, startSeconds: t0 };
    const Pstatic = { ...problem(MATRICES['16:00'], opts), travel: (p, a, b) => truth(p, a, b, t0), startSeconds: t0 };
    for (const [method, P] of [['static', Pstatic], ['time_dependent', Ptruth]]) {
      const r = localSearch(P, insertion(P));
      out.td.rows.push({ departure: dep, cap, method, ...againstTruth(P, Ptruth, r.routes, r.unassigned) });
    }
  }
}
const METHOD = { static: 'Ma trận cố định lúc xuất phát', time_dependent: 'Phụ thuộc giờ' };
console.log(`Khung giờ: ${SLOTS.map(x => x.label).join(', ')}; phục vụ ${SERVICE / 60} phút mỗi điểm; FIFO: ${fifo.violations.length} vi phạm trên ${fifo.checked} cặp chặng và khung (phần dư nhỏ nhất ${Math.round(fifo.margin)} giây).\n`);
table(['Xuất phát', 'Giới hạn chuyến', 'Cách lập', 'Số xe', 'Chưa xếp', 'Tổng thời lượng dự kiến (phút)', 'Tổng thời lượng thực (phút)', 'Chuyến dài nhất thực (phút)', 'Chuyến thực vượt 60 phút', 'Lệch giờ đến TB (phút)', 'Lệch giờ đến lớn nhất (phút)'],
  out.td.rows.map(e => [e.departure, e.cap ? `${e.cap} phút` : 'không', METHOD[e.method], e.vehicles, e.unassigned, minutes(e.predicted), minutes(e.actual), minutes(e.longest),
    e.cap ? e.over60 : '—', minutes(e.etaMeanSeconds), minutes(e.etaMaxSeconds)]));

// Bảng 4.4 và 4.5 khi thêm 3 phút phục vụ mỗi điểm (tham khảo; ma trận cố định như hai bảng gốc)
console.log('## Bảng 4.4 và 4.5 khi có thời gian phục vụ 3 phút mỗi điểm\n');
out.service3 = { serviceSeconds: SERVICE, e1: [], e6: [] };
for (const [label, m] of Object.entries(MATRICES)) {
  for (const cap of [null, 60, 45]) {
    const P = problem(m, { maxRouteMinutes: cap, serviceSeconds: SERVICE });
    const a = insertion(P);
    const b = localSearch(P, a);
    out.service3.e1.push({
      matrix: label, cap, insertion: totalSeconds(P, a.routes), improved: totalSeconds(P, b.routes), evaluations: b.stats.evaluations, moves: b.stats.moves,
      vehicles: b.routes.filter(r => r.length).length, longest: Math.max(...b.routes.map((r, v) => (r.length ? routeSeconds(P, v, r) : 0))), unassigned: a.unassigned.length,
    });
  }
}
table(['Ma trận', 'Giới hạn chuyến', 'Insertion (phút)', 'Sau Relocate/Swap (phút)', 'Giảm', 'Số xe', 'Chuyến dài nhất (phút)', 'Chưa xếp', 'Phép đánh giá'],
  out.service3.e1.map(r => [r.matrix, r.cap ? `${r.cap} phút` : 'không', minutes(r.insertion), minutes(r.improved), pct((r.insertion - r.improved) / r.insertion),
    r.vehicles, minutes(r.longest), r.unassigned, r.evaluations]));
for (const [label, m] of Object.entries(MATRICES)) {
  for (const cap of [null, 60]) {
    const P = problem(m, { maxRouteMinutes: cap, serviceSeconds: SERVICE });
    const b = localSearch(P, insertion(P));
    out.service3.e6.push({ matrix: label, objective: cap ? 'travel_cap' : 'travel', ...metrics(P, b.routes, b.unassigned) });
  }
  const P = problem(m, { serviceSeconds: SERVICE });
  const w = solve(P, waitingCost);
  out.service3.e6.push({ matrix: label, objective: 'waiting', ...metrics(P, w.routes, w.unassigned) });
}
table(['Ma trận', 'Mục tiêu', 'Số xe', 'Tổng thời lượng (phút)', 'Chuyến dài nhất (phút)', 'Khách chờ trung bình (phút)', 'Khách chờ lâu nhất (phút)', 'Chưa xếp'],
  out.service3.e6.map(e => [e.matrix, OBJ[e.objective], e.vehicles, minutes(e.total), minutes(e.longest), minutes(e.waitAvg), minutes(e.waitMax), e.unassigned]));

if (process.argv.includes('--json')) {
  writeFileSync(new URL('./ket_qua.json', import.meta.url), JSON.stringify(out, null, 2));
  console.log('Đã ghi experiments/ket_qua.json');
}
