// UC03 Quản lý nguồn lực (Dispatcher): hồ sơ Driver (UC03.1), phương tiện (UC03.2), kho xuất phát (UC03.3).
// Thay đổi dữ liệu nền phải tôn trọng chuyến đang chạy: không sửa những gì làm mất điều kiện của chuyến đó.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { query, transaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { integer, number, oneOf, paramId, text } from '../validate.js';
import { ACTIVE_STATUSES, tripCode } from '../services/trips.js';

const router = Router();
// Router này gắn ở /api nên chỉ kiểm tra vai trò trên đúng ba nhóm đường dẫn của mình
router.use(['/drivers', '/vehicles', '/depots'], requireRole('dispatcher'));

// ---------------------------------------------------------------- Driver

const toDriver = r => ({
  id: r.id,
  userId: r.user_id,
  username: r.username,
  accountStatus: r.account_status,
  fullName: r.full_name,
  phone: r.phone,
  status: r.status,
  defaultVehicle: r.default_vehicle_id
    ? { id: r.default_vehicle_id, plate: r.plate, type: r.vehicle_type, capacityKg: r.capacity_kg } : null,
  activeTrip: r.trip_id ? { id: r.trip_id, code: tripCode(r.trip_id), status: r.trip_status, done: Number(r.done), total: Number(r.total) } : null,
});

const DRIVERS = `
  SELECT d.*, u.username, u.status AS account_status, v.plate, v.vehicle_type, v.capacity_kg,
         t.id AS trip_id, t.status AS trip_status,
         (SELECT count(*) FROM trip_stops s WHERE s.trip_id = t.id AND s.status <> 'pending') AS done,
         (SELECT count(*) FROM trip_stops s WHERE s.trip_id = t.id) AS total
    FROM drivers d
    JOIN users u ON u.id = d.user_id
    LEFT JOIN vehicles v ON v.id = d.default_vehicle_id
    LEFT JOIN trips t ON t.driver_id = d.id AND t.status = ANY($1)`;

async function loadDriver(id) {
  const { rows } = await query(`${DRIVERS} WHERE d.id = $2`, [ACTIVE_STATUSES, id]);
  if (!rows[0]) throw notFound('Không tìm thấy Driver');
  return rows[0];
}

router.get('/drivers', async (_req, res) => {
  const { rows } = await query(`${DRIVERS} ORDER BY d.id`, [ACTIVE_STATUSES]);
  // Tài khoản vai trò Driver do Administrator cấp nhưng chưa có hồ sơ
  const accounts = await query(
    `SELECT u.id, u.username, u.full_name FROM users u
      WHERE u.role = 'driver' AND u.status = 'active' AND NOT EXISTS (SELECT 1 FROM drivers d WHERE d.user_id = u.id)
      ORDER BY u.username`);
  res.json({
    drivers: rows.map(toDriver),
    availableAccounts: accounts.rows.map(a => ({ id: a.id, username: a.username, fullName: a.full_name })),
  });
});

async function checkVehicleFree(vehicleId, driverId) {
  if (!vehicleId) return;
  const v = (await query('SELECT id FROM vehicles WHERE id = $1', [vehicleId])).rows[0];
  if (!v) throw badRequest('Không tìm thấy phương tiện');
  const taken = await query('SELECT full_name FROM drivers WHERE default_vehicle_id = $1 AND id <> $2', [vehicleId, driverId ?? 0]);
  if (taken.rows.length) throw conflict(`Xe đã là xe thường dùng của ${taken.rows[0].full_name}`);
}

router.post('/drivers', async (req, res) => {
  const userId = integer(req.body?.userId, 'tài khoản Driver');
  const fullName = text(req.body?.fullName, 'họ tên', { max: 100 });
  const phone = text(req.body?.phone, 'số điện thoại', { required: false, max: 20 });
  const vehicleId = integer(req.body?.defaultVehicleId, 'xe thường dùng', { required: false });
  const u = (await query('SELECT role FROM users WHERE id = $1', [userId])).rows[0];
  if (!u || u.role !== 'driver') throw badRequest('Tài khoản được chọn không có vai trò Driver');
  await checkVehicleFree(vehicleId, null);
  const { rows } = await query(
    'INSERT INTO drivers (user_id, full_name, phone, default_vehicle_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, fullName, phone, vehicleId]);
  await query('UPDATE users SET full_name = COALESCE(full_name, $2) WHERE id = $1', [userId, fullName]);
  res.status(201).json({ driver: toDriver(await loadDriver(rows[0].id)) });
});

router.put('/drivers/:id', async (req, res) => {
  const id = paramId(req);
  const fullName = text(req.body?.fullName, 'họ tên', { max: 100 });
  const phone = text(req.body?.phone, 'số điện thoại', { required: false, max: 20 });
  const vehicleId = integer(req.body?.defaultVehicleId, 'xe thường dùng', { required: false });
  const status = oneOf(req.body?.status, 'trạng thái', ['active', 'inactive']);
  await transaction(async c => {
    // Khóa dòng Driver như lúc giao chuyến (commitPlan), để sửa hồ sơ và giao chuyến đồng thời không cùng thành công
    const cur = (await c.query('SELECT default_vehicle_id FROM drivers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw notFound('Không tìm thấy Driver');
    const trip = (await c.query('SELECT id FROM trips WHERE driver_id = $1 AND status = ANY($2) LIMIT 1', [id, ACTIVE_STATUSES])).rows[0];
    if (trip && (status !== 'active' || vehicleId !== cur.default_vehicle_id)) {
      throw conflict(`Driver đang giữ chuyến ${tripCode(trip.id)}, chưa thể ngừng hoạt động hoặc đổi xe`);
    }
    await checkVehicleFree(vehicleId, id);
    await c.query('UPDATE drivers SET full_name = $2, phone = $3, default_vehicle_id = $4, status = $5 WHERE id = $1',
      [id, fullName, phone, vehicleId, status]);
  });
  res.json({ driver: toDriver(await loadDriver(id)) });
});

// ---------------------------------------------------------------- Phương tiện

const toVehicle = r => ({
  id: r.id,
  plate: r.plate,
  type: r.vehicle_type,
  capacityKg: r.capacity_kg,
  routingProfile: r.routing_profile,
  status: r.status,
  driver: r.driver_id ? { id: r.driver_id, name: r.driver_name } : null,
  activeTrip: r.trip_id ? { id: r.trip_id, code: tripCode(r.trip_id), status: r.trip_status } : null,
});

const VEHICLES = `
  SELECT v.*, d.id AS driver_id, d.full_name AS driver_name, t.id AS trip_id, t.status AS trip_status
    FROM vehicles v
    LEFT JOIN drivers d ON d.default_vehicle_id = v.id
    LEFT JOIN trips t ON t.vehicle_id = v.id AND t.status = ANY($1)`;

async function loadVehicle(id) {
  const { rows } = await query(`${VEHICLES} WHERE v.id = $2`, [ACTIVE_STATUSES, id]);
  if (!rows[0]) throw notFound('Không tìm thấy phương tiện');
  return rows[0];
}

router.get('/vehicles', async (_req, res) => {
  const { rows } = await query(`${VEHICLES} ORDER BY v.id`, [ACTIVE_STATUSES]);
  res.json({ vehicles: rows.map(toVehicle) });
});

function readVehicle(body) {
  const type = oneOf(body?.type, 'loại xe', ['motorcycle', 'small_truck']);
  return {
    plate: text(body?.plate, 'biển số', { max: 20 }),
    type,
    capacityKg: number(body?.capacityKg, 'tải trọng', { gt: 0, max: 99999 }),
    // Cấu hình định tuyến đi theo loại xe: xe máy dùng motorcycle, xe tải nhỏ dùng truck
    routingProfile: type === 'motorcycle' ? 'motorcycle' : 'truck',
  };
}

router.post('/vehicles', async (req, res) => {
  const v = readVehicle(req.body);
  const dup = await query('SELECT 1 FROM vehicles WHERE plate = $1', [v.plate]);
  if (dup.rows.length) throw conflict('Biển số đã tồn tại');
  const { rows } = await query(
    'INSERT INTO vehicles (plate, vehicle_type, capacity_kg, routing_profile) VALUES ($1, $2, $3, $4) RETURNING id',
    [v.plate, v.type, v.capacityKg, v.routingProfile]);
  res.status(201).json({ vehicle: toVehicle(await loadVehicle(rows[0].id)) });
});

router.put('/vehicles/:id', async (req, res) => {
  const id = paramId(req);
  const v = readVehicle(req.body);
  const cur = await loadVehicle(id);
  const changed = cur.vehicle_type !== v.type || cur.capacity_kg !== v.capacityKg || cur.plate !== v.plate;
  if (cur.trip_id && changed) throw conflict(`Xe đang chạy chuyến ${tripCode(cur.trip_id)}, chưa thể sửa cấu hình`);
  const dup = await query('SELECT 1 FROM vehicles WHERE plate = $1 AND id <> $2', [v.plate, id]);
  if (dup.rows.length) throw conflict('Biển số đã tồn tại');
  await query('UPDATE vehicles SET plate = $2, vehicle_type = $3, capacity_kg = $4, routing_profile = $5 WHERE id = $1',
    [id, v.plate, v.type, v.capacityKg, v.routingProfile]);
  res.json({ vehicle: toVehicle(await loadVehicle(id)) });
});

// Báo bảo trì / kết thúc bảo trì
router.patch('/vehicles/:id/status', async (req, res) => {
  const id = paramId(req);
  const status = oneOf(req.body?.status, 'trạng thái', ['active', 'inactive']);
  await transaction(async c => {
    // Khóa dòng xe như lúc giao chuyến (commitPlan), để báo bảo trì và giao chuyến đồng thời không cùng thành công
    if (!(await c.query('SELECT id FROM vehicles WHERE id = $1 FOR UPDATE', [id])).rows[0]) throw notFound('Không tìm thấy phương tiện');
    const trip = (await c.query('SELECT id FROM trips WHERE vehicle_id = $1 AND status = ANY($2) LIMIT 1', [id, ACTIVE_STATUSES])).rows[0];
    if (status === 'inactive' && trip) throw conflict(`Xe đang chạy chuyến ${tripCode(trip.id)}, chưa thể báo bảo trì`);
    await c.query('UPDATE vehicles SET status = $2 WHERE id = $1', [id, status]);
  });
  res.json({ vehicle: toVehicle(await loadVehicle(id)) });
});

// ---------------------------------------------------------------- Kho

const toDepot = r => ({
  id: r.id, name: r.name, address: r.address, lat: r.latitude, lon: r.longitude, openingHours: r.opening_hours,
});

router.get('/depots', async (_req, res) => {
  const { rows } = await query('SELECT * FROM depots ORDER BY id');
  const counts = (await query(
    `SELECT (SELECT count(*) FROM vehicles) AS vehicles,
            (SELECT count(*) FROM vehicles WHERE vehicle_type = 'motorcycle') AS motorcycles,
            (SELECT count(*) FROM drivers) AS drivers`)).rows[0];
  res.json({
    depots: rows.map(toDepot),
    counts: { vehicles: Number(counts.vehicles), motorcycles: Number(counts.motorcycles), drivers: Number(counts.drivers) },
  });
});

router.put('/depots/:id', async (req, res) => {
  const id = paramId(req);
  const d = {
    name: text(req.body?.name, 'tên kho', { max: 100 }),
    address: text(req.body?.address, 'địa chỉ', { max: 255 }),
    lat: number(req.body?.lat, 'vĩ độ', { min: -90, max: 90 }),
    lon: number(req.body?.lon, 'kinh độ', { min: -180, max: 180 }),
    openingHours: text(req.body?.openingHours, 'giờ mở cửa', { required: false, max: 50 }),
  };
  const cur = (await query('SELECT * FROM depots WHERE id = $1', [id])).rows[0];
  if (!cur) throw notFound('Không tìm thấy kho');
  const moved = Math.abs(cur.latitude - d.lat) > 1e-6 || Math.abs(cur.longitude - d.lon) > 1e-6;
  if (moved) {
    const busy = await query('SELECT id FROM trips WHERE depot_id = $1 AND status = ANY($2) LIMIT 1', [id, ACTIVE_STATUSES]);
    if (busy.rows.length) throw conflict(`Kho đang có chuyến ${tripCode(busy.rows[0].id)} hoạt động, chưa thể đổi tọa độ`);
  }
  await query('UPDATE depots SET name = $2, address = $3, latitude = $4, longitude = $5, opening_hours = $6 WHERE id = $1',
    [id, d.name, d.address, d.lat, d.lon, d.openingHours]);
  res.json({ depot: toDepot((await query('SELECT * FROM depots WHERE id = $1', [id])).rows[0]) });
});

export default router;
