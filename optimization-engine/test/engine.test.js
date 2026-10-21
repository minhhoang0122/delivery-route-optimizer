// Kiểm thử engine trên ma trận TomTom đã ghi lúc 16:00 (20 đơn, 5 xe, Kho Hải Châu).
// Kết quả phải trùng với bản thử nghiệm trong test_demo: Insertion 9.974 giây, sau Relocate/Swap 9.785 giây.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { insertion, localSearch, plan, totalSeconds, evaluateReroute } from '../src/index.js';

const read = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const scenario = read('kich_ban.json');
const matrix = read('ma_tran_1600.json');
const TYPE = { xe_may: 'motorcycle', xe_tai: 'small_truck' };

function problem(maxRouteSeconds = null) {
  const index = new Map(matrix.diem.map((d, i) => [d.ma, i]));
  return {
    depot: 'KHO',
    travel: (profile, a, b) => matrix.thoi_gian[profile][index.get(a)][index.get(b)],
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
