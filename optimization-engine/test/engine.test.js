// Kiểm thử engine trên ma trận TomTom đã ghi lúc 16:00 (20 đơn, 5 xe, Kho Hải Châu).
// Kết quả phải trùng với bản thử nghiệm trong test_demo: Insertion 9.974 giây, sau Relocate/Swap 9.785 giây.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  insertion, localSearch, plan, totalSeconds, evaluateReroute, routeSeconds, routeSchedule,
  interpolateSlots, fifoCheck, clockSeconds,
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

function problem(maxRouteSeconds = null) {
  return {
    depot: 'KHO',
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
