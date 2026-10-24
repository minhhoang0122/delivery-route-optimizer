// Nạp dữ liệu mẫu: kịch bản 60 đơn trên 30 điểm giao ở trung tâm Đà Nẵng, kho 120 Nguyễn Văn Linh, 4 xe (3 xe máy, 1 xe tải nhỏ)
// có tải trọng và số kiện tối đa, tài xế, người nhận, cùng 4 ma trận TomTom đã ghi lúc 16:00, 16:30, 17:00, 17:30
// (Thứ Hai 26/10/2026) để lập kế hoạch và tính giờ dự kiến theo giờ (nguồn replay) mà không tốn hạn mức.
// Xe thứ 5 đang bảo trì và tài khoản driver5 bị khóa, như thiết kế giao diện.
// Chạy: npm run seed            (chỉ chạy khi cơ sở dữ liệu còn trống)
//       npm run seed -- --reset (xóa toàn bộ dữ liệu cũ rồi nạp lại)
import bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { secondsOfDay } from '../src/services/clock.js';
import { locationKey, pointKey } from '../src/services/matrix.js';
import { COMMON, PROFILES } from '../src/services/tomtom.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'seed-data');
const read = name => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
const reset = process.argv.includes('--reset');

const password = process.env.SEED_PASSWORD;
if (!password || password.length < 8) {
  console.error('Cần SEED_PASSWORD (ít nhất 8 ký tự) trong .env cho các tài khoản mẫu.');
  process.exit(1);
}

const scenario = read('kich_ban_60.json');
const TYPE = { xe_may: 'motorcycle', xe_tai: 'small_truck' };
const SLOTS = ['ma_tran_60_1600.json', 'ma_tran_60_1630.json', 'ma_tran_60_1700.json', 'ma_tran_60_1730.json'];

// Tài xế 1–4 lái 4 xe của kịch bản; tài xế 5 bị khóa, xe 5 bảo trì
const USERS = [
  ['admin', 'Lê Hoàng Nam', 'administrator', 'active'],
  ['dispatcher', 'Trần Thu Trang', 'dispatcher', 'active'],
  ['dispatcher2', 'Ngô Bảo Châu', 'dispatcher', 'active'],
  ...scenario.xe.map((x, i) => [`driver${i + 1}`, x.tai_xe, 'driver', 'active']),
  ['driver5', 'Võ Minh Nhật', 'driver', 'locked'],
];

// [biển số, loại, tải trọng, cấu hình định tuyến, số kiện tối đa, trạng thái]
const VEHICLES = [
  ...scenario.xe.map(x => [x.bien_so, TYPE[x.loai], x.tai_trong_kg, x.cau_hinh, x.so_kien_toi_da, 'active']),
  ['43C-309.14', 'small_truck', 1000, 'truck', 150, 'inactive'],
];

// [tài khoản, số điện thoại, xe thường dùng (thứ tự trong VEHICLES), trạng thái hồ sơ]
const DRIVERS = [
  ['driver1', '0905 214 368', 0, 'active'],
  ['driver2', '0913 557 902', 1, 'active'],
  ['driver3', '0935 840 116', 2, 'active'],
  ['driver4', '0898 231 675', 3, 'active'],
  ['driver5', '0976 402 539', 4, 'inactive'],
];

// Ghi chú cho tài xế của 20 người nhận đầu (cùng người nhận với bộ 20 đơn trước, theo số điện thoại)
const NOTES = new Map(Object.values(read('nguoi_nhan.json')).filter(r => r.ghi_chu).map(r => [r.sdt, r.ghi_chu]));

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const existing = (await client.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (existing && !reset) {
    throw new Error('Cơ sở dữ liệu đã có dữ liệu. Chạy "npm run seed -- --reset" nếu muốn xóa và nạp lại.');
  }
  if (reset) {
    await client.query(`TRUNCATE vehicle_positions, trip_events, delivery_attempts, route_stops, active_assignments,
      trip_stops, route_versions, trips, planning_run_matrices, planning_runs, matrix_entries, matrix_batches,
      order_vehicle_types, orders, drivers, vehicles, depots, users RESTART IDENTITY CASCADE`);
  }

  const hash = await bcrypt.hash(password, 10);
  const userId = {};
  for (const [username, fullName, role, status] of USERS) {
    const { rows } = await client.query(
      'INSERT INTO users (username, password_hash, role, status, full_name) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [username, hash, role, status, fullName]);
    userId[username] = rows[0].id;
  }

  const vehicleIds = [];
  for (const [plate, type, cap, profile, parcels, status] of VEHICLES) {
    const { rows } = await client.query(
      'INSERT INTO vehicles (plate, vehicle_type, capacity_kg, routing_profile, capacity_parcels, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [plate, type, cap, profile, parcels, status]);
    vehicleIds.push(rows[0].id);
  }

  for (const [username, phone, v, status] of DRIVERS) {
    const name = USERS.find(u => u[0] === username)[1];
    await client.query('INSERT INTO drivers (user_id, full_name, phone, default_vehicle_id, status) VALUES ($1, $2, $3, $4, $5)',
      [userId[username], name, phone, vehicleIds[v], status]);
  }

  const k = scenario.kho;
  const depot = (await client.query(
    'INSERT INTO depots (name, address, latitude, longitude, opening_hours) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [k.ten, k.dia_chi, k.lat, k.lon, '7:00–21:00'])).rows[0];

  // Đơn: địa chỉ và tọa độ lấy theo điểm giao, nên các đơn cùng điểm có cùng tọa độ (một điểm dừng)
  const pointOf = new Map(scenario.diem.map(d => [d.ma, d]));
  const stored = new Map();
  for (const d of scenario.don) {
    const p = pointOf.get(d.diem);
    const { rows } = await client.query(
      `INSERT INTO orders (code, recipient_name, phone, address, latitude, longitude, weight_kg, parcels, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, latitude, longitude`,
      [d.ma, d.nguoi_nhan, d.sdt, p.dia_chi, p.lat, p.lon, d.khoi_luong_kg, d.so_kien, NOTES.get(d.sdt) ?? null]);
    for (const t of d.loai_xe) await client.query('INSERT INTO order_vehicle_types (order_id, vehicle_type) VALUES ($1, $2)', [rows[0].id, TYPE[t]]);
    if (!stored.has(d.diem)) stored.set(d.diem, rows[0]);
  }

  // Ma trận đã ghi: khóa điểm dựng từ tọa độ đã lưu trong cơ sở dữ liệu (làm tròn 6 chữ số) để Backend dùng lại được.
  // Mỗi tệp là một khung giờ: departAt và slot_seconds (giây kể từ 0:00 giờ Việt Nam) để nội suy theo giờ xuất phát
  const keyOf = ma => (ma === 'KHO'
    ? pointKey('d', depot.id, depot.latitude, depot.longitude)
    : locationKey(stored.get(ma).latitude, stored.get(ma).longitude));
  let entries = 0;
  for (const file of SLOTS) {
    const m = read(file);
    for (const profile of Object.keys(m.thoi_gian)) {
      const { rows } = await client.query(
        `INSERT INTO matrix_batches (profile_snapshot, started_at, completed_at, data_source, status, depart_at, slot_seconds)
         VALUES ($1, $2, $3, 'tomtom', 'completed', $4, $5) RETURNING id`,
        [{ profile, params: { ...COMMON, ...PROFILES[profile] }, departAt: m.departAt, label: `Ma trận ghi sẵn ${m.nhan}` },
          m.bat_dau, m.ket_thuc, m.departAt, Math.round(secondsOfDay(new Date(m.departAt)))]);
      const o = [], dst = [], sec = [], met = [];
      m.diem.forEach((a, i) => m.diem.forEach((b, j) => {
        if (i === j || m.thoi_gian[profile][i][j] == null) return;
        o.push(keyOf(a.ma)); dst.push(keyOf(b.ma));
        sec.push(m.thoi_gian[profile][i][j]); met.push(m.quang_duong[profile][i][j]);
      }));
      await client.query(
        `INSERT INTO matrix_entries (batch_id, origin_key, destination_key, travel_seconds, distance_m, status, fetched_at)
         SELECT $1, a, b, t, d, 'ok', $6 FROM unnest($2::text[], $3::text[], $4::int[], $5::int[]) AS x(a, b, t, d)`,
        [rows[0].id, o, dst, sec, met, m.bat_dau]);
      entries += o.length;
    }
  }

  await client.query('COMMIT');
  console.log(`Đã nạp ${USERS.length} tài khoản, ${VEHICLES.length} xe, ${DRIVERS.length} tài xế, 1 kho, ${scenario.don.length} đơn trên ${scenario.diem.length} điểm giao, `
    + `${SLOTS.length} khung giờ ma trận (${entries} chặng).`);
  console.log('Mật khẩu các tài khoản mẫu là giá trị SEED_PASSWORD trong file .env.');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
