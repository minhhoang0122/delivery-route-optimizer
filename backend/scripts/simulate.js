// Công cụ mô phỏng cho thử nghiệm và demo (mục 4.2.4). Không dùng trong vận hành thật.
//
//   npm run simulate -- drive --trip 3 [--speed 4]
//     Cho xe của chuyến 3 chạy theo đường đi của tuyến hiện hành và ghi vị trí mỗi giây (nguồn simulator).
//     Xe dừng ở điểm kế tiếp cho đến khi Driver ghi kết quả trên ứng dụng, rồi chạy tiếp; --speed là hệ số tua nhanh.
//
//   npm run simulate -- incident --trip 3 [--factor 3]
//     Tạo một đợt ma trận "sự cố giả định": chặng từ điểm kế tiếp tới điểm sau nó (theo tuyến hiện hành) bị ùn tắc,
//     chậm đi --factor lần. Đợt này được đánh dấu scenario = incident, không dùng cho các chỉ số trên dữ liệu thật.
//
//   npm run simulate -- demo --trip 3[,1,2] [--speed 4] [--jam-at 3] [--factor 3] [--approve-after 8]
//     Chạy trọn một chuyến: Driver bắt đầu chuyến, xe chạy theo đường đi, giao từng điểm. Khi chuyến đầu tiên trong danh
//     sách tới điểm thứ --jam-at (mặc định là điểm có chặng phía sau dài nhất), công cụ tạo ùn tắc ở chặng phía trước; kiểm tra đổi tuyến định kỳ của Backend phát hiện
//     và tạo đề xuất, công cụ đóng vai Dispatcher duyệt sau --approve-after giây (0 là để người xem tự bấm duyệt) và
//     đóng vai Driver xác nhận tuyến mới, rồi xe chạy tiếp theo tuyến mới. Các chuyến còn lại trong danh sách chỉ chạy.
//     Về tới kho thì Driver tự gửi báo cáo về kho. --trip active chạy mọi chuyến đang chờ xuất phát hoặc đang giao.
//
//   npm run simulate -- prepare [--orders 12]
//     Chuẩn bị một lượt demo mới mà không xóa dữ liệu: chốt các chuyến đã về kho, tạo --orders đơn mới trên các địa chỉ
//     mẫu (mã mới, nên TomTom tính thêm các chặng của đơn mới), lập kế hoạch với mọi xe sẵn sàng và giao chuyến.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pool, query } from '../src/db.js';
import { cachedTravel, haversineM, pointKey } from '../src/services/matrix.js';
import { loadVehicles, prepareSnapshot, runPlanning, vehicleProblem } from '../src/services/planning.js';
import { config } from '../src/config.js';
import { hasKey, routeGeometry } from '../src/services/tomtom.js';
import {
  acknowledgeRoute, approveReroute, closeTrip, commitPlan, evaluateTripReroute, loadTrip, recordAttempt, returnTrip, startTrip,
} from '../src/services/trips.js';

const args = process.argv.slice(2);
const command = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const tripArg = args.includes('--trip') ? args[args.indexOf('--trip') + 1] ?? '' : '';
let tripIds = tripArg.split(',').map(Number).filter(Number.isInteger);
if (!['drive', 'incident', 'demo', 'prepare'].includes(command) || (command !== 'prepare' && tripArg !== 'active' && !tripIds.length)) {
  console.log('Cách dùng: npm run simulate -- drive --trip <mã chuyến> [--speed 4]');
  console.log('           npm run simulate -- incident --trip <mã chuyến> [--factor 3]');
  console.log('           npm run simulate -- demo --trip <mã chuyến>[,<mã chuyến>…]|active [--speed 4] [--jam-at 3] [--factor 3] [--approve-after 8]');
  console.log('           npm run simulate -- prepare [--orders 12]');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TICK_MS = 1000;

async function writePosition(tripId, p) {
  await query(
    `INSERT INTO vehicle_positions (trip_id, latitude, longitude, observed_at, accuracy_m, source, client_event_id)
     VALUES ($1, $2, $3, now(), 5, 'simulator', $4)`, [tripId, p.lat.toFixed(6), p.lon.toFixed(6), randomUUID()]);
}

/** Người dùng đóng vai Driver của chuyến và một Dispatcher đang hoạt động. */
async function actors(trip) {
  const driver = (await query(
    `SELECT u.id, u.role, d.id AS driver_id FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = $1`, [trip.driver.id])).rows[0];
  const dispatcher = (await query(
    `SELECT id, role FROM users WHERE role = 'dispatcher' AND status = 'active' ORDER BY id LIMIT 1`)).rows[0];
  return { driver, dispatcher };
}

/**
 * Đường xe sẽ chạy từ vị trí hiện tại tới điểm đích: cắt từ đường đi của tuyến hiện hành (GeoJSON, kinh độ trước),
 * bắt đầu từ đỉnh gần xe nhất và kết thúc ở đỉnh gần đích nhất phía sau đó. Không có đường đi thì chạy thẳng.
 */
function pathTo(geometry, here, target) {
  const coords = geometry?.coordinates;
  if (!coords?.length) return [target];
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
  if (s.d > 300 || e.d > 300 || e.i < s.i) return [target];
  return [...coords.slice(s.i, e.i + 1).map(([lon, lat]) => ({ lat, lon })), target];
}

/** Đi dọc path với vận tốc cho trước, ghi vị trí mỗi giây; onTick trả về true thì dừng sớm (tuyến vừa đổi). */
async function follow(tripId, here, path, mps, onTick) {
  let pos = { ...here };
  for (const wp of path) {
    while (true) {
      const d = haversineM(pos, wp);
      const step = mps * (TICK_MS / 1000);
      if (d <= step) { pos = { ...wp }; break; }
      const k = step / d;
      pos = { lat: pos.lat + (wp.lat - pos.lat) * k, lon: pos.lon + (wp.lon - pos.lon) * k };
      await writePosition(tripId, pos);
      await sleep(TICK_MS);
      if (await onTick?.()) return { pos, interrupted: true };
    }
  }
  await writePosition(tripId, pos);
  return { pos, interrupted: false };
}

/** Đứng yên tại chỗ trong ms mili giây, vẫn ghi vị trí để vị trí không bị cũ. */
async function hold(tripId, pos, ms) {
  for (let t = 0; t < ms; t += TICK_MS) {
    await writePosition(tripId, pos);
    await sleep(TICK_MS);
  }
}

async function createIncident(tripId, factor) {
  const trip = await loadTrip(tripId);
  if (!trip || trip.status !== 'in_progress') throw new Error('Chỉ tạo sự cố cho chuyến đang giao');
  const remaining = trip.stops.filter(s => s.status === 'pending');
  if (remaining.length < 3) throw new Error('Cần ít nhất 3 điểm chưa giao');
  const key = s => pointKey('o', s.order.id, s.order.lat, s.order.lon);
  const profile = trip.vehicle.profile;
  const keys = [pointKey('d', trip.depot.id, trip.depot.lat, trip.depot.lon), ...remaining.map(key)];
  // Lấy thời gian gốc, bỏ qua các đợt sự cố trước để tạo sự cố nhiều lần không bị nhân dồn
  const travel = await cachedTravel(keys, profile, { withIncident: false });
  const from = key(remaining[0]);
  const slow = key(remaining[1]);
  const { rows } = await query(
    `INSERT INTO matrix_batches (profile_snapshot, completed_at, data_source, status)
     VALUES ($1, now(), 'mock', 'completed') RETURNING id`,
    [{ profile, scenario: 'incident', note: `Sự cố giả định: đường ${remaining[0].order.code} → ${remaining[1].order.code} chậm ${factor} lần`, tripId }]);
  let n = 0;
  for (const a of keys) for (const b of keys) {
    if (a === b) continue;
    const t = travel(a, b);
    if (t == null) continue;
    await query(
      `INSERT INTO matrix_entries (batch_id, origin_key, destination_key, travel_seconds, distance_m, status) VALUES ($1, $2, $3, $4, NULL, 'ok')`,
      [rows[0].id, a, b, a === from && b === slow ? Math.round(t * factor) : t]);
    n++;
  }
  return { batchId: rows[0].id, legs: n, text: `đường ${remaining[0].order.code} → ${remaining[1].order.code} chậm ${factor} lần` };
}

async function incident() {
  const r = await createIncident(tripIds[0], opt('factor', 3));
  console.log(`Đã tạo đợt ma trận ${r.batchId} (${r.legs} chặng): ${r.text}.`);
  console.log('Mở chi tiết chuyến và bấm "Đánh giá đổi tuyến" để xem đề xuất.');
}

/**
 * Chờ đề xuất đổi tuyến sau khi có ùn tắc. Kiểm tra định kỳ của Backend thường tạo đề xuất trong một chu kỳ;
 * nếu Backend tắt kiểm tra định kỳ thì sau 20 giây công cụ tự gọi bước đánh giá như một lần kiểm tra.
 */
async function waitProposal(tripId, pos, log) {
  for (let waited = 0; waited < 60_000; waited += TICK_MS) {
    const trip = await loadTrip(tripId);
    if (trip.proposal && !trip.proposal.outdated) return trip.proposal;
    if (waited === 20_000) {
      log('Backend chưa tạo đề xuất (kiểm tra định kỳ đang tắt?), tự chạy một lần kiểm tra');
      const ev = await evaluateTripReroute(tripId, null, { auto: true }).catch(err => ({ error: err.message }));
      if (ev.error) log(`Không đánh giá được: ${ev.error}`);
    }
    await writePosition(tripId, pos);
    await sleep(TICK_MS);
  }
  return null;
}

async function runTrip(tripId, { speed, jamAt: jamOpt, factor, approveAfter, lead }) {
  let jamAt = jamOpt;
  let trip = await loadTrip(tripId);
  if (!trip) throw new Error(`Không tìm thấy chuyến ${tripId}`);
  const log = msg => console.log(`${new Date().toLocaleTimeString('vi-VN')} ${trip.code} ${msg}`);
  const { driver, dispatcher } = await actors(trip);
  if (trip.status === 'assigned') {
    await startTrip(tripId, driver, { checkedOrderIds: trip.stops.map(s => s.order.id), clientEventId: randomUUID(), fp: 'simulator' });
    log('Driver kiểm đủ hàng và bắt đầu chuyến');
  }
  const mps = (30 / 3.6) * speed;
  let here = null;
  const filled = new Set();
  let jammed = !lead;
  if (lead && !jamAt) {
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
    if (trip.needsAck) {
      await hold(tripId, here, 3000);
      await acknowledgeRoute(tripId, driver, { routeVersionId: trip.routeVersion.id, clientEventId: randomUUID(), fp: 'simulator' });
      log(`Driver xác nhận tuyến phiên bản ${trip.routeVersion.versionNo}`);
      continue;
    }
    // Tuyến mới vừa duyệt có thể chưa có đường đi (Backend lấy đường đi sau khi ghi), chờ thêm tối đa 10 giây
    if (!trip.routeVersion?.geometry && trip.routeVersion?.reason === 'replan') {
      for (let i = 0; i < 10 && !trip.routeVersion.geometry; i++) { await hold(tripId, here, TICK_MS); trip = await loadTrip(tripId); }
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
    const target = next ? { lat: next.order.lat, lon: next.order.lon } : { lat: trip.depot.lat, lon: trip.depot.lon };
    const version = trip.routeVersion?.id;
    log(next ? `chạy tới điểm ${next.seq} ${next.order.code}` : 'quay về kho');
    let ticks = 0;
    const moved = await follow(tripId, here, pathTo(trip.routeVersion?.geometry, here, target), mps, async () => {
      if (++ticks % 3) return false;
      const t = await loadTrip(tripId);
      return t.routeVersion?.id !== version || t.needsAck;
    });
    here = moved.pos;
    if (moved.interrupted) continue;
    if (!next) {
      await hold(tripId, here, 3000);
      const failed = trip.stops.filter(s => s.status === 'failed').map(s => s.order.id);
      await returnTrip(tripId, driver, { returnedOrderIds: failed, clientEventId: randomUUID(), fp: 'simulator' });
      log('đã về kho, Driver gửi báo cáo về kho');
      return;
    }

    const doneCount = trip.stops.filter(s => s.status !== 'pending').length;
    if (!jammed && doneCount + 1 >= jamAt) {
      jammed = true;
      const r = await createIncident(tripId, factor).catch(err => ({ error: err.message }));
      if (r.error) { log(`không tạo được ùn tắc: ${r.error}`); continue; }
      log(`ÙN TẮC phía trước: ${r.text}`);
      const p = await waitProposal(tripId, here, log);
      if (!p) log('không có đề xuất đổi tuyến, giữ tuyến hiện hành');
      else if (!p.meetsThreshold) log('đề xuất không đủ ngưỡng tiết kiệm, giữ tuyến hiện hành');
      else {
        log(`có đề xuất đổi tuyến, tiết kiệm ${Math.round(p.savingSeconds / 60)} phút`);
        if (approveAfter > 0) {
          await hold(tripId, here, approveAfter * 1000);
          await approveReroute(tripId, p.eventId, dispatcher)
            .then(() => log('Dispatcher duyệt tuyến mới'))
            .catch(err => log(`duyệt không thành công: ${err.message}`));
        } else {
          log('chờ Dispatcher bấm duyệt trên màn hình chi tiết chuyến');
          for (let i = 0; i < 120; i++) {
            const t = await loadTrip(tripId);
            if (t.needsAck || !t.proposal) break;
            await hold(tripId, here, TICK_MS);
          }
        }
      }
      continue;   // xử lý xác nhận tuyến mới rồi giao điểm đang đứng
    }
    await hold(tripId, here, 3000);
    await recordAttempt(tripId, next.id, driver, { result: 'delivered', occurredAt: new Date().toISOString(), clientEventId: randomUUID(), fp: 'simulator' });
    log(`giao thành công điểm ${next.seq} ${next.order.code}`);
  }
}

async function drive() {
  const speed = opt('speed', 4);
  const tripId = tripIds[0];
  const mps = (30 / 3.6) * speed;
  let here = null;
  console.log(`Mô phỏng chuyến ${tripId}, tua nhanh ${speed} lần. Ctrl + C để dừng.`);
  while (true) {
    const trip = await loadTrip(tripId);
    if (!trip) throw new Error('Không tìm thấy chuyến');
    if (trip.status === 'assigned') { console.log('Chờ Driver bắt đầu chuyến…'); await sleep(3000); continue; }
    if (trip.status !== 'in_progress') { console.log(`Chuyến ở trạng thái ${trip.status}, dừng mô phỏng.`); return; }
    here ??= trip.position ? { lat: trip.position.lat, lon: trip.position.lon } : { lat: trip.depot.lat, lon: trip.depot.lon };
    const next = trip.stops.find(s => s.id === trip.nextStopId);
    const target = next ? { lat: next.order.lat, lon: next.order.lon } : { lat: trip.depot.lat, lon: trip.depot.lon };
    if (haversineM(here, target) > 15) {
      const version = trip.routeVersion?.id;
      let ticks = 0;
      here = (await follow(tripId, here, pathTo(trip.routeVersion?.geometry, here, target), mps, async () =>
        ++ticks % 3 === 0 && (await loadTrip(tripId)).routeVersion?.id !== version)).pos;
      continue;
    }
    if (!next) { console.log('Xe đã về kho. Driver gửi báo cáo về kho trên ứng dụng.'); return; }
    await hold(tripId, here, 3000);   // chờ Driver ghi kết quả điểm đang đứng
  }
}

async function demo() {
  const settings = {
    speed: opt('speed', 4), jamAt: opt('jam-at', 0), factor: opt('factor', 3), approveAfter: opt('approve-after', 8),
  };
  if (tripArg === 'active') {
    // Chuyến còn nhiều điểm nhất đi đầu để có đủ điểm cho ùn tắc và đổi tuyến
    const { rows } = await query(
      `SELECT t.id FROM trips t JOIN trip_stops s ON s.trip_id = t.id WHERE t.status IN ('assigned', 'in_progress')
        GROUP BY t.id ORDER BY count(*) FILTER (WHERE s.status = 'pending') DESC, t.id`);
    tripIds = rows.map(r => r.id);
    if (!tripIds.length) throw new Error('Không có chuyến nào đang chờ xuất phát hoặc đang giao, chạy prepare trước');
  }
  console.log(`Demo chuyến ${tripIds.join(', ')}, tua nhanh ${settings.speed} lần, chuyến ${tripIds[0]} sẽ gặp ùn tắc. Ctrl + C để dừng.`);
  // Chờ mọi chuyến chạy xong (kể cả khi một chuyến lỗi) rồi mới đóng kết nối cơ sở dữ liệu
  const outcomes = await Promise.allSettled(tripIds.map((id, i) => runTrip(id, { ...settings, lead: i === 0 })));
  const failed = outcomes.map((o, i) => [tripIds[i], o]).filter(([, o]) => o.status === 'rejected');
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
  // Đơn mới trên các địa chỉ mẫu, mã nối tiếp mã lớn nhất hiện có
  const scenario = JSON.parse(readFileSync(new URL('./seed-data/kich_ban.json', import.meta.url), 'utf8'));
  const people = JSON.parse(readFileSync(new URL('./seed-data/nguoi_nhan.json', import.meta.url), 'utf8'));
  const TYPE = { xe_may: 'motorcycle', xe_tai: 'small_truck' };
  let last = Number((await query(`SELECT max(substring(code from 4)::int) AS n FROM orders WHERE code ~ '^DH-[0-9]+$'`)).rows[0].n ?? 1000);
  const orderIds = (await query(`SELECT id FROM orders WHERE status = 'pending' ORDER BY id`)).rows.map(r => r.id);
  for (const d of scenario.don.slice(0, opt('orders', 12))) {
    const r = people[d.ma];
    const { rows } = await query(
      `INSERT INTO orders (code, recipient_name, phone, address, latitude, longitude, weight_kg, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [`DH-${++last}`, r.ten, r.sdt, `${d.dia_chi}, Đà Nẵng`, d.lat, d.lon, d.khoi_luong_kg, r.ghi_chu ?? null]);
    for (const t of d.loai_xe) await query('INSERT INTO order_vehicle_types (order_id, vehicle_type) VALUES ($1, $2)', [rows[0].id, TYPE[t]]);
    orderIds.push(rows[0].id);
  }
  console.log(`Có ${orderIds.length} đơn chờ xếp`);
  const vehicleIds = (await loadVehicles()).filter(v => !vehicleProblem(v)).map(v => v.id);
  const snapshot = await prepareSnapshot({ orderIds, vehicleIds, maxRouteMinutes: 60 });
  const run = (await query(
    `INSERT INTO planning_runs (created_by, input_snapshot, status, client_event_id, request_fingerprint)
     VALUES ($1, $2, 'running', $3, 'simulator') RETURNING id`, [dispatcher.id, snapshot, randomUUID()])).rows[0];
  console.log(`Lập kế hoạch với ${vehicleIds.length} xe, ${hasKey() && config.matrixSource !== 'mock'
    ? 'lấy các chặng còn thiếu từ TomTom…' : 'chưa có khóa TomTom (hoặc nguồn mock), các chặng còn thiếu được ước lượng…'}`);
  await runPlanning(run.id, snapshot);
  const done = (await query('SELECT status, result FROM planning_runs WHERE id = $1', [run.id])).rows[0];
  if (done.status !== 'draft') throw new Error(`Lập kế hoạch không thành công: ${done.result?.error ?? done.status}`);
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
