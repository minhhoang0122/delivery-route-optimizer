// UC02 Quản lý đơn hàng (Dispatcher): danh sách, tạo, sửa trước khi lập kế hoạch.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { query, transaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { integer, number, oneOf, paramId, text } from '../validate.js';
import { loadOrders } from '../services/planning.js';
import { tripCode } from '../services/trips.js';

const router = Router();
router.use(requireRole('dispatcher'));

const TYPES = ['motorcycle', 'small_truck'];

export const toOrder = o => ({
  id: o.id,
  code: o.code,
  recipientName: o.recipient_name,
  phone: o.phone,
  address: o.address,
  lat: o.latitude,
  lon: o.longitude,
  weightKg: o.weight_kg,
  vehicleTypes: o.vehicle_types,
  status: o.status,
  version: o.version,
  note: o.note,
  createdAt: o.created_at,
  trip: o.trip_id ? { id: o.trip_id, code: tripCode(o.trip_id) } : null,
});

router.get('/', async (req, res) => {
  const status = req.query.status;
  const rows = status
    ? await loadOrders('o.status = $1', [oneOf(status, 'trạng thái', ['pending', 'assigned', 'in_delivery', 'delivered', 'needs_action', 'cancelled'])])
    : await loadOrders('TRUE');
  const trips = await query('SELECT order_id, trip_id FROM active_assignments');
  const tripOf = new Map(trips.rows.map(r => [r.order_id, r.trip_id]));
  res.json({ orders: rows.map(o => toOrder({ ...o, trip_id: tripOf.get(o.id) })) });
});

/** Đơn chưa giao được đang chờ quyết định (D04): kèm lần giao, lý do và chuyến. */
router.get('/needs-action', async (_req, res) => {
  const { rows } = await query(
    `SELECT o.id, o.code, o.recipient_name, o.phone, o.address, o.weight_kg, s.trip_id, t.status AS trip_status,
            a.reason, a.note, a.occurred_at,
            (SELECT count(*) FROM trip_stops s2 WHERE s2.order_id = o.id) AS attempt_count
       FROM orders o
       JOIN trip_stops s ON s.order_id = o.id AND s.status = 'failed'
       JOIN trips t ON t.id = s.trip_id AND t.status IN ('in_progress', 'awaiting_reconciliation')
       JOIN delivery_attempts a ON a.stop_id = s.id
      WHERE o.status = 'needs_action'
      ORDER BY a.occurred_at`);
  res.json({
    orders: rows.map(r => ({
      id: r.id, code: r.code, recipientName: r.recipient_name, phone: r.phone, address: r.address, weightKg: r.weight_kg,
      trip: { id: r.trip_id, code: tripCode(r.trip_id), status: r.trip_status },
      attemptNo: Number(r.attempt_count), reason: r.reason, note: r.note, occurredAt: r.occurred_at,
    })),
  });
});

router.get('/:id', async (req, res) => {
  const rows = await loadOrders('o.id = $1', [paramId(req)]);
  if (!rows[0]) throw notFound('Không tìm thấy đơn');
  res.json({ order: toOrder(rows[0]) });
});

function readOrder(body) {
  const vehicleTypes = Array.isArray(body?.vehicleTypes) ? [...new Set(body.vehicleTypes)] : [];
  if (!vehicleTypes.length) throw badRequest('Chọn ít nhất một loại xe được phép');
  vehicleTypes.forEach(t => oneOf(t, 'loại xe', TYPES));
  return {
    code: text(body?.code, 'mã đơn', { max: 20 }),
    recipientName: text(body?.recipientName, 'người nhận', { max: 100 }),
    phone: text(body?.phone, 'số điện thoại', { max: 20 }),
    address: text(body?.address, 'địa chỉ', { max: 255 }),
    lat: number(body?.lat, 'vĩ độ', { min: -90, max: 90 }),
    lon: number(body?.lon, 'kinh độ', { min: -180, max: 180 }),
    weightKg: number(body?.weightKg, 'khối lượng', { gt: 0, max: 999999 }),
    note: text(body?.note, 'ghi chú', { required: false, max: 255 }),
    vehicleTypes,
  };
}

router.post('/', async (req, res) => {
  const o = readOrder(req.body);
  const id = await transaction(async c => {
    const dup = await c.query('SELECT 1 FROM orders WHERE code = $1', [o.code]);
    if (dup.rows.length) throw conflict('Mã đơn đã tồn tại');
    const { rows } = await c.query(
      `INSERT INTO orders (code, recipient_name, phone, address, latitude, longitude, weight_kg, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [o.code, o.recipientName, o.phone, o.address, o.lat, o.lon, o.weightKg, o.note]);
    for (const t of o.vehicleTypes) await c.query('INSERT INTO order_vehicle_types (order_id, vehicle_type) VALUES ($1, $2)', [rows[0].id, t]);
    return rows[0].id;
  });
  res.status(201).json({ order: toOrder((await loadOrders('o.id = $1', [id]))[0]) });
});

// Chỉ sửa đơn đang chờ xếp; version giúp phát hiện hai người sửa cùng lúc
router.put('/:id', async (req, res) => {
  const id = paramId(req);
  const version = integer(req.body?.version, 'phiên bản đơn');
  const o = readOrder(req.body);
  await transaction(async c => {
    const cur = (await c.query('SELECT status, version FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw notFound('Không tìm thấy đơn');
    if (cur.status !== 'pending') throw conflict('Chỉ sửa được đơn đang chờ xếp');
    if (cur.version !== version) throw conflict('Đơn vừa được sửa ở nơi khác, tải lại trước khi lưu');
    const dup = await c.query('SELECT 1 FROM orders WHERE code = $1 AND id <> $2', [o.code, id]);
    if (dup.rows.length) throw conflict('Mã đơn đã tồn tại');
    await c.query(
      `UPDATE orders SET code = $2, recipient_name = $3, phone = $4, address = $5, latitude = $6, longitude = $7,
                         weight_kg = $8, note = $9, version = version + 1 WHERE id = $1`,
      [id, o.code, o.recipientName, o.phone, o.address, o.lat, o.lon, o.weightKg, o.note]);
    await c.query('DELETE FROM order_vehicle_types WHERE order_id = $1', [id]);
    for (const t of o.vehicleTypes) await c.query('INSERT INTO order_vehicle_types (order_id, vehicle_type) VALUES ($1, $2)', [id, t]);
  });
  res.json({ order: toOrder((await loadOrders('o.id = $1', [id]))[0]) });
});

// Hủy đơn chưa vào chuyến nào
router.post('/:id/cancel', async (req, res) => {
  const id = paramId(req);
  const { rowCount } = await query(`UPDATE orders SET status = 'cancelled', version = version + 1 WHERE id = $1 AND status = 'pending'`, [id]);
  if (!rowCount) throw conflict('Chỉ hủy được đơn đang chờ xếp');
  res.json({ order: toOrder((await loadOrders('o.id = $1', [id]))[0]) });
});

export default router;
