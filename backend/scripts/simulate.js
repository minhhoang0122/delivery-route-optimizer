// Công cụ mô phỏng cho thử nghiệm và demo (mục 4.2.4). Không dùng trong vận hành thật.
//
//   npm run simulate -- drive --trip 3 [--speed 4]
//     Cho xe của chuyến 3 chạy theo tuyến hiện hành và ghi vị trí mỗi 3 giây (nguồn simulator).
//     Xe dừng ở điểm kế tiếp cho đến khi Driver ghi kết quả trên ứng dụng, rồi chạy tiếp; --speed là hệ số tua nhanh.
//
//   npm run simulate -- incident --trip 3 [--factor 3]
//     Tạo một đợt ma trận "sự cố giả định": chặng từ điểm kế tiếp tới điểm sau nó (theo tuyến hiện hành) bị ùn tắc,
//     chậm đi --factor lần.
//     Đợt này được đánh dấu scenario = incident để giao diện ghi rõ là giả định, không phải giao thông thật.
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/db.js';
import { cachedTravel, haversineM, pointKey } from '../src/services/matrix.js';
import { loadTrip } from '../src/services/trips.js';

const args = process.argv.slice(2);
const command = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const tripId = opt('trip');
if (!['drive', 'incident'].includes(command) || !Number.isInteger(tripId)) {
  console.log('Cách dùng: npm run simulate -- drive --trip <mã chuyến> [--speed 4]');
  console.log('           npm run simulate -- incident --trip <mã chuyến> [--factor 3]');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Điểm nằm trên đoạn a→b sau khi đi được tỉ lệ k. */
const lerp = (a, b, k) => ({ lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k });

async function writePosition(p) {
  await query(
    `INSERT INTO vehicle_positions (trip_id, latitude, longitude, observed_at, accuracy_m, source, client_event_id)
     VALUES ($1, $2, $3, now(), 5, 'simulator', $4)`, [tripId, p.lat.toFixed(6), p.lon.toFixed(6), randomUUID()]);
}

async function drive() {
  const speed = opt('speed', 4);
  const kmh = 25 * speed;
  let here = null;
  console.log(`Mô phỏng chuyến ${tripId}, tốc độ ${kmh} km/h (tua nhanh ${speed} lần). Ctrl + C để dừng.`);
  while (true) {
    const trip = await loadTrip(tripId);
    if (!trip) throw new Error('Không tìm thấy chuyến');
    if (trip.status === 'assigned') { console.log('Chờ Driver bắt đầu chuyến…'); await sleep(3000); continue; }
    if (trip.status !== 'in_progress') { console.log(`Chuyến ở trạng thái ${trip.status}, dừng mô phỏng.`); return; }
    here ??= trip.position ? { lat: trip.position.lat, lon: trip.position.lon } : { lat: trip.depot.lat, lon: trip.depot.lon };
    const next = trip.stops.find(s => s.id === trip.nextStopId);
    const target = next ? { lat: next.order.lat, lon: next.order.lon } : { lat: trip.depot.lat, lon: trip.depot.lon };
    const dist = haversineM(here, target);
    const step = (kmh / 3.6) * 3;  // mét đi được trong 3 giây
    if (dist > 15) here = lerp(here, target, Math.min(1, step / dist));
    else if (!next) { await writePosition(here); console.log('Xe đã về kho. Driver gửi báo cáo về kho trên ứng dụng.'); return; }
    await writePosition(here);
    console.log(`${new Date().toLocaleTimeString('vi-VN')} ${next ? `→ điểm ${next.seq} ${next.order.code}` : '→ kho'} còn ${Math.round(Math.max(0, dist - step))} m`);
    await sleep(3000);
  }
}

async function incident() {
  const factor = opt('factor', 3);
  const trip = await loadTrip(tripId);
  if (!trip || trip.status !== 'in_progress') throw new Error('Chỉ tạo sự cố cho chuyến đang giao');
  const remaining = trip.stops.filter(s => s.status === 'pending');
  if (remaining.length < 3) throw new Error('Cần ít nhất 3 điểm chưa giao');
  const key = s => pointKey('o', s.order.id, s.order.lat, s.order.lon);
  const profile = trip.vehicle.profile;
  const keys = [pointKey('d', trip.depot.id, trip.depot.lat, trip.depot.lon), ...remaining.map(key)];
  const travel = await cachedTravel(keys, profile);
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
  console.log(`Đã tạo đợt ma trận ${rows[0].id} (${n} chặng): đường ${remaining[0].order.code} → ${remaining[1].order.code} chậm ${factor} lần.`);
  console.log('Mở chi tiết chuyến và bấm "Đánh giá đổi tuyến" để xem đề xuất.');
}

try {
  await (command === 'drive' ? drive() : incident());
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
