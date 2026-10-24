// Công cụ mô phỏng cho thử nghiệm và demo (mục 4.2.4). Không dùng trong vận hành thật.
//
//   npm run simulate -- drive --trip 3 [--speed 1]
//     Cho xe của chuyến 3 chạy theo đường đi của tuyến hiện hành và ghi vị trí mỗi giây (nguồn simulator).
//     Xe dừng ở điểm kế tiếp cho đến khi Driver ghi kết quả trên ứng dụng, rồi chạy tiếp.
//
//   npm run simulate -- incident --trip 3 [--factor 3]
//     Tạo một đợt ma trận "sự cố giả định": chặng từ điểm kế tiếp tới điểm sau nó (theo tuyến hiện hành) bị ùn tắc,
//     chậm đi --factor lần. Đợt này được đánh dấu scenario = incident, không dùng cho các chỉ số trên dữ liệu thật.
//
//   npm run simulate -- demo --trip 3[,1,2]|active [--speed 1] [--jam-at 3] [--factor 3] [--no-jam]
//                            [--fail 0.1] [--defer 1] [--seed 1]
//     Chạy trọn các chuyến: Driver bắt đầu chuyến, xe chạy theo đường đi, giao từng điểm. Khoảng --fail (10%) số điểm
//     chưa giao được với một lý do tài xế chọn. --defer khách (mặc định 1) mở đường dẫn theo dõi đơn và chọn "giao sau"
//     giờ dự kiến của mình 20 phút: hệ thống tự sắp lại tuyến (không kịp trong ca thì đơn về chờ xếp). Chuyến đầu danh sách
//     gặp ùn tắc ở điểm thứ --jam-at (mặc định là điểm có chặng phía sau dài nhất; --no-jam để bỏ), kiểm tra đổi tuyến
//     định kỳ của Backend tự đổi tuyến. Công cụ đóng vai thiết bị Driver tự nhận tuyến mới. Về tới kho thì Driver gửi báo cáo
//     về kho. --trip active chạy mọi chuyến đang chờ xuất phát hoặc đang giao.
//
//   npm run simulate -- prepare [--orders 12] [--shift-end 18:00]
//     Chuẩn bị một lượt demo mới mà không xóa dữ liệu: chốt các chuyến đã về kho, tạo --orders đơn mới trên các điểm giao
//     của kịch bản 60 đơn, lập kế hoạch với mọi xe sẵn sàng (ca bắt đầu bây giờ) và giao chuyến.
//
// Giờ chạy: chỉ chạy trong 07:00–21:00 giờ địa phương, thêm --force để chạy ngoài giờ đó.
// Thời gian: --speed 1 (mặc định) thì xe chạy mỗi chặng đúng thời gian theo dữ liệu giao thông, dừng và giao đúng thời gian
// phục vụ, chờ giờ khách hẹn; vị trí ghi mỗi giây dọc đường đi của tuyến, nên giờ trên màn hình khớp với xe (dùng để chụp màn
// hình). --speed N > 1 tua nhanh N lần: mỗi giây đồng hồ xe đi quãng đường của N giây, dừng và chờ ngắn đi N lần, nhưng vị trí
// và kết quả vẫn ghi theo giờ đồng hồ thật, nên giờ dự kiến trên màn hình (theo giao thông thật) chậm hơn xe N lần.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pool, query } from '../src/db.js';
import { config } from '../src/config.js';
import { clockText, nextClock, roundUp, secondsOfDay } from '../src/services/clock.js';
import { customerDefer } from '../src/services/customer.js';
import { haversineM, locationKey, pointKey, storedTravel } from '../src/services/matrix.js';
import { loadVehicles, prepareSnapshot, runPlanning, vehicleProblem } from '../src/services/planning.js';
import { hasKey, routeGeometry } from '../src/services/tomtom.js';
import {
  acknowledgeRoute, closeTrip, commitPlan, loadTrip, periodicRerouteCheck, recordAttempt, returnTrip, startTrip,
} from '../src/services/trips.js';

const args = process.argv.slice(2);
const command = args[0];
const has = name => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const optText = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const tripArg = has('trip') ? args[args.indexOf('--trip') + 1] ?? '' : '';
let tripIds = tripArg.split(',').map(Number).filter(Number.isInteger);
if (!['drive', 'incident', 'demo', 'prepare'].includes(command) || (command !== 'prepare' && tripArg !== 'active' && !tripIds.length)) {
  console.log('Cách dùng: npm run simulate -- drive --trip <mã chuyến> [--speed 1]');
  console.log('           npm run simulate -- incident --trip <mã chuyến> [--factor 3]');
  console.log('           npm run simulate -- demo --trip <mã chuyến>[,<mã chuyến>…]|active [--speed 1] [--jam-at 3] [--factor 3] [--no-jam] [--fail 0.1] [--defer 1] [--seed 1]');
  console.log('           npm run simulate -- prepare [--orders 12] [--shift-end HH:MM]');
  console.log('Thêm --force để chạy ngoài 07:00–21:00.');
  process.exit(1);
}
// Giờ giao hàng: không tạo chuyến hay chạy xe giả lập lúc đêm khuya, trừ khi chủ động thêm --force
const hour = secondsOfDay(new Date()) / 3600;
if ((hour < 7 || hour >= 21) && !has('force')) {
  console.error(`Bây giờ là ${clockText(new Date())}, ngoài giờ chạy mô phỏng 07:00–21:00. Thêm --force nếu vẫn muốn chạy.`);
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TICK_MS = 1000;
const speed = Math.max(1, opt('speed', 1));
const DRIVER_REASONS = ['Vắng nhà', 'Không liên lạc được', 'Sai địa chỉ', 'Khách từ chối nhận'];
const DEFAULT_KMH = { motorcycle: 25, truck: 20 };

// Số ngẫu nhiên lặp lại được theo --seed (mulberry32)
let seed = opt('seed', 1) >>> 0;
const random = () => {
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

async function writePosition(tripId, p) {
  await query(
    `INSERT INTO vehicle_positions (trip_id, latitude, longitude, observed_at, accuracy_m, source, client_event_id)
     VALUES ($1, $2, $3, now(), 5, 'simulator', $4)`, [tripId, p.lat.toFixed(6), p.lon.toFixed(6), randomUUID()]);
}

/** Người dùng đóng vai Driver của chuyến. */
async function actors(trip) {
  const driver = (await query(
    `SELECT u.id, u.role, d.id AS driver_id FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = $1`, [trip.driver.id])).rows[0];
  return { driver };
}

/**
 * Đường xe sẽ chạy từ vị trí hiện tại tới điểm đích: cắt từ đường đi của tuyến hiện hành (GeoJSON, kinh độ trước),
 * bắt đầu từ đỉnh gần xe nhất và kết thúc ở đỉnh gần đích nhất phía sau đó. Không có đường đi thì chạy thẳng.
 */
function pathTo(geometry, here, target) {
  const coords = geometry?.coordinates;
  if (!coords?.length) return [here, target];
  const nearest = (p, from) => {
    let best = { i: -1, d: Infinity };
    for (let i = from; i < coords.length; i++) {
      const d = haversineM({ lat: coords[i][1], lon: coords[i][0] }, p);
      if (d < best.d) best = { i, d };
    }
    return best;
  };
  const s = nearest(here, 0);
  const e = nearest(target, s.i);
  if (s.d > 300 || e.d > 300 || e.i < s.i) return [here, target];
  return [here, ...coords.slice(s.i, e.i + 1).map(([lon, lat]) => ({ lat, lon })), target];
}

const pathLength = path => path.reduce((s, p, i) => (i ? s + haversineM(path[i - 1], p) : 0), 0);

/**
 * Đi dọc path với vận tốc mps (m/giây theo thời gian mô phỏng), mỗi giây đồng hồ đi mps × speed mét dọc đường đi
 * (lấy mẫu trên chính đường gấp khúc nên vị trí bám theo đường) và ghi một vị trí. onTick trả về true thì dừng sớm.
 */
async function follow(tripId, path, mps, onTick) {
  let pos = { ...path[0] };
  let i = 1;
  const step = mps * speed * (TICK_MS / 1000);
  while (i < path.length) {
    let left = step;
    while (i < path.length && left > 0) {
      const d = haversineM(pos, path[i]);
      if (d <= left) { left -= d; pos = { ...path[i] }; i++; }
      else {
        const k = left / d;
        pos = { lat: pos.lat + (path[i].lat - pos.lat) * k, lon: pos.lon + (path[i].lon - pos.lon) * k };
        left = 0;
      }
    }
    await writePosition(tripId, pos);
    await sleep(TICK_MS);
    if (await onTick?.()) return { pos, interrupted: true };
  }
  return { pos, interrupted: false };
}

/** Đứng yên tại chỗ trong `seconds` giây mô phỏng (chia cho --speed), vẫn ghi vị trí để vị trí không bị cũ. */
async function hold(tripId, pos, seconds) {
  for (let t = 0; t < (seconds * 1000) / speed; t += TICK_MS) {
    await writePosition(tripId, pos);
    await sleep(TICK_MS);
  }
}

/** Vận tốc chặng tới đích: chạy hết đường đi đúng thời gian chặng theo dữ liệu giao thông lúc này. */
async function legSpeed(trip, fromKey, to, length) {
  const profile = trip.vehicle.profile;
  const travel = await storedTravel([fromKey, to.key], [profile]);
  const seconds = fromKey ? travel(profile, fromKey, to.key, secondsOfDay(new Date())) : null;
  if (seconds > 0 && length > 0) return length / seconds;
  return DEFAULT_KMH[profile] / 3.6;
}

async function createIncident(tripId, factor) {
  const trip = await loadTrip(tripId);
  if (!trip || trip.status !== 'in_progress') throw new Error('Chỉ tạo sự cố cho chuyến đang giao');
  const remaining = trip.stops.filter(s => s.status === 'pending');
  const key = s => locationKey(s.order.lat, s.order.lon);
  const distinct = [...new Set(remaining.map(key))];
  if (distinct.length < 3) throw new Error('Cần ít nhất 3 điểm giao chưa giao');
  const profile = trip.vehicle.profile;
  const keys = [pointKey('d', trip.depot.id, trip.depot.lat, trip.depot.lon), ...distinct];
  // Lấy thời gian gốc lúc này (phụ thuộc giờ), bỏ qua các đợt sự cố trước để tạo sự cố nhiều lần không bị nhân dồn
  const travel = await storedTravel(keys, [profile], { withIncident: false });
  const now = secondsOfDay(new Date());
  const from = distinct[0];
  const slow = distinct[1];
  const at = k => remaining.find(s => key(s) === k).order.code;
  const text = `đường ${at(from)} → ${at(slow)} chậm ${factor} lần`;
  const { rows } = await query(
    `INSERT INTO matrix_batches (profile_snapshot, completed_at, data_source, status)
     VALUES ($1, now(), 'mock', 'completed') RETURNING id`,
    [{ profile, scenario: 'incident', note: `Sự cố giả định: ${text}`, tripId }]);
  let n = 0;
  for (const a of keys) for (const b of keys) {
    if (a === b) continue;
    const t = travel(profile, a, b, now);
    if (t == null) continue;
    await query(
      `INSERT INTO matrix_entries (batch_id, origin_key, destination_key, travel_seconds, distance_m, status) VALUES ($1, $2, $3, $4, NULL, 'ok')`,
      [rows[0].id, a, b, Math.round(a === from && b === slow ? t * factor : t)]);
    n++;
  }
  return { batchId: rows[0].id, legs: n, text };
}

async function incident() {
  const r = await createIncident(tripIds[0], opt('factor', 3));
  console.log(`Đã tạo đợt ma trận ${r.batchId} (${r.legs} chặng): ${r.text}.`);
  console.log('Kiểm tra đổi tuyến định kỳ của Backend sẽ xét chuyến này ở chu kỳ kế tiếp.');
}

/**
 * Chờ hệ thống tự đổi tuyến sau khi có ùn tắc. Kiểm tra định kỳ của Backend thường đổi tuyến trong một chu kỳ;
 * nếu Backend tắt kiểm tra định kỳ thì sau 20 giây công cụ tự chạy một lần kiểm tra như Backend.
 * Trả về lần đổi tuyến, hoặc null nếu hệ thống giữ tuyến hiện hành.
 */
async function waitReplan(tripId, version, pos, log) {
  for (let waited = 0; waited < 60_000; waited += TICK_MS) {
    const trip = await loadTrip(tripId);
    if (trip.routeVersion?.id !== version) return trip.lastReplan;
    if (waited === 20_000) {
      log('Backend chưa đổi tuyến (kiểm tra định kỳ đang tắt?), tự chạy một lần kiểm tra');
      const r = (await periodicRerouteCheck().catch(err => [{ tripId, outcome: 'kept', reason: err.message }])).find(x => x.tripId === tripId);
      if (r && r.outcome !== 'applied') { log(`giữ tuyến hiện hành: ${r.reason}`); return null; }
    }
    await writePosition(tripId, pos);
    await sleep(TICK_MS);
  }
  return null;
}

/** Khách mở đường dẫn theo dõi đơn và chọn "giao sau" giờ dự kiến của mình 20 phút (làm tròn lên 5 phút). */
async function customersDefer(trips, count, log) {
  const candidates = [];
  for (const trip of trips) {
    const pending = trip.stops.filter(s => s.status === 'pending' && s.eta).sort((a, b) => a.seq - b.seq);
    // Lấy trong nửa sau của tuyến để xe còn kịp sắp lại
    candidates.push(...pending.slice(Math.ceil(pending.length / 2)).map(s => ({ trip, stop: s })));
  }
  for (let k = 0; k < count && candidates.length; k++) {
    const [{ trip, stop }] = candidates.splice(Math.floor(random() * candidates.length), 1);
    const time = clockText(roundUp(new Date(new Date(stop.eta).getTime() + 20 * 60_000), 5));
    const token = (await query('SELECT tracking_token FROM orders WHERE id = $1', [stop.order.id])).rows[0].tracking_token;
    try {
      const view = await customerDefer(token, time);
      const outcome = view.status === 'pending' ? 'không kịp trong ca, đơn về chờ xếp ca sau' : `hệ thống sắp lại tuyến, dự kiến ${view.eta ? clockText(view.eta.from) : '—'}`;
      log(`${trip.code}: khách đơn ${stop.order.code} hẹn giao sau ${time}, ${outcome}`);
    } catch (err) {
      log(`${trip.code}: khách đơn ${stop.order.code} không hẹn được: ${err.message}`);
    }
  }
}

async function runTrip(tripId, { jamAt: jamOpt, factor, lead, failRate }) {
  let jamAt = jamOpt;
  let trip = await loadTrip(tripId);
  if (!trip) throw new Error(`Không tìm thấy chuyến ${tripId}`);
  const log = msg => console.log(`${new Date().toLocaleTimeString('vi-VN')} ${trip.code} ${msg}`);
  const { driver } = await actors(trip);
  if (trip.status === 'assigned') {
    await startTrip(tripId, driver, { checkedOrderIds: trip.stops.map(s => s.order.id), clientEventId: randomUUID(), fp: 'simulator' });
    log('Driver kiểm đủ hàng và bắt đầu chuyến');
  }
  const dKey = pointKey('d', trip.depot.id, trip.depot.lat, trip.depot.lon);
  let here = null;
  let fromKey = null;
  const filled = new Set();
  let jammed = !lead || has('no-jam');
  if (!jammed && !jamAt) {
    // Chọn điểm có chặng phía sau dài nhất, còn ít nhất 3 điểm tính từ điểm đó, để đoạn ùn tắc thấy rõ trên bản đồ
    const ordered = [...trip.stops].sort((a, b) => a.seq - b.seq);
    let best = -1;
    for (let i = 1; i + 2 < ordered.length; i++) {
      const d = haversineM(ordered[i].order, ordered[i + 1].order);
      if (best < 0 || d > haversineM(ordered[best].order, ordered[best + 1].order)) best = i;
    }
    jamAt = best >= 0 ? ordered[best].seq : 0;
    jammed = !jamAt;
    if (jamAt) log(`sẽ gặp ùn tắc sau điểm ${jamAt}`);
  }
  while (true) {
    trip = await loadTrip(tripId);
    if (trip.status !== 'in_progress') { log(`ở trạng thái ${trip.status}, dừng mô phỏng`); return; }
    here ??= trip.position ? { lat: trip.position.lat, lon: trip.position.lon } : { lat: trip.depot.lat, lon: trip.depot.lon };
    fromKey ??= trip.position ? null : dKey;
    if (trip.needsAck) {
      // Như ứng dụng Driver: lần tải chuyến kế tiếp thấy phiên bản tuyến mới thì tự gửi đã nhận, Driver không bấm gì
      await hold(tripId, here, 3 * speed);
      await acknowledgeRoute(tripId, driver, { routeVersionId: trip.routeVersion.id, clientEventId: randomUUID(), fp: 'simulator' });
      log(`thiết bị Driver đã nhận tuyến phiên bản ${trip.routeVersion.versionNo}`);
      continue;
    }
    // Tuyến mới vừa đổi có thể chưa có đường đi (Backend lấy đường đi sau khi ghi), chờ thêm tối đa 10 giây
    if (!trip.routeVersion?.geometry && trip.routeVersion?.reason !== 'initial') {
      for (let i = 0; i < 10 && !trip.routeVersion.geometry; i++) { await hold(tripId, here, speed); trip = await loadTrip(tripId); }
    }
    // Tuyến không lấy được đường đi lúc lập kế hoạch thì lấy bổ sung một lần, để xe chạy theo đường thật
    if (trip.routeVersion && !trip.routeVersion.geometry && !filled.has(trip.routeVersion.id)) {
      filled.add(trip.routeVersion.id);
      const pts = [here, ...trip.stops.filter(s => s.status === 'pending').map(s => s.order), trip.depot];
      const g = await routeGeometry(pts, trip.vehicle.profile).catch(() => null);
      if (g) {
        await query('UPDATE route_versions SET geometry = $2 WHERE id = $1', [trip.routeVersion.id, g]);
        trip = await loadTrip(tripId);
        log('đã bổ sung đường đi cho tuyến hiện hành');
      }
    }
    const next = trip.stops.find(s => s.id === trip.nextStopId);
    const target = next
      ? { lat: next.order.lat, lon: next.order.lon, key: locationKey(next.order.lat, next.order.lon) }
      : { lat: trip.depot.lat, lon: trip.depot.lon, key: dKey };
    const version = trip.routeVersion?.id;
    if (haversineM(here, target) > 5) {
      const path = pathTo(trip.routeVersion?.geometry, here, target);
      const mps = await legSpeed(trip, fromKey, target, pathLength(path));
      log(next ? `chạy tới điểm ${next.seq} ${next.order.code} (${Math.round(pathLength(path))} m, ${Math.round(mps * 3.6)} km/h)` : 'quay về kho');
      let ticks = 0;
      const moved = await follow(tripId, path, mps, async () => {
        if (++ticks % 3) return false;
        const t = await loadTrip(tripId);
        return t.routeVersion?.id !== version || t.needsAck;
      });
      here = moved.pos;
      // Bị ngắt giữa đường (tuyến vừa đổi): chặng tiếp theo xuất phát từ vị trí xe, không có khóa ma trận
      fromKey = moved.interrupted ? null : target.key;
      if (moved.interrupted) continue;
    }
    if (!next) {
      await hold(tripId, here, 3 * speed);
      const failed = trip.stops.filter(s => s.status === 'failed').map(s => s.order.id);
      await returnTrip(tripId, driver, { returnedOrderIds: failed, clientEventId: randomUUID(), fp: 'simulator' });
      log(`đã về kho, Driver gửi báo cáo về kho${trip.removedStops?.length ? ` (mang về ${trip.removedStops.length} kiện khách hẹn lại)` : ''}`);
      return;
    }

    const doneCount = trip.stops.filter(s => s.status !== 'pending').length;
    if (!jammed && doneCount + 1 >= jamAt) {
      jammed = true;
      const r = await createIncident(tripId, factor).catch(err => ({ error: err.message }));
      if (r.error) { log(`không tạo được ùn tắc: ${r.error}`); continue; }
      log(`ÙN TẮC phía trước: ${r.text}`);
      const p = await waitReplan(tripId, version, here, log);
      if (p) log(`hệ thống đã đổi sang tuyến phiên bản ${p.toVersion}, tiết kiệm ${Math.round(p.savingSeconds / 60)} phút`);
      else log('hệ thống giữ tuyến hiện hành');
      continue;   // thiết bị nhận tuyến mới rồi giao điểm đang đứng
    }
    // Khách hẹn giờ: đến sớm thì chờ tới giờ hẹn
    const waitSeconds = next.order.notBeforeAt ? (new Date(next.order.notBeforeAt) - Date.now()) / 1000 : 0;
    if (waitSeconds > 0) {
      log(`chờ khách hẹn ${clockText(next.order.notBeforeAt)} (${Math.round(waitSeconds / 60)} phút)`);
      await hold(tripId, here, waitSeconds);
      continue;
    }
    // Thời gian phục vụ: dừng xe một lần cho cả điểm, giao từng đơn
    const atPoint = trip.stops.filter(s => s.status === 'pending' && locationKey(s.order.lat, s.order.lon) === target.key);
    const prevKey = trip.stops.filter(s => s.status !== 'pending').sort((a, b) => new Date(b.attempt.occurredAt) - new Date(a.attempt.occurredAt))[0];
    const newPoint = !prevKey || locationKey(prevKey.order.lat, prevKey.order.lon) !== target.key;
    await hold(tripId, here, (newPoint ? trip.service.stopSeconds : 0) + trip.service.serviceSeconds);
    const fail = random() < failRate;
    const reason = DRIVER_REASONS[Math.floor(random() * DRIVER_REASONS.length)];
    await recordAttempt(tripId, next.id, driver, {
      ...(fail ? { result: 'failed', reason } : { result: 'delivered' }), occurredAt: new Date().toISOString(), clientEventId: randomUUID(), fp: 'simulator',
    });
    log(fail ? `chưa giao được điểm ${next.seq} ${next.order.code}: ${reason}` : `giao thành công điểm ${next.seq} ${next.order.code}`);
    if (atPoint.length > 1) log(`còn ${atPoint.length - 1} đơn cùng điểm giao`);
  }
}

async function drive() {
  const tripId = tripIds[0];
  let here = null;
  let fromKey = null;
  console.log(`Mô phỏng chuyến ${tripId}, tốc độ ×${speed}. Ctrl + C để dừng.`);
  while (true) {
    const trip = await loadTrip(tripId);
    if (!trip) throw new Error('Không tìm thấy chuyến');
    if (trip.status === 'assigned') { console.log('Chờ Driver bắt đầu chuyến…'); await sleep(3000); continue; }
    if (trip.status !== 'in_progress') { console.log(`Chuyến ở trạng thái ${trip.status}, dừng mô phỏng.`); return; }
    const dKey = pointKey('d', trip.depot.id, trip.depot.lat, trip.depot.lon);
    here ??= trip.position ? { lat: trip.position.lat, lon: trip.position.lon } : { lat: trip.depot.lat, lon: trip.depot.lon };
    fromKey ??= trip.position ? null : dKey;
    const next = trip.stops.find(s => s.id === trip.nextStopId);
    const target = next
      ? { lat: next.order.lat, lon: next.order.lon, key: locationKey(next.order.lat, next.order.lon) }
      : { lat: trip.depot.lat, lon: trip.depot.lon, key: dKey };
    if (haversineM(here, target) > 15) {
      const version = trip.routeVersion?.id;
      const path = pathTo(trip.routeVersion?.geometry, here, target);
      const mps = await legSpeed(trip, fromKey, target, pathLength(path));
      let ticks = 0;
      const moved = await follow(tripId, path, mps, async () =>
        ++ticks % 3 === 0 && (await loadTrip(tripId)).routeVersion?.id !== version);
      here = moved.pos;
      fromKey = moved.interrupted ? null : target.key;
      continue;
    }
    if (!next) { console.log('Xe đã về kho. Driver gửi báo cáo về kho trên ứng dụng.'); return; }
    await hold(tripId, here, 3 * speed);   // chờ Driver ghi kết quả điểm đang đứng
  }
}

async function demo() {
  const settings = { jamAt: opt('jam-at', 0), factor: opt('factor', 3), failRate: Math.min(1, Math.max(0, opt('fail', 0.1))) };
  if (tripArg === 'active') {
    // Chuyến còn nhiều điểm nhất đi đầu để có đủ điểm cho ùn tắc và đổi tuyến
    const { rows } = await query(
      `SELECT t.id FROM trips t JOIN trip_stops s ON s.trip_id = t.id WHERE t.status IN ('assigned', 'in_progress')
        GROUP BY t.id ORDER BY count(*) FILTER (WHERE s.status = 'pending') DESC, t.id`);
    tripIds = rows.map(r => r.id);
    if (!tripIds.length) throw new Error('Không có chuyến nào đang chờ xuất phát hoặc đang giao, chạy prepare trước');
  }
  console.log(`Demo chuyến ${tripIds.join(', ')}, tốc độ ×${speed}${has('no-jam') ? '' : `, chuyến ${tripIds[0]} sẽ gặp ùn tắc`}. Ctrl + C để dừng.`);
  // Khách hẹn giờ sau khi các chuyến đã xuất phát và có giờ dự kiến
  const deferring = (async () => {
    const count = opt('defer', 1);
    if (!count) return;
    await sleep(15_000);
    const trips = [];
    for (const id of tripIds) {
      const t = await loadTrip(id);
      if (t?.status === 'in_progress') trips.push(t);
    }
    await customersDefer(trips, count, msg => console.log(`${new Date().toLocaleTimeString('vi-VN')} ${msg}`));
  })();
  // Chờ mọi chuyến chạy xong (kể cả khi một chuyến lỗi) rồi mới đóng kết nối cơ sở dữ liệu
  const outcomes = await Promise.allSettled([...tripIds.map((id, i) => runTrip(id, { ...settings, lead: i === 0 })), deferring]);
  const failed = outcomes.slice(0, tripIds.length).map((o, i) => [tripIds[i], o]).filter(([, o]) => o.status === 'rejected');
  for (const [id, o] of failed) console.error(`Chuyến ${id} dừng do lỗi: ${o.reason?.message ?? o.reason}`);
  if (failed.length) process.exitCode = 1;
}

async function prepare() {
  const dispatcher = (await query(`SELECT id, role FROM users WHERE role = 'dispatcher' AND status = 'active' ORDER BY id LIMIT 1`)).rows[0];
  // Chuyến đã xử lý hết điểm nhưng Driver chưa báo về kho (lượt demo trước bị dừng) thì báo thay Driver
  for (const { id } of (await query(`SELECT id FROM trips WHERE status = 'in_progress' ORDER BY id`)).rows) {
    const t = await loadTrip(id);
    if (t.stops.some(s => s.status === 'pending')) continue;
    const { driver } = await actors(t);
    const failed = t.stops.filter(s => s.status === 'failed').map(s => s.order.id);
    await returnTrip(id, driver, { returnedOrderIds: failed, clientEventId: randomUUID(), fp: 'simulator' });
  }
  const running = (await query(`SELECT id FROM trips WHERE status IN ('assigned', 'in_progress') ORDER BY id`)).rows;
  if (running.length) throw new Error(`Còn chuyến ${running.map(r => r.id).join(', ')} chưa về kho, chạy demo cho xong trước`);
  // Chốt các chuyến đã về kho: hàng khớp báo cáo, đơn chưa giao được chuyển sang kế hoạch sau
  for (const { id } of (await query(`SELECT id FROM trips WHERE status = 'awaiting_reconciliation' ORDER BY id`)).rows) {
    const t = await loadTrip(id);
    const decisions = t.stops.filter(s => s.status === 'failed').map(s => ({ orderId: s.order.id, decision: 'requeue' }));
    await closeTrip(id, dispatcher, { stateVersion: t.stateVersion, goodsMatched: true, decisions, clientEventId: randomUUID(), fp: 'simulator' });
    console.log(`Đã chốt chuyến ${t.code}`);
  }
  // Đơn mới trên các điểm giao của kịch bản 60 đơn, mã nối tiếp mã lớn nhất hiện có
  const scenario = JSON.parse(readFileSync(new URL('./seed-data/kich_ban_60.json', import.meta.url), 'utf8'));
  const pointOf = new Map(scenario.diem.map(d => [d.ma, d]));
  const TYPE = { xe_may: 'motorcycle', xe_tai: 'small_truck' };
  let last = Number((await query(`SELECT max(substring(code from 4)::int) AS n FROM orders WHERE code ~ '^DH-[0-9]+$'`)).rows[0].n ?? 2000);
  const orderIds = (await query(`SELECT id FROM orders WHERE status = 'pending' ORDER BY id`)).rows.map(r => r.id);
  for (const d of scenario.don.slice(0, opt('orders', 12))) {
    const p = pointOf.get(d.diem);
    const { rows } = await query(
      `INSERT INTO orders (code, recipient_name, phone, address, latitude, longitude, weight_kg, parcels)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [`DH-${++last}`, d.nguoi_nhan, d.sdt, p.dia_chi, p.lat, p.lon, d.khoi_luong_kg, d.so_kien]);
    for (const t of d.loai_xe) await query('INSERT INTO order_vehicle_types (order_id, vehicle_type) VALUES ($1, $2)', [rows[0].id, TYPE[t]]);
    orderIds.push(rows[0].id);
  }
  console.log(`Có ${orderIds.length} đơn chờ xếp`);
  // Ca bắt đầu bây giờ; hết ca lúc SHIFT_END nếu còn ít nhất 1 giờ, nếu không thì sau 3 giờ
  const now = new Date();
  const defaultEnd = nextClock(config.defaultShiftEnd, now);
  const shiftEnd = optText('shift-end', defaultEnd - now >= 3600_000 && defaultEnd - now <= 12 * 3600_000
    ? config.defaultShiftEnd : clockText(roundUp(new Date(now.getTime() + 3 * 3600_000), 30)));
  const vehicleIds = (await loadVehicles()).filter(v => !vehicleProblem(v)).map(v => v.id);
  const snapshot = await prepareSnapshot({ orderIds, vehicleIds, shiftEnd });
  const run = (await query(
    `INSERT INTO planning_runs (created_by, input_snapshot, status, client_event_id, request_fingerprint)
     VALUES ($1, $2, 'running', $3, 'simulator') RETURNING id`, [dispatcher.id, snapshot, randomUUID()])).rows[0];
  console.log(`Lập kế hoạch với ${vehicleIds.length} xe, ca ${clockText(snapshot.params.shiftStartAt)}–${shiftEnd}, ${hasKey() && config.matrixSource !== 'mock'
    ? 'lấy các chặng còn thiếu từ TomTom…' : 'chưa có khóa TomTom (hoặc nguồn mock), các chặng còn thiếu được ước lượng…'}`);
  await runPlanning(run.id, snapshot);
  const done = (await query('SELECT status, result FROM planning_runs WHERE id = $1', [run.id])).rows[0];
  if (done.status !== 'draft') throw new Error(`Lập kế hoạch không thành công: ${done.result?.error ?? done.status}`);
  if (done.result.unassigned.length) console.log(`${done.result.unassigned.length} đơn chưa xếp: ${[...new Set(done.result.unassigned.map(u => u.reason))].join('; ')}`);
  const out = await commitPlan(run.id, dispatcher, { clientEventId: randomUUID(), fp: 'simulator' });
  console.log(`Đã giao chuyến ${out.tripIds.join(', ')}. Chạy: npm run simulate -- demo --trip active`);
}

try {
  await ({ drive, incident, demo, prepare })[command]();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
