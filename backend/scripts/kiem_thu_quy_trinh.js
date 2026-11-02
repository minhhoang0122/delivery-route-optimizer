// Kiểm thử nghiệp vụ và phân quyền qua API, theo các tiêu chí chấp nhận ở Bảng 3.2 và Bảng 3.3.
// Chạy trên cơ sở dữ liệu vừa nạp mẫu (npm run seed -- --reset) khi Backend đang chạy:
//   npm run test:flow
// Phần tự đổi tuyến gọi thẳng bước kiểm tra định kỳ của Backend (cùng biến PG*), cần REROUTE_COOLDOWN_SECONDS > 0.
// Ngoài luồng chính còn kiểm tra: bỏ đơn thiếu khỏi chuyến, giao sau, kết thúc chuyến do sự cố, thất lạc, chuyển hoàn,
// tự chốt chuyến giao hết, tối đa số lần giao lại, việc cần xử lý của Dispatcher, kiểm tra dữ liệu nhập; đơn cùng điểm giao
// đi cùng xe, giờ dự kiến trong bản nháp, giao khác thứ tự (hệ thống sắp lại, điểm giao sau vẫn ghim cuối), trang theo dõi
// đơn của khách (dữ liệu tối thiểu, hẹn giờ thì sắp lại theo giờ hẹn, không kịp trong ca thì về chờ xếp, hẹn ngày khác).
// Dùng bộ dữ liệu 60 đơn của npm run seed và nguồn ma trận replay (không cần khóa TomTom).
// Biến API_BASE đổi địa chỉ Backend (mặc định http://localhost:3000/api).
// Kịch bản ghi dữ liệu thật vào cơ sở dữ liệu, chỉ chạy trên cơ sở dữ liệu thử: phải đặt FLOW_TEST_ALLOW=1
// cùng PGDATABASE/PGPORT của cơ sở dữ liệu thử (biến đặt sẵn trong môi trường được ưu tiên hơn file .env).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clockText, roundUp } from '../src/services/clock.js';
import { haversineM } from '../src/services/matrix.js';

// Kịch bản tạo tài khoản, giao chuyến và gọi công cụ mô phỏng ghi thẳng vào PostgreSQL theo cấu hình hiện tại,
// nên không chạy nếu chưa xác nhận đang dùng cơ sở dữ liệu thử
if (process.env.FLOW_TEST_ALLOW !== '1') {
  console.error('Kịch bản ghi dữ liệu vào cơ sở dữ liệu. Chỉ chạy trên cơ sở dữ liệu thử: đặt FLOW_TEST_ALLOW=1 và PGDATABASE/PGPORT của cơ sở dữ liệu thử (xem README).');
  process.exit(1);
}
const BASE = process.env.API_BASE || `http://localhost:${process.env.PORT || 3000}/api`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PW = process.env.SEED_PASSWORD;
let fails = 0;
let total = 0;
const check = (cond, msg) => { total++; console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails++; };

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
check(opt.orders.length === 60, '60 đơn chờ xếp');
// Dữ liệu mẫu có khung giờ theo giờ trong ngày (văn phòng 08:00–17:00, nhà riêng 17:00–21:00…). Kịch bản chạy ở bất kỳ giờ
// nào nên bỏ khung giờ của các đơn mẫu trước khi lập kế hoạch; phần khung giờ được kiểm tra riêng ở cuối với đơn mới
const windowed = (await api(disp, 'GET', '/orders?status=pending')).data.orders.filter(o => o.windowStart || o.windowEnd);
check(windowed.length === 21, '21 đơn mẫu có khung giờ giao');
for (const o of windowed) await api(disp, 'PUT', `/orders/${o.id}`, { ...o, windowStart: null, windowEnd: null });
check(!(await api(disp, 'GET', '/orders?status=pending')).data.orders.some(o => o.windowStart || o.windowEnd), 'bỏ khung giờ của đơn mẫu (sửa đơn qua API)');
check(opt.defaults.shiftEnd && !('maxRouteMinutes' in opt.defaults) && opt.vehicles.filter(v => !v.problem).every(v => v.capacityParcels > 0),
  'tùy chọn lập kế hoạch: giờ hết ca mặc định, không còn giới hạn thời lượng mỗi chuyến; xe có số kiện tối đa');
const ready = opt.vehicles.filter(v => !v.problem).map(v => v.id);
check(ready.length === 4, '4 xe sẵn sàng (xe 5 bảo trì)');
const badRun = await api(disp, 'POST', '/planning/runs', { clientEventId: randomUUID(), orderIds: opt.orders.map(o => o.id), vehicleIds: opt.vehicles.map(v => v.id) });
check(badRun.status === 400, 'chọn xe bảo trì bị từ chối, không lưu bản nháp');
// Ca bắt đầu bây giờ (mặc định), hết ca sau 5 giờ để khách còn hẹn giờ được trong ca
const shiftEnd = clockText(new Date(Date.now() + 5 * 3600_000));
const badShift = await api(disp, 'POST', '/planning/runs', { clientEventId: randomUUID(), orderIds: opt.orders.map(o => o.id), vehicleIds: ready, shiftEnd: '25:00' });
check(badShift.status === 400, 'giờ hết ca sai dạng bị từ chối');
const runReq = { clientEventId: randomUUID(), orderIds: opt.orders.map(o => o.id), vehicleIds: ready, shiftEnd };
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
const endAt = new Date(run.snapshot.params.shiftEndAt);
check(r.routes.every(x => new Date(x.returnAt) <= endAt) && r.unassigned.length === 0, `mọi xe về kho trước giờ hết ca ${shiftEnd}, không đơn nào chưa xếp`);
check(r.routes.every(x => x.arrivals.length === x.orderIds.length && x.arrivals.every((a, k) => a.orderId === x.orderIds[k] && new Date(a.at) < new Date(x.returnAt))),
  'bản nháp có giờ dự kiến từng đơn và giờ về kho của mỗi tuyến');
const capOf = new Map(opt.vehicles.map(v => [v.id, v]));
check(r.routes.every(x => x.loadKg <= capOf.get(x.vehicleId).capacityKg && x.loadParcels <= capOf.get(x.vehicleId).capacityParcels),
  'mỗi tuyến không vượt tải trọng và số kiện của xe');
// Đơn cùng điểm giao (cùng tọa độ) đi cùng xe và liền nhau
const pointOf = new Map(opt.orders.map(o => [o.id, `${o.lat},${o.lon}`]));
const together = [...new Set(pointOf.values())].every(pt => {
  const hits = r.routes.flatMap(x => x.orderIds.map((id, k) => ({ v: x.vehicleId, k, pt: pointOf.get(id) }))).filter(h => h.pt === pt);
  return hits.every(h => h.v === hits[0].v) && hits.map(h => h.k).sort((a, b) => a - b).every((k, i, a) => !i || k === a[i - 1] + 1);
});
check(together && r.splitPoints.length === 0, 'đơn cùng điểm giao đi cùng xe, giao liền nhau');

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
check(trips.length === tripIds.length && trips.every(t => t.status === 'assigned'), `${trips.length} chuyến chờ xuất phát`);
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
const thr = dash.thresholds;
const idleExpected = trips.filter(t => Date.now() - new Date(t.createdAt).getTime() > thr.assignedIdleMinutes * 60_000).length;
check(dash.todo.filter(x => x.type === 'not_started').length === idleExpected,
  `chuyến đã phân chưa xuất phát quá ${thr.assignedIdleMinutes} phút thì vào việc cần xử lý (${idleExpected} chuyến)`);

console.log('Dispatcher: bỏ đơn thiếu khỏi chuyến');
const missId = miss.data.error.details.missingOrderIds[0];
const tBd0 = (await api(disp, 'GET', `/trips/${tB.id}`)).data.trip;
const rmBody = { clientEventId: randomUUID(), stateVersion: tBd0.stateVersion, orderIds: [missId] };
const rm = await api(disp, 'POST', `/trips/${tB.id}/remove-orders`, rmBody);
const tBr = rm.data.trip;
check(rm.status === 200 && tBr.stops.length === tB.stops.length - 1 && !tBr.stops.some(s => s.order.id === missId)
  && tBr.routeVersion.versionNo === 2 && tBr.routeVersion.reason === 'orders_removed' && !tBr.loadingMismatch,
  'bỏ đơn thiếu: phiên bản tuyến mới không còn đơn đó, hết cảnh báo hàng thiếu');
check((await api(disp, 'GET', `/orders/${missId}`)).data.order.status === 'pending', 'đơn bị bỏ khỏi chuyến về chờ xếp');
const rmAgain = await api(disp, 'POST', `/trips/${tB.id}/remove-orders`, rmBody);
check(rmAgain.status === 200 && rmAgain.data.trip.routeVersion.versionNo === 2, 'gửi lại cùng mã không tạo thêm phiên bản tuyến');
const rmAll = await api(disp, 'POST', `/trips/${tB.id}/remove-orders`, { clientEventId: randomUUID(), stateVersion: tBr.stateVersion, orderIds: tBr.stops.map(s => s.order.id) });
check(rmAll.status === 409, 'không bỏ hết đơn khỏi chuyến (thu hồi chuyến thay vì bỏ đơn)');
const stB = await api(drv[uB], 'POST', `/driver/trips/${tB.id}/start`, { clientEventId: randomUUID(), checkedOrderIds: tBr.stops.map(s => s.order.id) });
check(stB.status === 200 && stB.data.trip.status === 'in_progress', 'tài xế kiểm đủ phần còn lại và xuất phát');

console.log('Dispatcher: thu hồi chuyến chưa xuất phát');
const tC = byDriver[uC];
const tCd = (await api(disp, 'GET', `/trips/${tC.id}`)).data.trip;
const rv = await api(disp, 'POST', `/trips/${tC.id}/revoke`, { clientEventId: randomUUID(), stateVersion: tCd.stateVersion, goodsReturned: true });
check(rv.status === 200 && rv.data.trip.status === 'revoked', 'thu hồi chuyến');
check((await api(drv[uC], 'POST', `/driver/trips/${tC.id}/start`, { clientEventId: randomUUID(), checkedOrderIds: tC.stops.map(s => s.order.id) })).status === 409, 'chuyến đã thu hồi không bắt đầu được');
const pend = (await api(disp, 'GET', '/orders?status=pending')).data.orders;
check(tC.stops.every(s => pend.some(o => o.id === s.order.id)), 'đơn của chuyến thu hồi trở về chờ xếp');

const startId = randomUUID();
const st = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/start`, { clientEventId: startId, checkedOrderIds: tA.stops.map(s => s.order.id) });
check(st.status === 200 && st.data.trip.status === 'in_progress', 'bắt đầu chuyến');
const st2 = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/start`, { clientEventId: startId, checkedOrderIds: tA.stops.map(s => s.order.id) });
check(st2.status === 200, 'gửi lại lệnh bắt đầu với cùng mã vẫn trả kết quả đã lưu');
const tAd = (await api(disp, 'GET', `/trips/${tA.id}`)).data.trip;
check((await api(disp, 'POST', `/trips/${tA.id}/revoke`, { clientEventId: randomUUID(), stateVersion: tAd.stateVersion, goodsReturned: true })).status === 409, 'chuyến đã xuất phát không thu hồi được');
check((await api(disp, 'POST', `/trips/${tA.id}/remove-orders`, { clientEventId: randomUUID(), stateVersion: tAd.stateVersion, orderIds: [tA.stops[0].order.id] })).status === 409, 'chuyến đã xuất phát không bỏ đơn được');
check((await api(disp, 'PATCH', `/vehicles/${tA.vehicle.id}/status`, { status: 'inactive' })).status === 409, 'xe đang chạy chuyến không báo bảo trì được');
const drvEdit = await api(disp, 'PUT', `/drivers/${tA.driver.id}`, { fullName: tA.driver.name, phone: tA.driver.phone, defaultVehicleId: tA.vehicle.id, status: 'inactive' });
check(drvEdit.status === 409, 'tài xế đang giữ chuyến không ngừng hoạt động được');

console.log('Driver: vị trí và kết quả giao');
const pos = (lat, lon, t = new Date(), accuracyM = 8) => api(drv[uA], 'POST', `/driver/trips/${tA.id}/positions`, { clientEventId: randomUUID(), lat, lon, observedAt: t.toISOString(), accuracyM, source: 'simulator' });
check((await pos(16.0544, 108.2022)).status === 204, 'gửi vị trí');
await pos(16.0, 108.0, new Date(Date.now() - 120_000));
check((await pos(16.1, 108.25, new Date(), 500)).status === 204, 'vị trí sai số 500 m được nhận nhưng bỏ');
let cur = (await api(drv[uA], 'GET', '/driver/current-trip')).data.trip;
check(Math.abs(cur.position.lat - 16.0544) < 1e-6, 'vị trí cũ đến muộn và vị trí sai số lớn không thay vị trí mới');
const serverNow = new Date(cur.serverTime).getTime();
const pendingNow = cur.stops.filter(s => s.status === 'pending');
check(pendingNow.every(s => s.eta && new Date(s.eta).getTime() >= serverNow - 1000) && new Date(cur.etaReturn).getTime() >= serverNow - 1000,
  'giờ dự kiến của mọi điểm và giờ về kho không ở quá khứ');
const stops = cur.stops;
const s1 = stops[0];
const before = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s1.id}/attempts`, { clientEventId: randomUUID(), result: 'delivered', occurredAt: new Date(new Date(cur.startedAt).getTime() - 600_000).toISOString() });
check(before.status === 400, 'thời điểm ghi kết quả trước lúc bắt đầu chuyến bị từ chối');
const aId = randomUUID();
const a1 = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s1.id}/attempts`, { clientEventId: aId, result: 'delivered' });
check(a1.status === 201, 'giao thành công điểm 1');
const pod = a1.data.trip.stops.find(s => s.id === s1.id).attempt;
check(Number.isInteger(pod.distanceM) && pod.farFromStop === pod.distanceM > 200, `lưu khoảng cách từ vị trí xe tới điểm giao lúc ghi (${pod.distanceM} m, đánh dấu khi quá 200 m)`);
const a1b = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s1.id}/attempts`, { clientEventId: aId, result: 'delivered' });
check(a1b.status === 200 && a1b.data.replayed, 'gửi lại cùng mã không tạo kết quả thứ hai');
const a1other = await api(drv[uB], 'POST', `/driver/trips/${tA.id}/stops/${s1.id}/attempts`, { clientEventId: aId, result: 'delivered' });
check(a1other.status === 403, 'tài xế khác gửi lại mã thao tác của chuyến không phải của mình bị từ chối');
const a1c = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s1.id}/attempts`, { clientEventId: aId, result: 'failed', reason: 'Vắng nhà' });
check(a1c.status === 409, 'cùng mã khác nội dung bị báo xung đột');
const a1d = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s1.id}/attempts`, { clientEventId: randomUUID(), result: 'failed', reason: 'Vắng nhà' });
check(a1d.status === 409, 'điểm đã có kết quả cuối không nhận kết quả mới');
const noReason = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${stops[1].id}/attempts`, { clientEventId: randomUUID(), result: 'failed' });
check(noReason.status === 400, 'chưa giao được thì bắt buộc lý do');
const incidentReason = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${stops[1].id}/attempts`, { clientEventId: randomUUID(), result: 'failed', reason: 'Sự cố xe/tài xế' });
check(incidentReason.status === 400, 'tài xế không chọn được lý do "Sự cố xe/tài xế" (chỉ điều phối viên ghi)');
const a2 = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${stops[1].id}/attempts`, { clientEventId: randomUUID(), result: 'failed', reason: 'Vắng nhà', note: 'Gọi 2 lần không nghe máy' });
check(a2.status === 201, 'ghi chưa giao được kèm lý do');
const dashF = (await api(disp, 'GET', '/dashboard')).data;
const fa = dashF.todo.find(x => x.type === 'failed_attempt' && x.stopId === stops[1].id);
check(fa && fa.phone === stops[1].order.phone && fa.reason === 'Vắng nhà', 'lần giao chưa thành công vừa xảy ra vào việc cần xử lý, kèm số điện thoại khách');
const early = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/return`, { clientEventId: randomUUID(), returnedOrderIds: [stops[1].order.id] });
check(early.status === 409, 'báo về kho khi còn điểm chưa có kết quả bị từ chối');

console.log('Hệ thống: tự đổi tuyến còn lại');
// Gọi thẳng bước kiểm tra định kỳ của Backend trên cùng cơ sở dữ liệu, không chờ chu kỳ REROUTE_CHECK_SECONDS.
// Kết quả được kiểm tra qua trạng thái chuyến, nên Backend đang chạy có tự kiểm tra cùng lúc thì kết quả vẫn như nhau
const { applyReroute, periodicRerouteCheck } = await import('../src/services/trips.js');
const { config } = await import('../src/config.js');
const view = async () => (await api(disp, 'GET', `/trips/${tA.id}`)).data.trip;
const checkNow = async () => (await periodicRerouteCheck()).find(x => x.tripId === tA.id);
const incident = factor => execFileSync(process.execPath, ['scripts/simulate.js', 'incident', '--trip', String(tA.id), '--factor', String(factor), '--force'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/)[0];
const here = () => pos(stops[1].order.lat, stops[1].order.lon);
await here();
const t0 = await view();
const c0 = await checkNow();
const t0b = await view();
check(t0b.routeVersion.id === t0.routeVersion.id && !t0b.lastReplan, `dữ liệu không đổi thì giữ tuyến hiện hành (${c0?.outcome} ${c0?.reason})`);
if (stops.length - 2 >= 3) {
  console.log('     ' + incident(10));
  await here();
  const c1 = await checkNow();
  const t1 = await view();
  const lr = t1.lastReplan;
  console.log(`     ${JSON.stringify(c1)} T=${lr?.currentSeconds}s T2=${lr?.proposedSeconds}s G=${lr?.savingSeconds}s`);
  check(t1.routeVersion.versionNo === t0.routeVersion.versionNo + 1 && t1.routeVersion.reason === 'replan' && t1.needsAck,
    'ùn tắc phía trước: hệ thống tự áp dụng tuyến mới, chờ thiết bị tài xế nhận');
  check(lr?.proposedStopIds[0] === lr?.nextStopId && t1.nextStopId === t0.nextStopId, 'điểm kế tiếp giữ nguyên');
  check(lr?.savingSeconds >= config.reroute.minSavingSeconds && lr.proposedSeconds < lr.currentSeconds && lr.slowLegs.length > 0 && !lr.received,
    'chi tiết chuyến có thời gian trước và sau, tiết kiệm, chặng chậm, chưa nhận');
  check(t1.events.some(e => e.type === 'route_replanned' && e.actorName == null), 'nhật ký ghi hệ thống đổi tuyến, không có người duyệt');
  const dashL = (await api(disp, 'GET', '/dashboard')).data;
  const lateExpected = (t1.lateSeconds ?? 0) > dashL.thresholds.lateMinutes * 60 || Boolean(t1.shiftEndAt && t1.etaReturn && new Date(t1.etaReturn) > new Date(t1.shiftEndAt));
  check(dashL.todo.some(x => x.type === 'late' && x.tripId === tA.id) === lateExpected,
    `chuyến trễ so với kế hoạch vào việc cần xử lý khi về kho dự kiến muộn hơn ${dashL.thresholds.lateMinutes} phút (trễ ${t1.lateSeconds} giây)`);
  console.log('     ' + incident(10));
  await here();
  const c2 = await checkNow();
  check((await view()).routeVersion.id === t1.routeVersion.id && c2?.reason === 'needs_ack', 'chưa đổi thêm khi thiết bị tài xế chưa nhận tuyến hiện hành');
  const again2 = await applyReroute(tA.id, lr.evaluationEventId).catch(e => e);
  check(again2?.status === 409, 'một kết quả đánh giá không áp dụng hai lần');
  const ack = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/route-ack`, { clientEventId: randomUUID(), routeVersionId: t1.routeVersion.id });
  check(ack.status === 200 && !ack.data.trip.needsAck && ack.data.trip.lastReplan?.received, 'thiết bị tài xế nhận tuyến mới');
  await here();
  const c3 = await checkNow();
  check((await view()).routeVersion.id === t1.routeVersion.id && c3?.reason === 'cooldown',
    `chưa đủ ${config.reroute.cooldownSeconds} giây sau lần đổi trước thì không đổi tuyến (${c3?.outcome} ${c3?.reason})`);
} else {
  const c1 = await checkNow();
  check(c1?.reason === 'few_stops', 'còn ít hơn 3 điểm thì không xét đổi tuyến');
}

console.log('Khách: theo dõi đơn và tự hẹn lại');
const tokenOf = async orderId => (await api(disp, 'GET', `/orders/${orderId}`)).data.order.trackingToken;
const ptOf = s => `${s.order.lat},${s.order.lon}`;
let ta = await view();
const posA = ta.position;
const pendA = ta.stops.filter(s => s.status === 'pending');
const far = s => haversineM(s.order, posA) > config.tracking.arrivingMeters + 100;
// Số điểm dừng (điểm giao khác nhau) trước một điểm trong thứ tự hiện hành
const stopsBefore = s => new Set(pendA.filter(x => x.seq < s.seq && ptOf(x) !== ptOf(s)).map(ptOf)).size;
const lateStop = pendA.find(s => stopsBefore(s) > 2);
const nearStop = pendA[0];
if (lateStop) {
  const tv = await api(null, 'GET', `/public/tracking/${await tokenOf(lateStop.order.id)}`);
  const body = JSON.stringify(tv.data);
  const ALLOWED = ['code', 'status', 'notBeforeAt', 'window', 'driverName', 'eta', 'stopsBefore', 'vehicle', 'destination', 'result', 'actions', 'updatedAt'];
  check(tv.status === 200 && Object.keys(tv.data.tracking).every(k => ALLOWED.includes(k)) && tv.data.tracking.code === lateStop.order.code
    && !body.includes(lateStop.order.phone) && !body.includes(lateStop.order.recipientName) && !body.includes(lateStop.order.address)
    && !body.includes(ta.driver.phone) && !body.includes(ta.driver.name)
    && !ta.stops.some(s => s.id !== lateStop.id && (body.includes(`"${s.order.code}"`) || body.includes(s.order.phone)))
    && tv.data.tracking.driverName === ta.driver.name.split(' ').at(-1),
  'trang theo dõi đơn chỉ có dữ liệu tối thiểu của đúng đơn: không số điện thoại, không tên, địa chỉ người nhận, không khách khác, tài xế chỉ có tên gọi');
  check(tv.data.tracking.stopsBefore === stopsBefore(lateStop) && tv.data.tracking.vehicle === null && tv.data.tracking.destination === null
    && new Date(tv.data.tracking.eta?.to) > new Date(tv.data.tracking.eta?.from) && tv.data.tracking.actions?.deferTimes.length > 0,
  `còn ${stopsBefore(lateStop)} điểm dừng trước: có khung giờ dự kiến, không hiện vị trí xe`);
}
const tvNear = (await api(null, 'GET', `/public/tracking/${await tokenOf(nearStop.order.id)}`)).data.tracking;
check(tvNear.stopsBefore <= 2 && Math.abs(tvNear.vehicle?.lat - posA.lat) < 1e-6, 'còn tối đa 2 điểm dừng trước: hiện vị trí xe');
check((await api(null, 'GET', `/public/tracking/${'0'.repeat(64)}`)).status === 404 && (await api(null, 'GET', '/public/tracking/abc')).status === 404,
  'mã theo dõi sai thì không có dữ liệu');

// Khách hẹn giao sau giờ dự kiến của điểm cuối: hệ thống tự sắp lại, đơn xuống sau, không giao trước giờ hẹn
const lastEta = Math.max(...pendA.map(s => new Date(s.eta).getTime()));
const later = clockText(roundUp(new Date(lastEta + 15 * 60_000), 30));
const X = pendA.slice(1, -1).find(s => ptOf(s) !== ptOf(pendA[0]) && far(s));
if (X) {
  const before = pendA.findIndex(s => s.id === X.id);
  const dv = await api(null, 'POST', `/public/tracking/${await tokenOf(X.order.id)}/defer`, { time: later });
  ta = await view();
  const pendA2 = ta.stops.filter(s => s.status === 'pending');
  const xs = pendA2.find(s => s.id === X.id);
  const nb = new Date(xs?.order.notBeforeAt);
  check(dv.status === 200 && clockText(nb) === later && new Date(xs.eta) >= nb - 1000 && pendA2.findIndex(s => s.id === X.id) > before
    && ta.routeVersion.reason === 'customer' && new Date(dv.data.tracking.eta?.from) >= nb - 1000,
  `khách hẹn giao sau ${later}: hệ thống tự sắp lại, đơn xuống sau, dự kiến giao không trước giờ hẹn`);
  const evC = ta.events.filter(e => e.type === 'customer_deferred').at(-1);
  check(evC?.actorName == null && evC.payload.by === 'customer' && evC.payload.outcome === 'resequenced', 'nhật ký ghi khách hàng hẹn giờ, điều phối viên và tài xế không phải thao tác');
  const dvw = (await api(drv[uA], 'GET', '/driver/current-trip')).data.trip;
  check(dvw.needsAck && dvw.stops.find(s => s.id === X.id).order.notBeforeAt, 'ứng dụng tài xế nhận tuyến mới, điểm có giờ khách hẹn');
  await api(drv[uA], 'POST', `/driver/trips/${tA.id}/route-ack`, { clientEventId: randomUUID(), routeVersionId: dvw.routeVersion.id });

  // Khách hẹn sau giờ hết ca: không kịp trong ca, đơn ra khỏi chuyến, về chờ xếp ca sau
  const Y = pendA2.slice(1).find(s => s.id !== X.id && ptOf(s) !== ptOf(pendA2[0]) && far(s));
  if (Y) {
    const dy = await api(null, 'POST', `/public/tracking/${await tokenOf(Y.order.id)}/defer`, { time: clockText(new Date(endAt.getTime() + 30 * 60_000)) });
    ta = await view();
    check(dy.status === 200 && dy.data.tracking.status === 'pending' && !ta.stops.some(s => s.id === Y.id) && ta.removedStops.some(x => x.orderId === Y.order.id)
      && (await api(disp, 'GET', `/orders/${Y.order.id}`)).data.order.status === 'pending'
      && ta.events.some(e => e.type === 'customer_deferred' && e.payload.outcome === 'requeued' && e.payload.orderId === Y.order.id),
    'khách hẹn sau giờ hết ca: đơn tự ra khỏi chuyến, về chờ xếp ca sau, tài xế thấy kiện cần mang về');
    const dvy = (await api(drv[uA], 'GET', '/driver/current-trip')).data.trip;
    if (dvy.needsAck) await api(drv[uA], 'POST', `/driver/trips/${tA.id}/route-ack`, { clientEventId: randomUUID(), routeVersionId: dvy.routeVersion.id });
  }
}

console.log('Driver: giao sau, giao khác thứ tự; Dispatcher: kết thúc chuyến do sự cố');
let vb = (await api(drv[uB], 'GET', '/driver/current-trip')).data.trip;
if (vb.stops.filter(s => s.status === 'pending').length >= 2) {
  const first = vb.nextStopId;
  const df = await api(drv[uB], 'POST', `/driver/trips/${tB.id}/stops/${first}/defer`, { clientEventId: randomUUID() });
  const left = df.data.trip?.stops.filter(s => s.status === 'pending') ?? [];
  check(df.status === 200 && left.at(-1)?.id === first && df.data.trip.nextStopId === left[0].id && df.data.trip.nextStopId !== first
    && df.data.trip.routeVersion.reason === 'deferred' && !df.data.trip.needsAck && df.data.trip.stops.find(s => s.id === first).deferred,
  'giao sau: điểm xuống cuối, điểm kế tiếp là điểm đứng sau, thiết bị đã có tuyến mới');
  const evD = (await api(disp, 'GET', `/trips/${tB.id}`)).data.trip.events.find(e => e.type === 'stop_deferred');
  check(evD && evD.actorName == null, 'nhật ký ghi hệ thống cập nhật tuyến khi giao sau, điều phối viên không phải duyệt');
  check((await api(drv[uB], 'POST', `/driver/trips/${tB.id}/stops/${first}/defer`, { clientEventId: randomUUID() })).status === 409,
    'điểm đã ở cuối tuyến thì không giao sau thêm');
  vb = df.data.trip;
  // Giao khác thứ tự: tài xế ghi kết quả cho một điểm ở cuối tuyến thay vì điểm kế tiếp. Hệ thống nhận, sắp lại các điểm
  // còn lại từ điểm vừa giao; điểm giao sau vẫn ghim cuối tuyến
  const pendB = vb.stops.filter(s => s.status === 'pending');
  const ptB = s => `${s.order.lat},${s.order.lon}`;
  const nextB = vb.stops.find(s => s.id === vb.nextStopId);
  const jump = pendB.slice(0, -1).reverse().find(s => ptB(s) !== ptB(nextB));
  if (jump && pendB.length >= 4) {
    const oo = await api(drv[uB], 'POST', `/driver/trips/${tB.id}/stops/${jump.id}/attempts`, { clientEventId: randomUUID(), result: 'delivered' });
    const tr = oo.data.trip;
    const evO = (await api(disp, 'GET', `/trips/${tB.id}`)).data.trip.events.filter(e => e.type === 'route_resequenced').at(-1);
    check(oo.status === 201 && tr.stops.find(s => s.id === jump.id).status === 'delivered' && tr.routeVersion.reason === 'out_of_order'
      && evO?.payload.trigger === 'out_of_order' && evO.actorName == null && evO.payload.routeVersionId === tr.routeVersion.id,
    'giao khác thứ tự: nhận kết quả, hệ thống tự sắp lại các điểm còn lại từ điểm vừa giao');
    check(tr.stops.filter(s => s.status === 'pending').at(-1)?.id === first, 'điểm giao sau vẫn ghim cuối tuyến sau khi sắp lại');
    vb = tr;
  }
}
const dB = await api(drv[uB], 'POST', `/driver/trips/${tB.id}/stops/${vb.nextStopId}/attempts`, { clientEventId: randomUUID(), result: 'delivered' });
check(dB.status === 201, 'giao thành công một điểm trước khi gặp sự cố');
const pendingB = dB.data.trip.stops.filter(s => s.status === 'pending').map(s => s.id);
const ab = await api(disp, 'POST', `/trips/${tB.id}/abort`, { clientEventId: randomUUID(), note: 'Xe hỏng giữa đường' });
const tBa = ab.data.trip;
check(ab.status === 200 && tBa.status === 'awaiting_reconciliation'
  && pendingB.every(id => { const s = tBa.stops.find(x => x.id === id); return s.status === 'failed' && s.attempt.reason === 'Sự cố xe/tài xế' && s.attempt.recordedByRole === 'dispatcher'; }),
'kết thúc chuyến do sự cố: điểm chưa giao thành chưa giao được, lý do "Sự cố xe/tài xế" do điều phối viên ghi');
const failedB = tBa.stops.filter(s => s.status === 'failed').map(s => s.order.id).sort();
check(tBa.returnReport?.aborted && [...tBa.returnReport.returnedOrderIds].sort().join() === failedB.join(), 'hàng mang về là mọi kiện chưa giao được');
check((await api(drv[uB], 'POST', `/driver/trips/${tB.id}/stops/${pendingB[0]}/attempts`, { clientEventId: randomUUID(), result: 'delivered' })).status === 409,
  'tài xế không ghi thêm kết quả sau khi chuyến kết thúc do sự cố');
check((await api(disp, 'GET', '/dashboard')).data.todo.some(x => x.type === 'reconcile' && x.tripId === tB.id && x.aborted), 'chuyến kết thúc do sự cố chờ đối chiếu');
const lostB = failedB[0];
const closeB = await api(disp, 'POST', `/trips/${tB.id}/close`, { clientEventId: randomUUID(), stateVersion: tBa.stateVersion, goodsMatched: true, decisions: [{ orderId: lostB, decision: 'lost' }] });
check(closeB.status === 200 && closeB.data.trip.status === 'closed', 'đối chiếu chuyến sự cố: chỉ chọn cho kiện thất lạc, còn lại tự giao lại');
const ordersB = (await api(disp, 'GET', '/orders')).data.orders;
check(ordersB.find(o => o.id === lostB).status === 'lost' && failedB.filter(id => id !== lostB).every(id => ordersB.find(o => o.id === id).status === 'pending'),
  'kiện thất lạc chuyển trạng thái Thất lạc, các kiện khác về chờ xếp');

console.log('Driver: hoàn tất và báo về kho');
cur = (await api(drv[uA], 'GET', '/driver/current-trip')).data.trip;
const sDup = cur.stops.find(x => x.status === 'pending');
const dupBody = { clientEventId: randomUUID(), result: 'delivered' };
const dup = await Promise.all([1, 2, 3, 4].map(() => api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${sDup.id}/attempts`, dupBody)));
check(dup.every(x => x.status === 200 || x.status === 201) && dup.filter(x => !x.data.replayed).length === 1,
  'nhiều lần gửi cùng mã đến đồng thời: một lần ghi, các lần sau nhận lại kết quả (' + dup.map(x => x.status).join(', ') + ')');
const tvDone = (await api(null, 'GET', `/public/tracking/${(await api(disp, 'GET', `/orders/${sDup.order.id}`)).data.order.trackingToken}`)).data.tracking;
check(tvDone.status === 'delivered' && tvDone.result?.result === 'delivered' && !tvDone.actions && !tvDone.vehicle, 'trang theo dõi đơn hiện kết quả đã giao, không còn thao tác hẹn lại');
// Điểm cuối chưa giao được và tài xế không mang kiện đó về: kiện chỉ còn quyết định Thất lạc
const restA = cur.stops.filter(x => x.status === 'pending' && x.id !== sDup.id);
const sLost = restA.at(-1);
for (const s of restA) {
  await api(drv[uA], 'POST', `/driver/trips/${tA.id}/stops/${s.id}/attempts`, s === sLost
    ? { clientEventId: randomUUID(), result: 'failed', reason: 'Khách từ chối nhận' } : { clientEventId: randomUUID(), result: 'delivered' });
}
const ret = await api(drv[uA], 'POST', `/driver/trips/${tA.id}/return`, { clientEventId: randomUUID(), returnedOrderIds: [stops[1].order.id] });
check(ret.status === 200 && ret.data.trip.status === 'awaiting_reconciliation', 'báo về kho, có kiện chưa giao được thì chờ đối chiếu');

console.log('Dispatcher: đối chiếu và chốt chuyến');
let tr = (await api(disp, 'GET', `/trips/${tA.id}`)).data.trip;
const closeA = decisions => api(disp, 'POST', `/trips/${tA.id}/close`, { clientEventId: randomUUID(), stateVersion: tr.stateVersion, goodsMatched: true, decisions });
if (sLost) {
  check((await closeA([])).status === 409, 'kiện không có trong báo cáo hàng mang về phải có quyết định');
  const requeueLost = await closeA([{ orderId: sLost.order.id, decision: 'requeue' }]);
  check(requeueLost.status === 409 && /Thất lạc/.test(requeueLost.data.error.message), 'không giao lại được kiện không có trong báo cáo hàng mang về');
  check((await closeA([{ orderId: sLost.order.id, decision: 'return_to_sender' }])).status === 409, 'không chuyển hoàn được kiện không có trong báo cáo hàng mang về');
}
const lostDecision = sLost ? [{ orderId: sLost.order.id, decision: 'lost' }] : [];
const notMatched = await api(disp, 'POST', `/trips/${tA.id}/close`, { clientEventId: randomUUID(), stateVersion: tr.stateVersion, goodsMatched: false, decisions: lostDecision });
check(notMatched.status === 409, 'hàng chưa khớp thì chưa chốt');
if (sLost) {
  const nullDec = await api(disp, 'POST', `/trips/${tA.id}/close`, { clientEventId: randomUUID(), stateVersion: tr.stateVersion, goodsMatched: true, decisions: [null] });
  check(nullDec.status === 409, 'quyết định rỗng bị bỏ qua, không lỗi máy chủ');
}
const close = await closeA(lostDecision);
check(close.status === 200 && close.data.trip.status === 'closed', 'chốt chuyến: kiện mang về không cần chọn, mặc định giao lại');
const o2 = (await api(disp, 'GET', `/orders/${stops[1].order.id}`)).data.order;
check(o2.status === 'pending', 'đơn chưa giao được đã mang về trở về chờ xếp sau khi chốt');
if (sLost) check((await api(disp, 'GET', `/orders/${sLost.order.id}`)).data.order.status === 'lost', 'kiện không mang về được ghi Thất lạc');
const hist = (await api(drv[uA], 'GET', '/driver/trips')).data.trips;
check(hist.some(h => h.id === tA.id && h.status === 'closed'), 'tài xế xem lại chuyến đã chốt');
const opt2 = (await api(disp, 'GET', '/planning/options')).data;
check(!opt2.vehicles.find(v => v.id === tA.vehicle.id).problem, 'xe và tài xế được giải phóng sau khi chốt');

const uD = Object.keys(byDriver)[3];
if (uD) {
  console.log('Hệ thống: tự chốt chuyến giao hết');
  const tD = byDriver[uD];
  // Khách hẹn ngày khác trước khi chuyến xuất phát: đơn tự ra khỏi chuyến, về chờ xếp
  const zStop = tD.stops.at(-1);
  const zToken = (await api(disp, 'GET', `/orders/${zStop.order.id}`)).data.order.trackingToken;
  const rz = await api(null, 'POST', `/public/tracking/${zToken}/reschedule`, {});
  const tDv = (await api(disp, 'GET', `/trips/${tD.id}`)).data.trip;
  check(rz.status === 200 && rz.data.tracking.status === 'pending' && !tDv.stops.some(s => s.id === zStop.id) && tDv.routeVersion.reason === 'customer'
    && tDv.events.some(e => e.type === 'customer_rescheduled' && e.payload.by === 'customer' && e.actorName == null)
    && (await api(disp, 'GET', `/orders/${zStop.order.id}`)).data.order.status === 'pending',
  'khách hẹn ngày khác: đơn tự ra khỏi chuyến, về chờ xếp, nhật ký ghi khách hàng');
  check((await api(null, 'POST', `/public/tracking/${zToken}/reschedule`, {})).status === 409, 'đơn đã ra khỏi chuyến thì không hẹn lại được nữa');
  tD.stops = tDv.stops;
  await api(drv[uD], 'POST', `/driver/trips/${tD.id}/start`, { clientEventId: randomUUID(), checkedOrderIds: tD.stops.map(s => s.order.id) });
  for (const s of tD.stops) await api(drv[uD], 'POST', `/driver/trips/${tD.id}/stops/${s.id}/attempts`, { clientEventId: randomUUID(), result: 'delivered' });
  const retD = await api(drv[uD], 'POST', `/driver/trips/${tD.id}/return`, { clientEventId: randomUUID(), returnedOrderIds: [] });
  check(retD.status === 200 && retD.data.trip.status === 'closed' && retD.data.trip.closeReport?.auto, 'giao hết, không có hàng mang về: hệ thống tự chốt chuyến');
  const evC = (await api(disp, 'GET', `/trips/${tD.id}`)).data.trip.events.find(e => e.type === 'trip_closed');
  check(evC && evC.actorName == null, 'nhật ký ghi hệ thống chốt chuyến');
  check(!(await api(disp, 'GET', '/planning/options')).data.vehicles.find(v => v.id === tD.vehicle.id).problem, 'xe và tài xế được giải phóng ngay');
}

console.log('Hệ thống: tối đa số lần giao lại');
// Đơn đã giao không thành công một lần (chuyến đầu); giao lại bằng xe và tài xế vừa giải phóng cho tới khi đạt số lần tối đa
const retryOrder = stops[1].order.id;
for (let n = 2; n <= tr.maxDeliveryAttempts; n++) {
  let rr = (await api(disp, 'POST', '/planning/runs', { clientEventId: randomUUID(), orderIds: [retryOrder], vehicleIds: [tA.vehicle.id], shiftEnd })).data.run;
  for (let i = 0; i < 60 && rr.status === 'running'; i++) {
    await new Promise(res => setTimeout(res, 300));
    rr = (await api(disp, 'GET', `/planning/runs/${rr.id}`)).data.run;
  }
  const cm = await api(disp, 'POST', `/planning/runs/${rr.id}/commit`, { clientEventId: randomUUID() });
  const tid = cm.data.tripIds?.[0];
  const tt = (await api(drv[uA], 'GET', '/driver/current-trip')).data.trip;
  await api(drv[uA], 'POST', `/driver/trips/${tid}/start`, { clientEventId: randomUUID(), checkedOrderIds: [retryOrder] });
  await api(drv[uA], 'POST', `/driver/trips/${tid}/stops/${tt.stops[0].id}/attempts`, { clientEventId: randomUUID(), result: 'failed', reason: 'Vắng nhà' });
  await api(drv[uA], 'POST', `/driver/trips/${tid}/return`, { clientEventId: randomUUID(), returnedOrderIds: [retryOrder] });
  const tv = (await api(disp, 'GET', `/trips/${tid}`)).data.trip;
  const cl = await api(disp, 'POST', `/trips/${tid}/close`, { clientEventId: randomUUID(), stateVersion: tv.stateVersion, goodsMatched: true, decisions: [] });
  if (n < tr.maxDeliveryAttempts) {
    check(cl.status === 200 && (await api(disp, 'GET', `/orders/${retryOrder}`)).data.order.status === 'pending', `lần giao thứ ${n} chưa thành công: tự giao lại`);
  } else {
    check(cl.status === 409 && tv.stops[0].order.failedAttempts === n, `lần giao thứ ${n} (tối đa) chưa thành công: điều phối viên phải quyết định`);
    const cl2 = await api(disp, 'POST', `/trips/${tid}/close`, { clientEventId: randomUUID(), stateVersion: tv.stateVersion, goodsMatched: true, decisions: [{ orderId: retryOrder, decision: 'return_to_sender' }] });
    check(cl2.status === 200 && (await api(disp, 'GET', `/orders/${retryOrder}`)).data.order.status === 'return_to_sender', 'chọn Chuyển hoàn: đơn chuyển trạng thái chuyển hoàn');
  }
}

console.log('Dispatcher: kiểm tra dữ liệu nhập');
const ok = { code: 'DH-9001', recipientName: 'Nguyễn Văn Thử', phone: '0905 123 456', address: '12 Lê Duẩn, Hải Châu, Đà Nẵng', lat: 16.07, lon: 108.22, weightKg: 2, vehicleTypes: ['motorcycle', 'small_truck'] };
check((await api(disp, 'POST', '/orders', { ...ok, phone: '028 3822 1234' })).status === 400, 'số điện thoại không phải số di động Việt Nam bị từ chối');
check((await api(disp, 'POST', '/orders', { ...ok, lat: 21.03, lon: 105.85 })).status === 400, 'vị trí ngoài khu vực phục vụ Đà Nẵng bị từ chối');
check((await api(disp, 'POST', '/orders', { ...ok, weightKg: 5000 })).status === 400, 'khối lượng vượt tải trọng lớn nhất của xe đang hoạt động bị từ chối');
check((await api(disp, 'POST', '/orders', { ...ok, weightKg: 120, vehicleTypes: ['motorcycle'] })).status === 400, 'đơn chỉ cho xe máy nặng hơn xe máy lớn nhất bị từ chối');
check((await api(disp, 'POST', '/orders', ok)).status === 201, 'đơn hợp lệ được lưu');
const dupOrder = await api(disp, 'POST', '/orders', { ...ok, code: 'DH-9002', phone: '+84905123456' });
check(dupOrder.status === 409 && dupOrder.data.error.code === 'DUPLICATE_ORDER', 'đơn trùng người nhận, địa chỉ, số điện thoại đang chờ xếp thì cảnh báo');
check((await api(disp, 'POST', '/orders', { ...ok, code: 'DH-9002', allowDuplicate: true })).status === 201, 'xác nhận vẫn lưu thì lưu đơn trùng');
check((await api(disp, 'POST', '/vehicles', { plate: '43B9-999.99', type: 'motorcycle', capacityKg: 800 })).status === 400, 'tải trọng ngoài khoảng hợp lý của loại xe bị từ chối');
check((await api(disp, 'POST', '/orders', { ...ok, code: 'DH-9003', phone: '0905 000 003', windowStart: '17:00', windowEnd: '08:00' })).status === 400, 'khung giờ có giờ bắt đầu sau giờ kết thúc bị từ chối');
check((await api(disp, 'POST', '/orders', { ...ok, code: 'DH-9003', phone: '0905 000 003', windowStart: '8h' })).status === 400, 'khung giờ sai dạng HH:MM bị từ chối');

console.log('Dispatcher: khung giờ giao');
// Hai đơn mới, lập kế hoạch với xe vừa rảnh trong ca cố định 09:00–18:00 hôm nay (không phụ thuộc giờ chạy kiểm thử):
// khung giờ kết thúc trước giờ bắt đầu ca thì chưa xếp được, khung giờ trong ca thì giao đúng khung
{
  const at = h => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const past = (await api(disp, 'POST', '/orders', { ...ok, code: 'DH-9101', phone: '0905 000 101', windowStart: '06:00', windowEnd: '08:00' })).data.order;
  const soon = (await api(disp, 'POST', '/orders', { ...ok, code: 'DH-9102', phone: '0905 000 102', lat: 16.061, lon: 108.21, windowStart: '10:00', windowEnd: '11:00' })).data.order;
  check(past?.windowEnd === '08:00' && soon?.windowStart === '10:00', 'đơn mới lưu khung giờ giao');
  let wr = (await api(disp, 'POST', '/planning/runs', { clientEventId: randomUUID(), orderIds: [past.id, soon.id], vehicleIds: [tA.vehicle.id], shiftStart: '09:00', shiftEnd: '18:00' })).data.run;
  for (let i = 0; i < 60 && wr.status === 'running'; i++) {
    await new Promise(res => setTimeout(res, 300));
    wr = (await api(disp, 'GET', `/planning/runs/${wr.id}`)).data.run;
  }
  const un = wr.result?.unassigned ?? [];
  check(un.length === 1 && un[0].orderId === past.id && un[0].reason === 'Không kịp khung giờ khách hẹn', 'khung giờ đã qua: đơn chưa xếp, lý do "Không kịp khung giờ khách hẹn"');
  const arr = wr.result?.routes.flatMap(x => x.arrivals).find(a => a.orderId === soon.id);
  check(arr && new Date(arr.at).getTime() >= at(10) - 60_000 && new Date(arr.at).getTime() <= at(11) + 60_000,
    'khung giờ trong ca: xe đến sớm thì chờ, giờ giao dự kiến nằm trong khung giờ');
  for (const o of [past, soon]) await api(disp, 'POST', `/orders/${o.id}/cancel`);
}

console.log(fails ? `\n${fails}/${total} kiểm tra thất bại` : `\nTất cả ${total} kiểm tra đạt`);
const { pool } = await import('../src/db.js');
await pool.end();
process.exitCode = fails ? 1 : 0;
