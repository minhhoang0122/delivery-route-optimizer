// Kiểm thử engine trên ma trận TomTom đã ghi lúc 16:00 (20 đơn, 5 xe, Kho Hải Châu).
// Kết quả phải trùng với bản thử nghiệm trong test_demo: Insertion 9.974 giây, sau Relocate/Swap 9.785 giây.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  insertion, localSearch, plan, totalSeconds, evaluateReroute, routeSeconds, routeSchedule,
  interpolateSlots, fifoCheck, clockSeconds, finishSeconds, flippedPairs,
} from '../src/index.js';

const read = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const scenario = read('kich_ban.json');
const matrix = read('ma_tran_1600.json');
const matrix1730 = read('ma_tran_1730.json');
const TYPE = { xe_may: 'motorcycle', xe_tai: 'small_truck' };

const lookup = m => {
  const index = new Map(m.diem.map((d, i) => [d.ma, i]));
  return (profile, a, b) => m.thoi_gian[profile][index.get(a)][index.get(b)];
};

// Các số liệu gốc (9.974 / 9.785 giây) là của mục tiêu tổng thời gian, nên bài toán mặc định ở đây dùng objective 'total'
function problem(maxRouteSeconds = null, objective = 'total') {
  return {
    depot: 'KHO',
    objective,
    travel: lookup(matrix),
    orders: scenario.don.map((d, i) => ({ id: i + 1, code: d.ma, point: d.ma, weightKg: d.khoi_luong_kg, vehicleTypes: d.loai_xe.map(t => TYPE[t]) })),
    vehicles: scenario.xe.map((x, i) => ({ id: i + 1, type: TYPE[x.loai], profile: x.cau_hinh, capacityKg: x.tai_trong_kg })),
    maxRouteSeconds,
  };
}

test('Insertion Heuristic cho cùng kết quả với test_demo', () => {
  const P = problem();
  const r = insertion(P);
  assert.equal(totalSeconds(P, r.routes), 9974);
  assert.equal(r.unassigned.length, 0);
});

test('Relocate và Swap giảm tổng thời gian và giữ nguyên tập đơn', () => {
  const P = problem();
  const first = insertion(P);
  const r = localSearch(P, first);
  assert.equal(totalSeconds(P, r.routes), 9785);
  assert.equal(r.stats.evaluations, 3846);
  assert.deepEqual(r.routes.flat().sort((a, b) => a - b), first.routes.flat().sort((a, b) => a - b));
});

test('Mỗi đơn xuất hiện một lần, không vượt tải, đúng loại xe', () => {
  const P = problem(60 * 60);
  const out = plan(P);
  const seen = out.routes.flatMap(r => r.orderIds);
  assert.equal(new Set(seen).size, seen.length);
  for (const r of out.routes) {
    const v = P.vehicles.find(x => x.id === r.vehicleId);
    assert.ok(r.loadKg <= v.capacityKg);
    for (const id of r.orderIds) assert.ok(P.orders[id - 1].vehicleTypes.includes(v.type));
    assert.ok(r.seconds <= 3600);
  }
  assert.equal(seen.length + out.unassigned.length, P.orders.length);
});

test('Giới hạn 45 phút để lại đơn 120 kg chưa xếp kèm lý do', () => {
  const out = plan(problem(45 * 60));
  const u = out.unassigned.find(x => x.orderId === 8);
  assert.ok(u, 'DH-1029 phải nằm trong danh sách chưa phân công');
  assert.match(u.reason, /thời lượng/);
});

test('Chặng thiếu dữ liệu không bị coi là 0 giây', () => {
  const P = problem();
  const travel = P.travel;
  P.travel = (p, a, b) => (b === 'DH-1049' || a === 'DH-1049' ? null : travel(p, a, b));
  const out = plan(P);
  const u = out.unassigned.find(x => x.orderId === 20);
  assert.ok(u);
  assert.match(u.reason, /Thiếu dữ liệu tuyến/);
});

test('Đổi tuyến giữ nguyên điểm kế tiếp và chỉ nhận khi đạt ngưỡng', () => {
  const P = problem();
  const stops = ['DH-1043', 'DH-1049', 'DH-1024', 'DH-1026', 'DH-1025'].map((p, i) => ({ id: i + 1, point: p }));
  const r = evaluateReroute({ depot: 'KHO', travel: P.travel, profile: 'truck', start: 'DH-1022', stops });
  assert.equal(r.proposedStopIds[0], 1);
  assert.ok(r.proposedSeconds <= r.currentSeconds);
  assert.equal(r.meetsThreshold, r.savingSeconds >= Math.max(60, 0.05 * r.currentSeconds));
});

// ---------------------------------------------------------------- Thời gian phụ thuộc giờ và thời gian phục vụ
const H16 = clockSeconds('16:00');
const slots = [
  { seconds: H16, travel: lookup(matrix) },
  { seconds: clockSeconds('17:30'), travel: lookup(matrix1730) },
];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

test('travelAt không đổi theo giờ cho đúng kết quả của ma trận cố định', () => {
  const P = problem();
  const Q = { ...problem(), travelAt: (p, a, b) => P.travel(p, a, b), startSeconds: H16 };
  const a = insertion(Q);
  assert.equal(totalSeconds(Q, a.routes), 9974);
  assert.deepEqual(a.routes, insertion(P).routes);
  const b = localSearch(Q, a);
  assert.equal(totalSeconds(Q, b.routes), 9785);
  assert.equal(b.stats.evaluations, 3846);
  // Có thời gian phục vụ và giới hạn 60 phút: hai cách tính vẫn cho cùng kế hoạch
  for (const X of [P, Q]) { X.serviceSeconds = 180; X.maxRouteSeconds = 3600; }
  const strip = r => ({ routes: r.routes.map(x => [x.orderIds, x.seconds]), unassigned: r.unassigned });
  assert.deepEqual(strip(plan(Q)), strip(plan(P)));
});

test('Tính tiến theo giờ: mỗi chặng lấy thời gian ứng với giờ xe rời điểm', () => {
  const P = {
    depot: 'K', startSeconds: H16, serviceSeconds: 180,
    travelAt: (p, a, b, t) => 600 + (t - H16) / 10,
    orders: [{ point: 'A' }, { point: 'B' }],
    vehicles: [{ profile: 'x' }],
  };
  const s = routeSchedule(P, 0, [0, 1]);
  near(s.arrivals[0], H16 + 600);
  near(s.arrivals[1], H16 + 780 + 678);           // rời A lúc 16:13 → chặng 600 + 78
  near(s.end, H16 + 780 + 678 + 180 + 763.8);     // rời B lúc 16:27:18 → chặng 600 + 163,8
  near(s.seconds, routeSeconds(P, 0, [0, 1]));
  near(s.serviceSeconds, 360);
  near(s.travelSeconds, s.seconds - 360);
});

test('Insertion phụ thuộc giờ chọn đúng vị trí như khi tính lại cả tuyến', () => {
  const Q = { ...problem(3600), travelAt: interpolateSlots(slots), startSeconds: H16, serviceSeconds: 180 };
  const routes = Q.vehicles.map(() => []);
  const queue = Q.orders.map((_, o) => o)
    .sort((a, b) => Q.orders[b].weightKg - Q.orders[a].weightKg || Q.orders[a].code.localeCompare(Q.orders[b].code));
  for (const o of queue) {
    let best = null;
    routes.forEach((r, v) => {
      if (!Q.orders[o].vehicleTypes.includes(Q.vehicles[v].type)) return;
      if (r.reduce((s, x) => s + Q.orders[x].weightKg, 0) + Q.orders[o].weightKg > Q.vehicles[v].capacityKg) return;
      const before = routeSeconds(Q, v, r);
      for (let p = 0; p <= r.length; p++) {
        const next = r.slice(0, p).concat([o], r.slice(p));
        const after = routeSeconds(Q, v, next);
        if (after > 3600) continue;
        if (!best || after - before < best.delta) best = { v, next, delta: after - before };
      }
    });
    if (best) routes[best.v] = best.next;
  }
  assert.deepEqual(insertion(Q).routes, routes);
});

test('Giới hạn 60 phút tính cả thời gian phục vụ, với ma trận cố định và phụ thuộc giờ', () => {
  for (const extra of [{}, { travelAt: interpolateSlots(slots), startSeconds: H16 }]) {
    const Q = { ...problem(3600), serviceSeconds: 180, ...extra };
    const out = plan(Q);
    for (const r of out.routes) {
      const v = Q.vehicles.findIndex(x => x.id === r.vehicleId);
      const s = routeSchedule(Q, v, r.orderIds.map(id => id - 1));
      assert.ok(r.seconds <= 3600);
      near(r.seconds, s.seconds);
      near(s.serviceSeconds, 180 * r.orderIds.length);
      if (r.orderIds.length) near(r.returnSeconds, (Q.startSeconds ?? 0) + r.seconds);
    }
    assert.equal(out.routes.reduce((s, r) => s + r.orderIds.length, 0) + out.unassigned.length, Q.orders.length);
    // Local Search không bao giờ nhận phương án vượt giới hạn
    const ls = localSearch(Q, insertion(Q));
    ls.routes.forEach((r, v) => assert.ok(routeSeconds(Q, v, r) <= 3600));
  }
  // Thời gian phục vụ riêng của từng đơn được ưu tiên hơn giá trị chung
  const Q = { ...problem(), serviceSeconds: 180 };
  Q.orders[0].serviceSeconds = 600;
  const s = routeSchedule(Q, 3, [0, 1]);
  near(s.serviceSeconds, 780);
});

test('Nội suy tuyến tính giữa các khung giờ, giữ nguyên ngoài khoảng', () => {
  const f = interpolateSlots([
    { seconds: 1000, travel: (p, a, b) => (b === 'Z' ? 300 : 200) },
    { seconds: 0, travel: (p, a, b) => (b === 'Z' ? null : 100) },
  ]);
  assert.equal(f('x', 'A', 'B', -50), 100);
  assert.equal(f('x', 'A', 'B', 0), 100);
  assert.equal(f('x', 'A', 'B', 250), 125);
  assert.equal(f('x', 'A', 'B', 500), 150);
  assert.equal(f('x', 'A', 'B', 1000), 200);
  assert.equal(f('x', 'A', 'B', 5000), 200);
  assert.equal(f('x', 'A', 'A', 500), 0);
  assert.equal(f('x', 'A', 'Z', 500), null, 'khung bao quanh thiếu dữ liệu thì chặng là null');
  assert.equal(f('x', 'A', 'Z', 1000), 300);
  assert.equal(clockSeconds('16:45'), 60300);
  // Đúng tại các khung đã ghi
  const g = interpolateSlots(slots);
  assert.equal(g('truck', 'KHO', 'DH-1029', H16), lookup(matrix)('truck', 'KHO', 'DH-1029'));
  assert.equal(g('truck', 'KHO', 'DH-1029', H16 + 5400), lookup(matrix1730)('truck', 'KHO', 'DH-1029'));
  const mid = g('motorcycle', 'DH-1021', 'DH-1048', H16 + 2700);
  near(mid, (lookup(matrix)('motorcycle', 'DH-1021', 'DH-1048') + lookup(matrix1730)('motorcycle', 'DH-1021', 'DH-1048')) / 2);
});

test('Kiểm tra FIFO: phát hiện chặng nhanh lên quá khoảng cách khung, dữ liệu thật đạt', () => {
  const bad = fifoCheck([
    { seconds: 0, travel: () => 2000 },
    { seconds: 1800, travel: () => 100 },
  ], ['x'], ['A', 'B']);
  assert.equal(bad.ok, false);
  assert.equal(bad.violations.length, 2);
  const real = fifoCheck(slots, ['motorcycle', 'truck'], matrix.diem.map(d => d.ma));
  assert.equal(real.checked, 840);
  assert.ok(real.ok);
});

test('Đổi tuyến với travelAt không đổi theo giờ cho cùng kết quả', () => {
  const P = problem();
  const stops = ['DH-1043', 'DH-1049', 'DH-1024', 'DH-1026', 'DH-1025'].map((p, i) => ({ id: i + 1, point: p }));
  const args = { depot: 'KHO', profile: 'truck', start: 'DH-1022', stops };
  const a = evaluateReroute({ ...args, travel: P.travel });
  const b = evaluateReroute({ ...args, travelAt: (p, x, y) => P.travel(p, x, y), startSeconds: H16 + 1200 });
  assert.deepEqual(b, a);
  const c = evaluateReroute({ ...args, travelAt: interpolateSlots(slots), startSeconds: H16 + 1200, serviceSeconds: 180 });
  assert.equal(c.proposedStopIds[0], 1);
  assert.ok(c.proposedSeconds <= c.currentSeconds);
});

// ---------------------------------------------------------------- Mục tiêu makespan, giờ hết ca, số kiện, thời gian dừng
const lexBetter = (a, b) => a[0] < b[0] - 1e-6 || (a[0] <= b[0] && a[1] < b[1] - 1e-6);

test('Makespan: dùng nhiều xe, giờ xe cuối về kho sớm hơn hẳn mục tiêu tổng thời gian', () => {
  const T = plan(problem(null, 'total'));
  const M = plan(problem(null, 'makespan'));
  assert.equal(M.stats.objective, 'makespan');
  assert.ok(M.routes.filter(r => r.orderIds.length).length >= 4);
  assert.ok(M.stats.finishSeconds < T.stats.finishSeconds / 2);
  near(M.stats.finishSeconds, Math.max(...M.routes.map(r => r.seconds)));
  // Mặc định là makespan
  const D = plan({ ...problem(), objective: undefined });
  assert.equal(D.stats.objective, 'makespan');
  assert.deepEqual(D.routes.map(r => r.orderIds), M.routes.map(r => r.orderIds));
});

test('Local Search theo makespan không làm muộn giờ xe cuối và dừng ở cực tiểu địa phương', () => {
  for (const extra of [{}, { travelAt: interpolateSlots(slots), startSeconds: H16, serviceSeconds: 180 }]) {
    const P = { ...problem(null, 'makespan'), ...extra };
    const a = insertion(P);
    const b = localSearch(P, a, { maxEvaluations: 1e6, maxMs: 1e5 });
    const ka = [finishSeconds(P, a.routes), totalSeconds(P, a.routes)];
    const kb = [finishSeconds(P, b.routes), totalSeconds(P, b.routes)];
    assert.ok(kb[0] <= ka[0] && (kb[0] < ka[0] || kb[1] <= ka[1]));
    assert.equal(b.stats.stopReason, 'Không còn phương án cải thiện');
    // Không còn Relocate nào tốt hơn theo thứ tự từ điển (kiểm tra độc lập với cách cài đặt)
    const R = b.routes;
    for (let v1 = 0; v1 < R.length; v1++) for (let i = 0; i < R[v1].length; i++) for (let v2 = 0; v2 < R.length; v2++) {
      const o = R[v1][i];
      if (!P.orders[o].vehicleTypes.includes(P.vehicles[v2].type)) continue;
      const rest = R[v1].filter((_, k) => k !== i);
      const base = v1 === v2 ? rest : R[v2];
      for (let p = 0; p <= base.length; p++) {
        const next = R.map(r => r.slice());
        next[v1] = rest;
        next[v2] = base.slice(0, p).concat([o], base.slice(p));
        if (next.some((r, v) => r.reduce((s, x) => s + P.orders[x].weightKg, 0) > P.vehicles[v].capacityKg)) continue;
        assert.ok(!lexBetter([finishSeconds(P, next), totalSeconds(P, next)], kb), 'còn phương án Relocate tốt hơn');
      }
    }
  }
});

test('Insertion theo makespan chọn đúng khóa (giờ xe cuối, ΔT) như khi tính lại cả kế hoạch', () => {
  const Q = { ...problem(null, 'makespan'), travelAt: interpolateSlots(slots), startSeconds: H16, serviceSeconds: 90, stopSeconds: 90, shiftEndSeconds: H16 + 5400 };
  const routes = Q.vehicles.map(() => []);
  const queue = Q.orders.map((_, o) => o)
    .sort((a, b) => Q.orders[b].weightKg - Q.orders[a].weightKg || Q.orders[a].code.localeCompare(Q.orders[b].code));
  for (const o of queue) {
    let best = null;
    routes.forEach((r, v) => {
      if (!Q.orders[o].vehicleTypes.includes(Q.vehicles[v].type)) return;
      if (r.reduce((s, x) => s + Q.orders[x].weightKg, 0) + Q.orders[o].weightKg > Q.vehicles[v].capacityKg) return;
      const before = routeSeconds(Q, v, r);
      for (let p = 0; p <= r.length; p++) {
        const next = routes.map(x => x.slice());
        next[v] = r.slice(0, p).concat([o], r.slice(p));
        const after = routeSeconds(Q, v, next[v]);
        if (H16 + after > Q.shiftEndSeconds) continue;
        const key = [finishSeconds(Q, next), after - before];
        if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { key, next };
      }
    });
    if (best) best.next.forEach((r, v) => { routes[v] = r; });
  }
  assert.deepEqual(insertion(Q, { rule: 'greedy' }).routes, routes);
});

test('Giờ hết ca: mọi xe về kho trước giờ hết ca, đơn không kịp có lý do "Không kịp trong ca"', () => {
  for (const extra of [{}, { travelAt: interpolateSlots(slots) }]) {
    const Q = { ...problem(null, 'makespan'), startSeconds: H16, serviceSeconds: 180, shiftEndSeconds: H16 + 40 * 60, ...extra };
    const out = plan(Q);
    assert.ok(out.unassigned.length > 0);
    for (const u of out.unassigned) assert.match(u.reason, /Không kịp trong ca/);
    for (const r of out.routes) if (r.orderIds.length) assert.ok(r.returnSeconds <= Q.shiftEndSeconds + 1e-9);
    assert.ok(out.stats.finishSeconds <= Q.shiftEndSeconds + 1e-9);
  }
  // maxRouteSeconds vẫn dùng được như trước
  const out = plan(problem(45 * 60, 'makespan'));
  for (const r of out.routes) assert.ok(r.seconds <= 45 * 60);
});

test('Số kiện: không xe nào chở quá số kiện, đơn không vừa có lý do riêng', () => {
  const Q = problem(null, 'makespan');
  Q.vehicles.forEach(v => { v.capacityParcels = 3; });
  Q.orders.forEach((o, i) => { o.parcels = i % 2 ? 2 : 1; });
  const out = plan(Q);
  for (const r of out.routes) {
    assert.ok(r.loadParcels <= 3);
    assert.equal(r.loadParcels, r.orderIds.reduce((s, id) => s + Q.orders[id - 1].parcels, 0));
  }
  assert.ok(out.unassigned.length > 0);
  assert.ok(out.unassigned.every(u => /Vượt số kiện/.test(u.reason)));
  // Không ghi số kiện thì mỗi đơn một kiện, xe không giới hạn số kiện
  assert.equal(plan(problem(null, 'makespan')).routes.reduce((s, r) => s + r.loadParcels, 0), 20);
});

test('Thời gian dừng: nhiều đơn liên tiếp ở cùng điểm chỉ tính một lần dừng', () => {
  const P = {
    depot: 'K', serviceSeconds: 90, stopSeconds: 90,
    travel: (p, a, b) => (a === b ? 0 : 100),
    orders: [{ point: 'A' }, { point: 'A' }, { point: 'B' }].map((x, i) => ({ ...x, id: i + 1, code: `X${i}`, weightKg: 1, vehicleTypes: ['m'] })),
    vehicles: [{ id: 1, type: 'm', profile: 'x', capacityKg: 10 }],
  };
  const s = routeSchedule(P, 0, [0, 1, 2]);
  assert.equal(s.stops, 2);
  assert.equal(s.serviceSeconds, 90 * 3 + 90 * 2);
  assert.equal(s.seconds, 300 + 450);
  assert.deepEqual(s.arrivals, [100, 280, 470]);   // đơn thứ hai ở A "đến" lúc giao xong đơn thứ nhất
  assert.equal(routeSeconds(P, 0, [0, 2, 1]), 400 + 90 * 3 + 90 * 3);
  // Insertion xếp hai đơn cùng điểm liền nhau
  const r = insertion(P).routes[0];
  assert.equal(Math.abs(r.indexOf(0) - r.indexOf(1)), 1);
});

test('ΔT công thức có thời gian dừng khớp với tính lại cả tuyến (ma trận cố định)', () => {
  const P = { ...problem(null, 'makespan'), serviceSeconds: 90, stopSeconds: 90 };
  // Gộp điểm: đơn lẻ dùng chung điểm với đơn đứng trước, để có nhiều đơn cùng địa chỉ
  P.orders.forEach((o, i) => { o.point = P.orders[i - (i % 2)].point; });
  for (const rule of ['greedy', 'regret2']) {
    const viaFormula = insertion(P, { rule }).routes;
    const Q = { ...P, travelAt: (p, a, b) => P.travel(p, a, b) };   // cùng dữ liệu, đi đường tính lại phần đuôi
    assert.deepEqual(viaFormula, insertion(Q, { rule }).routes);
  }
  const viaFormula = insertion(P).routes;
  assert.ok(viaFormula.some(r => r.some((o, k) => k && P.orders[r[k - 1]].point === P.orders[o].point)));
});

test('Regret-2, Or-opt và 2-opt cho kế hoạch hợp lệ', () => {
  const P = { ...problem(null, 'makespan'), travelAt: interpolateSlots(slots), startSeconds: H16, serviceSeconds: 180, shiftEndSeconds: H16 + 7200 };
  const a = insertion(P, { rule: 'regret2' });
  const b = localSearch(P, a, { moves: ['relocate', 'swap', 'oropt', '2opt'], maxEvaluations: 1e6, maxMs: 1e5 });
  const seen = b.routes.flat();
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length + b.unassigned.length, P.orders.length);
  b.routes.forEach((r, v) => {
    assert.ok(r.every(o => P.orders[o].vehicleTypes.includes(P.vehicles[v].type)));
    assert.ok(r.reduce((s, o) => s + P.orders[o].weightKg, 0) <= P.vehicles[v].capacityKg);
    assert.ok(H16 + routeSeconds(P, v, r) <= P.shiftEndSeconds + 1e-9);
  });
});

test('Đổi tuyến: số cặp đổi thứ tự và thời gian dừng', () => {
  assert.equal(flippedPairs([1, 2, 3, 4], [1, 2, 3, 4]), 0);
  assert.equal(flippedPairs([1, 2, 3, 4], [1, 3, 2, 4]), 1);
  assert.equal(flippedPairs([1, 2, 3, 4], [4, 3, 2, 1]), 6);
  const P = problem();
  const stops = ['DH-1043', 'DH-1049', 'DH-1024', 'DH-1026', 'DH-1025'].map((p, i) => ({ id: i + 1, point: p }));
  const args = { depot: 'KHO', travel: P.travel, profile: 'truck', start: 'DH-1022', stops };
  const base = evaluateReroute(args);
  const r = evaluateReroute({ ...args, serviceSeconds: 90, stopSeconds: 90 });
  near(r.currentSeconds, base.currentSeconds + 5 * 180);
  assert.equal(r.flippedPairs, flippedPairs([0, 1, 2, 3, 4], r.proposedStopIds.map(id => id - 1)));
});

// ---------------------------------------------------------------- Kịch bản 60 đơn (30 điểm, 4 tài xế, ca 16:00–18:00)
test('Kịch bản 60 đơn: dữ liệu đúng quy ước, kế hoạch hợp lệ trên 4 khung giờ', () => {
  const kb = read('kich_ban_60.json');
  assert.equal(kb.diem.length, 30);
  assert.equal(kb.don.length, 60);
  for (const d of [kb.kho, ...kb.diem]) {
    const m = d.nguon_toa_do.match(/\(Point Address, độ khớp ([\d.]+)\)$/);
    assert.ok(m && Number(m[1]) >= 0.9, `${d.ma}: ${d.nguon_toa_do}`);
    assert.match(d.dia_chi, /, Đà Nẵng$/);
  }
  const slots60 = ['1600', '1630', '1700', '1730'].map(h => ({ seconds: clockSeconds(`${h.slice(0, 2)}:${h.slice(2)}`), travel: lookup(read(`ma_tran_60_${h}.json`)) }));
  assert.ok(fifoCheck(slots60, ['motorcycle', 'truck'], [kb.kho, ...kb.diem].map(d => d.ma)).ok);
  const P = {
    depot: 'KHO', travelAt: interpolateSlots(slots60), startSeconds: clockSeconds(kb.ca.bat_dau), shiftEndSeconds: clockSeconds(kb.ca.ket_thuc),
    stopSeconds: kb.phuc_vu.moi_diem_giay, serviceSeconds: kb.phuc_vu.moi_don_giay,
    orders: kb.don.map((d, i) => ({ id: i + 1, code: d.ma, point: d.diem, weightKg: d.khoi_luong_kg, parcels: d.so_kien, vehicleTypes: d.loai_xe.map(t => TYPE[t]) })),
    vehicles: kb.xe.map((x, i) => ({ id: i + 1, type: TYPE[x.loai], profile: x.cau_hinh, capacityKg: x.tai_trong_kg, capacityParcels: x.so_kien_toi_da })),
  };
  const out = plan(P, { maxEvaluations: 1e6, maxMs: 1e5 });
  assert.equal(out.unassigned.length, 0);
  assert.ok(out.stats.finishSeconds <= P.shiftEndSeconds);
  for (const r of out.routes) {
    const v = P.vehicles[r.vehicleId - 1];
    assert.ok(r.loadKg <= v.capacityKg && r.loadParcels <= v.capacityParcels);
    for (const id of r.orderIds) assert.ok(P.orders[id - 1].vehicleTypes.includes(v.type));
    near(r.returnSeconds, P.startSeconds + r.seconds);
  }
  assert.equal(out.routes.filter(r => r.orderIds.length).length, 4);
});
