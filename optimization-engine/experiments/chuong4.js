// Thí nghiệm cho Chương 4 (mục 4.4). Phần đầu: hai ma trận TomTom đã ghi lúc 16:00 và 17:30 Thứ Hai 12/10/2026,
// 20 đơn ở Đà Nẵng, Kho Hải Châu, 5 xe (3 xe máy, 2 xe tải nhỏ), mục tiêu tổng thời gian như bản đã báo cáo.
// Phần sau (out.k60): kịch bản 60 đơn trên 30 điểm, 4 tài xế, ca 16:00–18:00, mục tiêu makespan, thời gian phụ thuộc giờ
// từ 4 ma trận ghi lúc 16:00–17:30 Thứ Hai 26/10/2026 (ma_tran_60_*.json). Chạy lại được, không gọi TomTom:
//   node experiments/chuong4.js            in bảng kết quả
//   node experiments/chuong4.js --json     ghi thêm experiments/ket_qua.json
// Mục thời gian phụ thuộc giờ dùng thêm ma_tran_1630.json và ma_tran_1700.json (ghi bằng ghi_ma_tran.js).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  clockSeconds, evaluateReroute, fifoCheck, insertion, interpolateSlots, localSearch, plan, routeSchedule, routeSeconds, totalSeconds,
} from '../src/index.js';
import { metrics, solve, waitingCost } from './muc_tieu.js';
import { ils, simulate } from './mo_phong.js';

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
    objective: 'total',   // các bảng của kịch bản 20 đơn giữ mục tiêu tổng thời gian như bản đã báo cáo
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

// ================================================================ Kịch bản 60 đơn, 30 điểm, 4 tài xế, ca 16:00–18:00
// Giao thông thật: thời gian chặng phụ thuộc giờ, nội suy giữa 4 ma trận TomTom ghi lúc 16:00, 16:30, 17:00, 17:30
// (Thứ Hai 26/10/2026); sau 17:30 giữ giá trị 17:30. Phục vụ: 90 giây mỗi lần dừng và 90 giây mỗi đơn.
// Mọi kế hoạch, dù lập bằng cách nào, đều được đánh giá lại trên cùng giao thông thật.
const kb60 = read('kich_ban_60.json');
const SLOTS60 = ['16:00', '16:30', '17:00', '17:30'].map(label => {
  const m = read(`ma_tran_60_${label.replace(':', '')}.json`);
  const index = new Map(m.diem.map((d, i) => [d.ma, i]));
  return { label, seconds: clockSeconds(label), departAt: m.departAt, errors: m.loi.length, travel: (p, a, b) => m.thoi_gian[p][index.get(a)][index.get(b)] };
});
const truth60 = interpolateSlots(SLOTS60);
const H60 = clockSeconds(kb60.ca.bat_dau);
const END60 = clockSeconds(kb60.ca.ket_thuc);
const PROFILES60 = [...new Set(kb60.xe.map(x => x.cau_hinh))];
const fifo60 = fifoCheck(SLOTS60, PROFILES60, [kb60.kho, ...kb60.diem].map(d => d.ma));
const BIG = { maxEvaluations: 5_000_000, maxMs: 600_000 };   // đủ lớn để Local Search tự dừng ở cực tiểu địa phương
const clock = s => { const m = Math.round(s / 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const ms1 = x => x.toFixed(1).replace('.', ',');

/** Bài toán 60 đơn. travel cho trước thì lập bằng một ma trận cố định, không thì phụ thuộc giờ (giao thông thật). */
function problem60({ orders = kb60.don, objective = 'makespan', travel = null, shift = true, vehicles = null } = {}) {
  return {
    depot: 'KHO', objective,
    travel: travel ?? ((p, a, b) => truth60(p, a, b, H60)),
    travelAt: travel ? null : truth60,
    startSeconds: H60,
    shiftEndSeconds: shift ? END60 : null,
    stopSeconds: kb60.phuc_vu.moi_diem_giay,
    serviceSeconds: kb60.phuc_vu.moi_don_giay,
    orders: orders.map(d => ({ id: kb60.don.indexOf(d) + 1, code: d.ma, point: d.diem, weightKg: d.khoi_luong_kg, parcels: d.so_kien, vehicleTypes: d.loai_xe.map(t => TYPE[t]) })),
    vehicles: vehicles ?? kb60.xe.map((x, i) => ({ id: i + 1, type: TYPE[x.loai], profile: x.cau_hinh, capacityKg: x.tai_trong_kg, capacityParcels: x.so_kien_toi_da })),
  };
}
const TRUTH = problem60();
/** Chạy plan() (Insertion, Local Search, chèn lại đơn chưa xếp) và đổi kết quả về chỉ số đơn trong P. */
function planned(P, options = {}) {
  const t0 = performance.now();
  const r = plan(P, options);
  const index = new Map(P.orders.map((o, i) => [o.id, i]));
  return {
    routes: r.routes.map(x => x.orderIds.map(id => index.get(id))),
    unassigned: r.unassigned, stats: r.stats, ms: performance.now() - t0,
  };
}

/** Chỉ số của một kế hoạch trên giao thông thật, so với giờ dự kiến của chính cách lập (Pplan). */
function onTruth(Pplan, routes, unassigned = []) {
  let finish = H60, predictedFinish = H60, travel = 0, duration = 0, used = 0, late = 0, waitSum = 0, waitMax = 0, served = 0;
  const errors = [];
  const loads = [];
  routes.forEach((r, v) => {
    if (!r.length) return;
    const a = routeSchedule(Pplan, v, r);
    const b = routeSchedule(TRUTH, v, r);
    used++;
    finish = Math.max(finish, b.end);
    predictedFinish = Math.max(predictedFinish, a.end);
    travel += b.travelSeconds;
    duration += b.seconds;
    if (b.end > END60 + 1e-9) late++;
    b.arrivals.forEach((t, k) => { errors.push(Math.abs(t - a.arrivals[k])); waitSum += t - H60; waitMax = Math.max(waitMax, t - H60); served++; });
    loads.push({ vehicle: Pplan.vehicles[v].id, kg: r.reduce((s, o) => s + Pplan.orders[o].weightKg, 0), parcels: r.reduce((s, o) => s + Pplan.orders[o].parcels, 0), orders: r.length, end: b.end });
  });
  return {
    vehicles: used, finish, predictedFinish, travel, duration, late, unassigned: unassigned.length,
    waitAvg: served ? waitSum / served : 0, waitMax,
    etaMean: errors.length ? errors.reduce((s, x) => s + x, 0) / errors.length : 0, etaMax: Math.max(0, ...errors), loads,
  };
}

const kg60 = kb60.don.reduce((s, d) => s + d.khoi_luong_kg, 0);
const truckOnly = kb60.don.filter(d => !d.loai_xe.includes('xe_may'));
const bikeKg = kb60.don.filter(d => d.loai_xe.includes('xe_may')).reduce((s, d) => s + d.khoi_luong_kg, 0);
const bikeParcels = kb60.don.filter(d => d.loai_xe.includes('xe_may')).reduce((s, d) => s + d.so_kien, 0);
const bikes = kb60.xe.filter(x => x.loai === 'xe_may');
out.k60 = {
  data: {
    points: kb60.diem.length, orders: kb60.don.length, kg: kg60, parcels: kb60.don.reduce((s, d) => s + d.so_kien, 0),
    truckOnly: truckOnly.map(d => ({ code: d.ma, kg: d.khoi_luong_kg, reason: d.ly_do_xe_tai })),
    bikeEligibleKg: bikeKg, bikeEligibleParcels: bikeParcels,
    bikeCapacityKg: bikes.reduce((s, x) => s + x.tai_trong_kg, 0), bikeCapacityParcels: bikes.reduce((s, x) => s + x.so_kien_toi_da, 0),
  },
  slots: SLOTS60.map(x => ({ label: x.label, departAt: x.departAt, errors: x.errors })),
  fifo: { checked: fifo60.checked, violations: fifo60.violations.length, marginSeconds: fifo60.margin },
};
console.log('## Kịch bản 60 đơn: 30 điểm giao, 3 xe máy và 1 xe tải nhỏ, ca 16:00–18:00\n');
console.log(`${kb60.diem.length} điểm, ${kb60.don.length} đơn, ${kg60.toFixed(1).replace('.', ',')} kg, ${out.k60.data.parcels} kiện; ${truckOnly.length} đơn chỉ đi xe tải (${truckOnly.map(d => `${d.khoi_luong_kg} kg`).join(', ')}).`);
console.log(`Đơn xe máy chở được: ${bikeKg.toFixed(1).replace('.', ',')} kg, ${bikeParcels} kiện; ba xe máy chở tối đa ${out.k60.data.bikeCapacityKg} kg, ${out.k60.data.bikeCapacityParcels} kiện.`);
console.log(`Khung giờ: ${SLOTS60.map(x => `${x.label} (${x.errors} chặng lỗi)`).join(', ')}; FIFO: ${fifo60.violations.length} vi phạm trên ${fifo60.checked} cặp chặng và khung (phần dư nhỏ nhất ${Math.round(fifo60.margin)} giây).\n`);

const time = f => { const t0 = performance.now(); const r = f(); return { r, ms: performance.now() - t0 }; };

// ---------------------------------------------------------------- a) So sánh mục tiêu
console.log('### a) Mục tiêu: tổng thời gian, giờ xe cuối về kho (makespan), tổng thời gian khách chờ\n');
out.k60.objectives = [];
for (const objective of ['total', 'makespan']) {
  const P = problem60({ objective });
  const r = planned(P, BIG);
  out.k60.objectives.push({ objective, ...onTruth(P, r.routes, r.unassigned), evaluations: r.stats.evaluations, ms: r.ms });
}
{
  const P = problem60();
  const { r, ms } = time(() => solve(P, waitingCost, { maxEvaluations: BIG.maxEvaluations }));
  out.k60.objectives.push({ objective: 'waiting', ...onTruth(P, r.routes, r.unassigned), evaluations: r.evaluations, ms });
}
const OBJ60 = { total: 'Tổng thời lượng các chuyến (cũ)', makespan: 'Giờ xe cuối về kho, rồi tổng thời lượng (mới)', waiting: 'Tổng thời gian khách chờ (tham khảo)' };
table(['Mục tiêu', 'Số xe dùng', 'Xe cuối về kho', 'Tổng thời gian chạy (phút)', 'Khách chờ TB (phút)', 'Khách chờ lâu nhất (phút)', 'Chưa xếp', 'Phép đánh giá', 'Thời gian tính (ms)'],
  out.k60.objectives.map(e => [OBJ60[e.objective], e.vehicles, clock(e.finish), minutes(e.travel), minutes(e.waitAvg), minutes(e.waitMax), e.unassigned, e.evaluations, ms1(e.ms)]));
const mk = out.k60.objectives.find(e => e.objective === 'makespan');
console.log('Tải từng xe với mục tiêu makespan:\n');
table(['Xe', 'Số đơn', 'Khối lượng (kg)', 'Số kiện', 'Về kho'],
  mk.loads.map(l => { const x = kb60.xe[l.vehicle - 1]; return [`${x.ma} (${x.loai === 'xe_may' ? 'xe máy' : 'xe tải'})`, l.orders, `${l.kg.toFixed(1).replace('.', ',')} / ${x.tai_trong_kg}`, `${l.parcels} / ${x.so_kien_toi_da}`, clock(l.end)]; }));

// Tải trọng có ràng buộc không: bỏ giới hạn tải của xe máy rồi so sánh
{
  const relaxed = problem60({ vehicles: problem60().vehicles.map(v => (v.type === 'motorcycle' ? { ...v, capacityKg: Infinity, capacityParcels: Infinity } : v)) });
  const r = planned(relaxed, BIG);
  out.k60.capacityRelaxed = { ...onTruth(relaxed, r.routes, r.unassigned), evaluations: r.stats.evaluations };
  const bikeLoads = out.k60.capacityRelaxed.loads.filter(l => l.vehicle <= 3);
  console.log(`Bỏ giới hạn tải của xe máy: xe cuối về ${clock(out.k60.capacityRelaxed.finish)} (có giới hạn: ${clock(mk.finish)}); ` +
    `tải xe máy ${bikeLoads.map(l => `${l.kg.toFixed(1).replace('.', ',')} kg/${l.parcels} kiện`).join(', ')}.\n`);
}

// ---------------------------------------------------------------- b) Insertion so với Insertion + Local Search (makespan)
console.log('### b) Insertion Heuristic so với Insertion Heuristic kết hợp Relocate và Swap (mục tiêu makespan)\n');
out.k60.insertionVsLs = [];
{
  const P = problem60();
  for (const rule of ['greedy', 'regret2']) {
    const { r: a, ms } = time(() => insertion(P, { rule }));
    out.k60.insertionVsLs.push({ method: `${rule}_only`, ...onTruth(P, a.routes, a.unassigned), positions: a.stats.positions, evaluations: 0, moves: 0, stopReason: '—', ms });
    for (const [lim, label] of [[{}, 'default'], [BIG, 'converged']]) {
      const r = planned(P, { insertion: rule, ...lim });
      out.k60.insertionVsLs.push({ method: `${rule}_${label}`, ...onTruth(P, r.routes, r.unassigned), evaluations: r.stats.evaluations, moves: r.stats.moves, stopReason: r.stats.stopReason, ms: r.ms });
    }
  }
}
const RULE = { greedy: 'Insertion theo khối lượng giảm dần', regret2: 'Insertion Regret-2 (mặc định)' };
const LIM = { only: 'chỉ Insertion', default: '+ Relocate/Swap, giới hạn mặc định 100.000 phép / 2 s', converged: '+ Relocate/Swap đến khi hết cải thiện' };
table(['Cách', 'Số xe', 'Chưa xếp', 'Xe cuối về kho', 'Tổng thời gian chạy (phút)', 'Khách chờ TB (phút)', 'Phép đánh giá', 'Bước cải thiện', 'Lý do dừng', 'Thời gian tính (ms)'],
  out.k60.insertionVsLs.map(e => { const [rule, lim] = e.method.split('_'); return [`${RULE[rule]}, ${LIM[lim]}`, e.vehicles, e.unassigned, clock(e.finish), minutes(e.travel), minutes(e.waitAvg), e.evaluations, e.moves, e.stopReason, ms1(e.ms)]; }));
// ---------------------------------------------------------------- c) Ma trận cố định so với phụ thuộc giờ
console.log('### c) Lập kế hoạch bằng một ma trận cố định so với phụ thuộc giờ, đánh giá trên giao thông thật\n');
out.k60.staticVsTd = [];
for (const [method, travel] of [
  ['static_1600', (p, a, b) => SLOTS60[0].travel(p, a, b)],
  ['static_1700', (p, a, b) => SLOTS60[2].travel(p, a, b)],
  ['time_dependent', null],
]) {
  const P = problem60({ travel });
  const r = planned(P, BIG);
  out.k60.staticVsTd.push({ method, ...onTruth(P, r.routes, r.unassigned), evaluations: r.stats.evaluations });
}
const MT = { static_1600: 'Ma trận cố định 16:00 (giờ xuất phát)', static_1700: 'Ma trận cố định 17:00 (cao điểm)', time_dependent: 'Phụ thuộc giờ (4 khung)' };
table(['Cách lập', 'Số xe', 'Chưa xếp', 'Xe cuối về kho (dự kiến)', 'Xe cuối về kho (thực)', 'Tổng thời gian chạy thực (phút)', 'Lệch giờ đến TB (phút)', 'Lệch giờ đến lớn nhất (phút)', 'Xe về sau 18:00 (thực)'],
  out.k60.staticVsTd.map(e => [MT[e.method], e.vehicles, e.unassigned, clock(e.predictedFinish), clock(e.finish), minutes(e.travel), minutes(e.etaMean), minutes(e.etaMax), e.late]));

// ---------------------------------------------------------------- d) Tham chiếu: tìm kiếm mạnh hơn và các biến thể
console.log('### d) Khoảng cách tới lời giải tốt hơn: biến thể và Iterated Local Search\n');
out.k60.reference = [];
{
  const P = problem60();
  const row = (method, sol, evaluations, ms, extra = {}) => out.k60.reference.push({ method, ...onTruth(P, sol.routes, sol.unassigned), evaluations, ms, ...extra });
  for (const [method, rule, moves] of [
    ['regret_rs', 'regret2', ['relocate', 'swap']],
    ['greedy_rs', 'greedy', ['relocate', 'swap']],
    ['regret_all', 'regret2', ['relocate', 'swap', 'oropt', '2opt']],
    ['greedy_all', 'greedy', ['relocate', 'swap', 'oropt', '2opt']],
  ]) {
    const r = planned(P, { ...BIG, insertion: rule, moves });
    row(method, r, r.stats.evaluations, r.ms);
  }
  const ILS_CAP = 3_000_000;
  for (const seed of [1, 2, 3]) {
    const x = ils(P, { maxEvaluations: ILS_CAP, seed });
    row(`ils_${seed}`, x.best, x.evaluations, x.ms, { cap: ILS_CAP, bestAt: x.bestAt, iterations: x.iterations, restarts: x.restarts });
  }
}
const MR = {
  regret_rs: 'Regret-2 + Relocate/Swap (engine mặc định)', greedy_rs: 'Insertion khối lượng + Relocate/Swap',
  regret_all: 'Regret-2 + Relocate/Swap/Or-opt/2-opt', greedy_all: 'Insertion khối lượng + Relocate/Swap/Or-opt/2-opt',
};
const base60 = out.k60.reference[0];
table(['Cách', 'Xe cuối về kho', 'Makespan (phút)', 'So với engine', 'Tổng thời gian chạy (phút)', 'Phép đánh giá thực dùng', 'Thời gian tính (ms)'],
  out.k60.reference.map(e => [
    MR[e.method] ?? `ILS hạt giống ${e.method.slice(4)} (giới hạn ${e.cap.toLocaleString('vi-VN')}, ${e.iterations} vòng, ${e.restarts} lần khởi động lại, tốt nhất sau ${e.bestAt.toLocaleString('vi-VN')} phép)`,
    clock(e.finish), minutes(e.finish - H60), pct((e.finish - base60.finish) / (base60.finish - H60)), minutes(e.travel), e.evaluations.toLocaleString('vi-VN'), ms1(e.ms)]));

// ---------------------------------------------------------------- e) Đổi tuyến khi đang giao
// Lập kế hoạch lúc 16:00, các xe chạy theo giao thông thật. Sau mỗi lần giao xong một điểm, nếu còn ít nhất 3 điểm,
// đánh giá đổi thứ tự phần còn lại bằng dữ liệu có tại thời điểm đó; đạt ngưỡng max(60 s, 5%) thì xe đổi thứ tự.
console.log('### e) Đổi thứ tự khi đang giao, mô phỏng theo thời gian trên giao thông thật\n');
out.k60.reroute = [];
{
  const Pstatic = problem60({ travel: (p, a, b) => SLOTS60[0].travel(p, a, b) });
  const Ptd = problem60();
  const plans = { static: planned(Pstatic, BIG).routes, td: planned(Ptd, BIG).routes };
  for (const [planMode, rerouteMode] of [['static', 'static'], ['static', 'td'], ['td', 'td'], ['td', 'static']]) {
    const routes = plans[planMode];
    const none = onTruth(TRUTH, routes).finish;
    const sim = simulate(TRUTH, truth60, routes, { reroute: rerouteMode, planTravel: planMode === 'static' ? Pstatic.travel : null });
    const ev = sim.events;
    const ok = ev.filter(e => e.meets);
    out.k60.reroute.push({
      plan: planMode, reroute: rerouteMode, evaluations: ev.length, improved: ev.filter(e => e.predictedSaving > 1e-6).length, accepted: ok.length,
      triggered: planMode === 'static' ? ev.filter(e => e.trigger).length : null,
      predictedSaving: ok.reduce((s, e) => s + e.predictedSaving, 0), realSaving: ok.reduce((s, e) => s + e.realSaving, 0),
      worseInReality: ok.filter(e => e.realSaving < 0).length, maxPredicted: Math.max(0, ...ev.map(e => e.predictedSaving)),
      flippedAvg: ok.length ? ok.reduce((s, e) => s + e.flipped, 0) / ok.length : 0, flippedMax: Math.max(0, ...ok.map(e => e.flipped)),
      finishWithout: none, finishWith: sim.finish, events: ev,
    });
  }
}
// Kịch bản phụ (giả định, không phải dữ liệu TomTom) để kiểm tra cơ chế đổi tuyến: mọi chặng đi vào hoặc ra khỏi
// D03, D05, D08, D19 (chọn vì nằm giữa tuyến của xe máy trong khung giờ sự cố) chậm dần từ 16:15 đến gấp đôi lúc 16:25, giữ đến 16:50 rồi giảm dần về bình thường lúc 17:05.
// Kế hoạch lập lúc 16:00 không biết sự cố; lúc đánh giá đổi tuyến, dữ liệu đã có sự cố (như khi gọi lại TomTom).
{
  const JAM = new Set(['D03', 'D05', 'D08', 'D19']);
  const T = clockSeconds;
  const ramp = t => (t <= T('16:15') ? 1 : t < T('16:25') ? 1 + (t - T('16:15')) / 600 : t <= T('16:50') ? 2 : t < T('17:05') ? 2 - (t - T('16:50')) / 900 : 1);
  const jam = (p, a, b, t) => { const x = truth60(p, a, b, t); return x != null && (JAM.has(a) || JAM.has(b)) ? x * ramp(t) : x; };
  const Ptd = problem60();
  const routes = planned(Ptd, BIG).routes;
  const TRUTH_JAM = { ...TRUTH, travelAt: jam };
  const none = Math.max(H60, ...routes.map((r, v) => (r.length ? routeSchedule(TRUTH_JAM, v, r).end : H60)));
  for (const rerouteMode of ['static', 'td']) {
    const sim = simulate(TRUTH, jam, routes, { reroute: rerouteMode });
    const ev = sim.events;
    const ok = ev.filter(e => e.meets);
    out.k60.reroute.push({
      plan: 'td', reroute: rerouteMode, stress: true, evaluations: ev.length, improved: ev.filter(e => e.predictedSaving > 1e-6).length, accepted: ok.length, triggered: null,
      predictedSaving: ok.reduce((s, e) => s + e.predictedSaving, 0), realSaving: ok.reduce((s, e) => s + e.realSaving, 0),
      worseInReality: ok.filter(e => e.realSaving < 0).length, maxPredicted: Math.max(0, ...ev.map(e => e.predictedSaving)),
      flippedAvg: ok.length ? ok.reduce((s, e) => s + e.flipped, 0) / ok.length : 0, flippedMax: Math.max(0, ...ok.map(e => e.flipped)),
      finishWithout: none, finishWith: sim.finish, events: ev,
    });
  }
}
const PM = { static: 'Ma trận cố định 16:00', td: 'Phụ thuộc giờ' };
const RM = { static: 'Ma trận tại giờ đánh giá', td: 'Phụ thuộc giờ từ giờ đánh giá' };
table(['Lập kế hoạch', 'Đánh giá đổi tuyến bằng', 'Số lần đánh giá', 'detectIncrease kích hoạt', 'Có thứ tự tốt hơn', 'Tiết kiệm dự kiến lớn nhất (giây)', 'Đạt ngưỡng', 'Tiết kiệm dự kiến khi đạt (phút)', 'Tiết kiệm thực khi đạt (phút)', 'Đạt ngưỡng nhưng thực tế chậm hơn', 'Cặp điểm đổi thứ tự TB / lớn nhất', 'Xe cuối về kho: không đổi / có đổi'],
  out.k60.reroute.map(e => [`${PM[e.plan]}${e.stress ? ' — kịch bản phụ giả định: ùn tắc ×2 quanh D03, D05, D08, D19 lúc 16:25–16:50' : ''}`, RM[e.reroute], e.evaluations, e.triggered ?? '—', e.improved, Math.round(e.maxPredicted), e.accepted, minutes(e.predictedSaving), minutes(e.realSaving), e.worseInReality,
    `${e.flippedAvg.toFixed(1).replace('.', ',')} / ${e.flippedMax}`, `${clock(e.finishWithout)} / ${clock(e.finishWith)}`]));

// ---------------------------------------------------------------- f) Thời gian tính theo số đơn
console.log('### f) Thời gian tính và số chặng cần lấy theo số đơn\n');
out.k60.scaling = [];
// Tập con: lần lượt đơn thứ nhất của mỗi điểm, rồi đơn thứ hai..., để 15 đơn đã trải trên 15 điểm
const rank = new Map();
const spread = kb60.don.map((d, i) => { const k = rank.get(d.diem) ?? 0; rank.set(d.diem, k + 1); return { d, k, i }; })
  .sort((a, b) => a.k - b.k || a.i - b.i).map(x => x.d);
for (const n of [15, 30, 45, 60]) {
  const orders = spread.slice(0, n);
  const P = problem60({ orders });
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const a = insertion(P);
    const t1 = performance.now();
    const b = localSearch(P, a, BIG);
    const t2 = performance.now();
    const d = localSearch(P, a);
    runs.push({ insertionMs: t1 - t0, lsMs: t2 - t1, evaluations: b.stats.evaluations, defaultStop: d.stats.stopReason });
  }
  runs.sort((x, y) => x.insertionMs + x.lsMs - y.insertionMs - y.lsMs);
  const N = new Set(orders.map(d => d.diem)).size + 1;
  out.k60.scaling.push({ n, points: N - 1, ...runs[2], legsPerProfile: N * (N - 1), legsTotal: PROFILES60.length * SLOTS60.length * N * (N - 1) });
}
table(['Số đơn', 'Số điểm giao', 'Insertion (ms)', 'Local Search đến khi hết cải thiện (ms)', 'Phép đánh giá', 'Giới hạn mặc định 100.000 phép / 2 s', 'Chặng mỗi cấu hình mỗi khung', `Tổng chặng (${PROFILES60.length} cấu hình × ${SLOTS60.length} khung)`],
  out.k60.scaling.map(e => [e.n, e.points, ms1(e.insertionMs), ms1(e.lsMs), e.evaluations, e.defaultStop === 'Không còn phương án cải thiện' ? 'đủ' : e.defaultStop, e.legsPerProfile, e.legsTotal]));

if (process.argv.includes('--json')) {
  writeFileSync(new URL('./ket_qua.json', import.meta.url), JSON.stringify(out, null, 2));
  console.log('Đã ghi experiments/ket_qua.json');
}
