// Kiểm thử nghiệp vụ và phân quyền qua API, theo các tiêu chí chấp nhận ở Bảng 3.2 và Bảng 3.3.
// Chạy trên cơ sở dữ liệu vừa nạp mẫu (npm run seed -- --reset) khi Backend đang chạy:
//   npm run test:flow
// Biến API_BASE đổi địa chỉ Backend (mặc định http://localhost:3000/api).
// Kịch bản ghi dữ liệu thật vào cơ sở dữ liệu, chỉ chạy trên máy phát triển.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const BASE = process.env.API_BASE || `http://localhost:${process.env.PORT || 3000}/api`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PW = process.env.SEED_PASSWORD;
let fails = 0;
const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails++; };

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const login = async u => (await api(null, 'POST', '/auth/login', { username: u, password: PW })).data.token;

console.log('Đăng nhập và phân quyền');
const bad = await api(null, 'POST', '/auth/login', { username: 'admin', password: 'sai-mat-khau' });
check(bad.status === 401, 'sai mật khẩu bị từ chối');
const locked = await api(null, 'POST', '/auth/login', { username: 'driver5', password: PW });
check(locked.status === 403, 'tài khoản bị khóa không đăng nhập được');
const admin = await login('admin');
const disp = await login('dispatcher');
const drv = {};
for (const u of ['driver1', 'driver2', 'driver3', 'driver4']) drv[u] = await login(u);
check((await api(drv.driver1, 'GET', '/orders')).status === 403, 'Driver không xem được đơn hàng');
check((await api(disp, 'GET', '/users')).status === 403, 'Dispatcher không quản lý được tài khoản');
check((await api(null, 'GET', '/orders')).status === 401, 'chưa đăng nhập bị từ chối');

console.log('Administrator');
const users = await api(admin, 'GET', '/users');
check(users.data.users.length === 8, 'có 8 tài khoản mẫu');
const created = await api(admin, 'POST', '/users', { username: 'driver6', fullName: 'Hồ Văn Phúc', role: 'driver', password: 'TamThoi@123' });
check(created.status === 201 && created.data.user.mustChangePassword, 'cấp tài khoản mới, buộc đổi mật khẩu');
const d6 = await login_pw('driver6', 'TamThoi@123');
async function login_pw(u, p) { return (await api(null, 'POST', '/auth/login', { username: u, password: p })).data.token; }
check((await api(d6, 'GET', '/driver/current-trip')).data.error.code === 'MUST_CHANGE_PASSWORD', 'tài khoản mới phải đổi mật khẩu trước');
check((await api(d6, 'POST', '/auth/change-password', { currentPassword: 'TamThoi@123', newPassword: 'MoiDoi@456' })).status === 200, 'đổi mật khẩu');
const selfLock = await api(admin, 'PATCH', `/users/${users.data.users.find(u => u.username === 'admin').id}/status`, { status: 'locked' });
check(selfLock.status === 400, 'không tự khóa chính mình');

console.log('Dispatcher: lập kế hoạch');
const opt = (await api(disp, 'GET', '/planning/options')).data;
check(opt.orders.length === 20, '20 đơn chờ xếp');
const ready = opt.vehicles.filter(v => !v.problem).map(v => v.id);
check(ready.length === 4, '4 xe sẵn sàng (xe 5 bảo trì)');
const badRun = await api(disp, 'POST', '/planning/runs', { clientEventId: randomUUID(), orderIds: opt.orders.map(o => o.id), vehicleIds: opt.vehicles.map(v => v.id) });
check(badRun.status === 400, 'chọn xe bảo trì bị từ chối, không lưu bản nháp');
const runReq = { clientEventId: randomUUID(), orderIds: opt.orders.map(o => o.id), vehicleIds: ready, maxRouteMinutes: 60 };
let run = (await api(disp, 'POST', '/planning/runs', runReq)).data.run;
const again = await api(disp, 'POST', '/planning/runs', runReq);
check(again.data.run.id === run.id, 'gửi lại cùng mã không tạo lần tính thứ hai');
for (let i = 0; i < 60 && run.status === 'running'; i++) {
  await new Promise(r => setTimeout(r, 300));
  run = (await api(disp, 'GET', `/planning/runs/${run.id}`)).data.run;
}
check(run.status === 'draft', 'bản nháp đã lưu: ' + run.status + ' ' + JSON.stringify(run.result?.error ?? ''));
const r = run.result;
console.log('     tuyến:', r.routes.map(x => `xe ${x.vehicleId}: ${x.orderIds.length} đơn ${(x.seconds / 60).toFixed(1)} phút ${x.loadKg} kg`).join(' | '));
console.log('     chưa xếp:', JSON.stringify(r.unassigned), 'T insertion', r.stats.insertionSeconds, '→', r.stats.finalSeconds, 'đánh giá', r.stats.evaluations, 'ma trận', JSON.stringify(r.matrix));
const assignedIds = r.routes.flatMap(x => x.orderIds);
check(new Set(assignedIds).size === assignedIds.length, 'mỗi đơn chỉ một lần');
check(r.routes.every(x => x.seconds <= 3600), 'mỗi tuyến ≤ 60 phút');

console.log('Dispatcher: giao chuyến');
const commitId = randomUUID();
const commit = await api(disp, 'POST', `/planning/runs/${run.id}/commit`, { clientEventId: commitId });
check(commit.status === 201, 'giao chuyến: ' + commit.status + ' ' + JSON.stringify(commit.data));
const commit2 = await api(disp, 'POST', `/planning/runs/${run.id}/commit`, { clientEventId: commitId });
check(commit2.status === 200 && commit2.data.replayed, 'gửi lại cùng mã trả kết quả cũ, không tạo chuyến trùng');
const commit3 = await api(disp, 'POST', `/planning/runs/${run.id}/commit`, { clientEventId: randomUUID() });
check(commit3.status === 409, 'giao lại bản nháp đã giao bị từ chối');
const tripIds = commit.data.tripIds;

const trips = (await api(disp, 'GET', '/trips?status=active')).data.trips;
check(trips.length === tripIds.length && trips.every(t => t.status === 'assigned'), `${trips.length} chuyến ở trạng thái đã giao`);
const byDriver = {};
for (const [u, tok] of Object.entries(drv)) {
  const cur = (await api(tok, 'GET', '/driver/current-trip')).data.trip;
  if (cur) byDriver[u] = cur;
}
console.log('     Driver có chuyến:', Object.keys(byDriver).join(', '));
const [uA, uB, uC] = Object.keys(byDriver);
const tA = byDriver[uA];
const tB = byDriver[uB];
check((await api(drv[uB], 'GET', `/driver/trips/${tA.id}`)).status === 403, 'Driver không xem được chuyến của Driver khác');
check((await api(drv[uB], 'POST', `/driver/trips/${tA.id}/start`, { clientEventId: randomUUID(), checkedOrderIds: tA.stops.map(s => s.order.id) })).status === 403, 'Driver không bắt đầu được chuyến của người khác');

console.log('Driver: bắt đầu chuyến');
const miss = await api(drv[uB], 'POST', `/driver/trips/${tB.id}/start`, { clientEventId: randomUUID(), checkedOrderIds: tB.stops.slice(1).map(s => s.order.id) });
check(miss.status === 409 && miss.data.error.details.missingOrderIds.length === 1, 'hàng thiếu thì không cho xuất phát');
const dash = (await api(disp, 'GET', '/dashboard')).data;
check(dash.todo.some(x => x.type === 'loading_mismatch'), 'Dispatcher thấy cảnh báo hàng không khớp');

console.log('Dispatcher: thu hồi chuyến chưa xuất phát');
const tBd = (await api(disp, 'GET', `/trips/${tB.id}`)).data.trip;
const rv = await api(disp, 'POST', `/trips/${tB.id}/revoke`, { clientEventId: randomUUID(), stateVersion: tBd.stateVersion, goodsReturned: true });
check(rv.status === 200 && rv.data.trip.status === 'revoked', 'thu hồi chuyến');
check((await api(drv[uB], 'POST', `/driver/trips/${tB.id}/start`, { clientEventId: randomUUID(), checkedOrderIds: tB.stops.map(s => s.order.id) })).status === 409, 'chuyến đã thu hồi không bắt đầu được');
const pend = (await api(disp, 'GET', '/orders?status=pending')).data.orders;
check(tB.stops.every(s => pend.some(o => o.id === s.order.id)), 'đơn của chuyến thu hồi trở về chờ xếp');

const startId = randomUUID();
const st = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/start`, { clientEventId: startId, checkedOrderIds: tA.stops.map(s => s.order.id) });
check(st.status === 200 && st.data.trip.status === 'in_progress', 'bắt đầu chuyến');
const st2 = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/start`, { clientEventId: startId, checkedOrderIds: tA.stops.map(s => s.order.id) });
check(st2.status === 200, 'gửi lại lệnh bắt đầu với cùng mã vẫn trả kết quả đã lưu');
const tAd = (await api(disp, 'GET', `/trips/${tA.id}`)).data.trip;
check((await api(disp, 'POST', `/trips/${tA.id}/revoke`, { clientEventId: randomUUID(), stateVersion: tAd.stateVersion, goodsReturned: true })).status === 409, 'chuyến đã xuất phát không thu hồi được');

console.log('Driver: vị trí và kết quả giao');
const pos = (lat, lon, t = new Date()) => api(drv[uA], 'POST', `/driver/trips/${tA.id}/positions`, { clientEventId: randomUUID(), lat, lon, observedAt: t.toISOString(), accuracyM: 8, source: 'simulator' });
check((await pos(16.0544, 108.2022)).status === 204, 'gửi vị trí');
await pos(16.0, 108.0, new Date(Date.now() - 120_000));
let cur = (await api(drv[uA], 'GET', '/driver/current-trip')).data.trip;
check(Math.abs(cur.position.lat - 16.0544) < 1e-6, 'vị trí cũ đến muộn không thay vị trí mới');
const stops = cur.stops;
const s1 = stops[0];
const aId = randomUUID();
const a1 = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s1.id}/attempts`, { clientEventId: aId, result: 'delivered' });
check(a1.status === 201, 'giao thành công điểm 1');
const a1b = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s1.id}/attempts`, { clientEventId: aId, result: 'delivered' });
check(a1b.status === 200 && a1b.data.replayed, 'gửi lại cùng mã không tạo kết quả thứ hai');
const a1c = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s1.id}/attempts`, { clientEventId: aId, result: 'failed', reason: 'Vắng nhà' });
check(a1c.status === 409, 'cùng mã khác nội dung bị báo xung đột');
const a1d = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s1.id}/attempts`, { clientEventId: randomUUID(), result: 'failed', reason: 'Vắng nhà' });
check(a1d.status === 409, 'điểm đã có kết quả cuối không nhận kết quả mới');
const noReason = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${stops[1].id}/attempts`, { clientEventId: randomUUID(), result: 'failed' });
check(noReason.status === 400, 'chưa giao được thì bắt buộc lý do');
const a2 = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${stops[1].id}/attempts`, { clientEventId: randomUUID(), result: 'failed', reason: 'Vắng nhà', note: 'Gọi 2 lần không nghe máy' });
check(a2.status === 201, 'ghi chưa giao được kèm lý do');
const early = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/return`, { clientEventId: randomUUID(), returnedOrderIds: [stops[1].order.id] });
check(early.status === 409, 'báo về kho khi còn điểm chưa có kết quả bị từ chối');

console.log('Dispatcher: đánh giá đổi tuyến');
await pos(stops[1].order.lat, stops[1].order.lon);
const ev0 = await api(disp, 'POST', `/trips/${tA.id}/reroute-evaluations`, {});
check(ev0.status === 201 && !ev0.data.evaluation.meetsThreshold, 'dữ liệu không đổi thì không đề xuất đổi tuyến (G = ' + ev0.data.evaluation?.savingSeconds + ')');
if (ev0.status === 201) await api(disp, 'POST', `/trips/${tA.id}/reroute-evaluations/${ev0.data.evaluation.eventId}/dismiss`, {});
console.log('     ' + execFileSync(process.execPath, ['scripts/simulate.js', 'incident', '--trip', String(tA.id), '--factor', '4'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/)[0]);
await pos(stops[1].order.lat, stops[1].order.lon);
const ev = await api(disp, 'POST', `/trips/${tA.id}/reroute-evaluations`, {});
if (stops.length - 2 >= 3) {
  check(ev.status === 201, 'đánh giá đổi tuyến: ' + JSON.stringify(ev.data).slice(0, 200));
  const e = ev.data.evaluation;
  console.log(`     T=${e.currentSeconds}s T2=${e.proposedSeconds}s G=${e.savingSeconds}s đạt ngưỡng=${e.meetsThreshold} điểm kế tiếp giữ nguyên=${e.proposedStopIds[0] === e.nextStopId}`);
  check(e.proposedStopIds[0] === e.nextStopId, 'điểm kế tiếp giữ nguyên');
  if (e.meetsThreshold) {
    const ap = await api(disp, 'POST', `/trips/${tA.id}/reroute-evaluations/${e.eventId}/approve`, {});
    check(ap.status === 200 && ap.data.trip.needsAck, 'duyệt tuyến mới, chờ Driver xác nhận');
    check((await api(disp, 'POST', `/trips/${tA.id}/reroute-evaluations`, {})).status === 409, 'chưa đánh giá thêm khi Driver chưa xác nhận');
    const ack = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/route-ack`, { clientEventId: randomUUID(), routeVersionId: ap.data.trip.routeVersion.id });
    check(ack.status === 200 && !ack.data.trip.needsAck, 'Driver xác nhận tuyến mới');
  } else {
    const ap = await api(disp, 'POST', `/trips/${tA.id}/reroute-evaluations/${e.eventId}/approve`, {});
    check(ap.status === 409, 'phương án không đạt ngưỡng không áp dụng được');
    await api(disp, 'POST', `/trips/${tA.id}/reroute-evaluations/${e.eventId}/dismiss`, {});
  }
} else {
  check(ev.status === 409, 'ít điểm thì không đánh giá');
}

console.log('Driver: hoàn tất và báo về kho');
cur = (await api(drv[uA], 'GET', '/driver/current-trip')).data.trip;
for (const s of cur.stops.filter(x => x.status === 'pending')) {
  await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s.id}/attempts`, { clientEventId: randomUUID(), result: 'delivered' });
}
const ret = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/return`, { clientEventId: randomUUID(), returnedOrderIds: [stops[1].order.id] });
check(ret.status === 200 && ret.data.trip.status === 'awaiting_reconciliation', 'báo về kho, chờ đối chiếu');
const busyStart = await api(drv[uA], 'GET', '/driver/current-trip');
check(busyStart.data.trip.status === 'awaiting_reconciliation', 'báo về kho chưa tự chốt chuyến');

console.log('Dispatcher: đối chiếu và chốt chuyến');
let tr = (await api(disp, 'GET', `/trips/${tA.id}`)).data.trip;
const noDec = await api(disp, 'POST', `/trips/${tA.id}/close`, { clientEventId: randomUUID(), stateVersion: tr.stateVersion, goodsMatched: true, decisions: [] });
check(noDec.status === 409, 'thiếu quyết định cho đơn chưa giao thì chưa chốt');
const notMatched = await api(disp, 'POST', `/trips/${tA.id}/close`, { clientEventId: randomUUID(), stateVersion: tr.stateVersion, goodsMatched: false, decisions: [{ orderId: stops[1].order.id, decision: 'requeue' }] });
check(notMatched.status === 409, 'hàng chưa khớp thì chưa chốt');
const close = await api(disp, 'POST', `/trips/${tA.id}/close`, { clientEventId: randomUUID(), stateVersion: tr.stateVersion, goodsMatched: true, decisions: [{ orderId: stops[1].order.id, decision: 'requeue' }] });
check(close.status === 200 && close.data.trip.status === 'closed', 'chốt chuyến');
const o2 = (await api(disp, 'GET', `/orders/${stops[1].order.id}`)).data.order;
check(o2.status === 'pending', 'đơn chưa giao được trở về chờ xếp sau khi chốt');
const hist = (await api(drv[uA], 'GET', '/driver/trips')).data.trips;
check(hist.some(h => h.id === tA.id && h.status === 'closed'), 'Driver xem lại chuyến đã chốt');
const opt2 = (await api(disp, 'GET', '/planning/options')).data;
check(!opt2.vehicles.find(v => v.id === tA.vehicle.id).problem, 'xe và Driver được giải phóng sau khi chốt');

console.log(fails ? `\n${fails} kiểm tra thất bại` : '\nTất cả kiểm tra đạt');
process.exitCode = fails ? 1 : 0;
