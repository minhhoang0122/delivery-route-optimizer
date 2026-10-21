// Nạp dữ liệu mẫu theo thiết kế giao diện: Kho Hải Châu, 5 xe, 5 Driver, 20 đơn ở Đà Nẵng
// và hai ma trận TomTom đã ghi (16:00 và 17:30 Thứ Hai 12/10/2026) để lập kế hoạch không tốn hạn mức.
// Chạy: npm run seed            (chỉ chạy khi cơ sở dữ liệu còn trống)
//       npm run seed -- --reset (xóa toàn bộ dữ liệu cũ rồi nạp lại)
import bcrypt from 'bcryptjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { pointKey } from '../src/services/matrix.js';
import { COMMON, PROFILES } from '../src/services/tomtom.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'seed-data');
const read = name => JSON.parse(readFileSync(join(DATA, name), 'utf8'));
const reset = process.argv.includes('--reset');

const password = process.env.SEED_PASSWORD;
if (!password || password.length < 8) {
  console.error('Cần SEED_PASSWORD (ít nhất 8 ký tự) trong .env cho các tài khoản mẫu.');
  process.exit(1);
}

const USERS = [
  ['admin', 'Lê Hoàng Nam', 'administrator', 'active'],
  ['dispatcher', 'Trần Thu Trang', 'dispatcher', 'active'],
  ['dispatcher2', 'Ngô Bảo Châu', 'dispatcher', 'active'],
  ['driver1', 'Lê Văn Hùng', 'driver', 'active'],
  ['driver2', 'Phạm Thị Mai', 'driver', 'active'],
  ['driver3', 'Nguyễn Đức Tài', 'driver', 'active'],
  ['driver4', 'Trần Quốc Bảo', 'driver', 'active'],
  ['driver5', 'Võ Minh Nhật', 'driver', 'locked'],
];

// [biển số, loại, tải trọng, cấu hình định tuyến, trạng thái]
const VEHICLES = [
  ['43B1-234.56', 'motorcycle', 50, 'motorcycle', 'active'],
  ['43C1-118.20', 'motorcycle', 40, 'motorcycle', 'active'],
  ['43D1-772.05', 'motorcycle', 50, 'motorcycle', 'active'],
  ['43C-125.88', 'small_truck', 750, 'truck', 'active'],
  ['43C-309.14', 'small_truck', 1000, 'truck', 'inactive'],
];

// [tài khoản, số điện thoại, xe thường dùng (thứ tự trong VEHICLES), trạng thái hồ sơ]
const DRIVERS = [
  ['driver1', '0905 214 368', 0, 'active'],
  ['driver2', '0913 557 902', 1, 'active'],
  ['driver3', '0935 840 116', 2, 'active'],
  ['driver4', '0898 231 675', 3, 'active'],
  ['driver5', '0976 402 539', 4, 'inactive'],
];

const TYPE = { xe_may: 'motorcycle', xe_tai: 'small_truck' };

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
  for (const [plate, type, cap, profile, status] of VEHICLES) {
    const { rows } = await client.query(
      'INSERT INTO vehicles (plate, vehicle_type, capacity_kg, routing_profile, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [plate, type, cap, profile, status]);
    vehicleIds.push(rows[0].id);
  }

  for (const [username, phone, v, status] of DRIVERS) {
    const name = USERS.find(u => u[0] === username)[1];
    await client.query('INSERT INTO drivers (user_id, full_name, phone, default_vehicle_id, status) VALUES ($1, $2, $3, $4, $5)',
      [userId[username], name, phone, vehicleIds[v], status]);
  }

  const scenario = read('kich_ban.json');
  const depot = (await client.query(
    'INSERT INTO depots (name, address, latitude, longitude, opening_hours) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [scenario.kho.ten, scenario.kho.dia_chi, scenario.kho.lat, scenario.kho.lon, '7:00–21:00'])).rows[0];

  const recipients = read('nguoi_nhan.json');
  const orders = new Map();
  for (const d of scenario.don) {
    const r = recipients[d.ma];
    const { rows } = await client.query(
      `INSERT INTO orders (code, recipient_name, phone, address, latitude, longitude, weight_kg, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, latitude, longitude`,
      [d.ma, r.ten, r.sdt, `${d.dia_chi}, Đà Nẵng`, d.lat, d.lon, d.khoi_luong_kg, r.ghi_chu ?? null]);
    for (const t of d.loai_xe) await client.query('INSERT INTO order_vehicle_types (order_id, vehicle_type) VALUES ($1, $2)', [rows[0].id, TYPE[t]]);
    orders.set(d.ma, rows[0]);
  }

  // Ma trận đã ghi: khóa điểm dựng từ mã và tọa độ trong cơ sở dữ liệu để Backend dùng lại được
  const keyOf = ma => (ma === 'KHO'
    ? pointKey('d', depot.id, depot.latitude, depot.longitude)
    : pointKey('o', orders.get(ma).id, orders.get(ma).latitude, orders.get(ma).longitude));
  let entries = 0;
  for (const file of ['ma_tran_20261012_1600.json', 'ma_tran_20261012_1730.json']) {
    const m = read(file);
    for (const profile of Object.keys(m.thoi_gian)) {
      const { rows } = await client.query(
        `INSERT INTO matrix_batches (profile_snapshot, started_at, completed_at, data_source, status)
         VALUES ($1, $2, $3, 'tomtom', 'completed') RETURNING id`,
        [{ profile, params: { ...COMMON, ...PROFILES[profile] }, departAt: m.departAt, label: `Ma trận ghi sẵn ${m.nhan}` }, m.bat_dau, m.ket_thuc]);
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
  console.log(`Đã nạp ${USERS.length} tài khoản, ${VEHICLES.length} xe, ${DRIVERS.length} Driver, 1 kho, ${scenario.don.length} đơn, ${entries} chặng ma trận.`);
  console.log('Mật khẩu các tài khoản mẫu là giá trị SEED_PASSWORD trong file .env.');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
