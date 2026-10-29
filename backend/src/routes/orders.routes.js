// UC02 Quản lý đơn hàng (Dispatcher): danh sách, tạo, sửa trước khi lập kế hoạch.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { config } from '../config.js';
import { query, transaction } from '../db.js';
import { badRequest, conflict, HttpError, notFound } from '../errors.js';
import { integer, mobilePhone, number, oneOf, paramId, phoneDigits, servicePoint, text } from '../validate.js';
import { loadOrders } from '../services/planning.js';
import { tripCode } from '../services/trips.js';
import { parseClock } from '../services/clock.js';
import { clockLabel } from '../services/window.js';

const router = Router();
router.use(requireRole('dispatcher'));

const TYPES = ['motorcycle', 'small_truck'];
const STATUSES = ['pending', 'assigned', 'in_delivery', 'delivered', 'needs_action', 'cancelled', 'return_to_sender', 'lost'];

export const toOrder = o => ({
  id: o.id,
  code: o.code,
  recipientName: o.recipient_name,
  phone: o.phone,
  address: o.address,
  lat: o.latitude,
  lon: o.longitude,
  weightKg: o.weight_kg,
  parcels: o.parcels,
  vehicleTypes: o.vehicle_types,
  status: o.status,
  version: o.version,
  note: o.note,
  createdAt: o.created_at,
  // Khách hẹn giao sau giờ này (trang theo dõi đơn) và mã theo dõi để điều phối viên gửi đường dẫn cho khách
  notBeforeAt: o.not_before_at,
  // Khung giờ giao trong ngày (HH:MM), null nếu không giới hạn đầu đó
  windowStart: clockLabel(o.window_start),
  windowEnd: clockLabel(o.window_end),
  trackingToken: o.tracking_token,
  trip: o.trip_id ? { id: o.trip_id, code: tripCode(o.trip_id) } : null,
});

router.get('/', async (req, res) => {
  const status = req.query.status;
  const rows = status
    ? await loadOrders('o.status = $1', [oneOf(status, 'trạng thái', STATUSES)])
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
            (SELECT count(*) FROM trip_stops s2 WHERE s2.order_id = o.id AND s2.status = 'failed') AS attempt_count
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
    maxDeliveryAttempts: config.maxDeliveryAttempts,
  });
});

router.get('/:id', async (req, res) => {
  const rows = await loadOrders('o.id = $1', [paramId(req)]);
  if (!rows[0]) throw notFound('Không tìm thấy đơn');
  // Chuyến gần nhất có đơn này (đang giao hoặc đã kết thúc)
  const trip = (await query(
    `SELECT trip_id FROM trip_stops WHERE order_id = $1 AND status <> 'removed' ORDER BY id DESC LIMIT 1`, [rows[0].id])).rows[0];
  res.json({ order: toOrder({ ...rows[0], trip_id: trip?.trip_id }) });
});

function readOrder(body) {
  const vehicleTypes = Array.isArray(body?.vehicleTypes) ? [...new Set(body.vehicleTypes)] : [];
  if (!vehicleTypes.length) throw badRequest('Chọn ít nhất một loại xe được phép');
  vehicleTypes.forEach(t => oneOf(t, 'loại xe', TYPES));
  return {
    code: text(body?.code, 'mã đơn', { max: 20 }),
    recipientName: text(body?.recipientName, 'người nhận', { max: 100 }),
    phone: mobilePhone(body?.phone, 'số điện thoại'),
    address: text(body?.address, 'địa chỉ', { max: 255 }),
    ...servicePoint(body?.lat, body?.lon, 'Vị trí giao'),
    weightKg: number(body?.weightKg, 'khối lượng', { gt: 0, max: 999999 }),
    parcels: integer(body?.parcels ?? 1, 'số kiện', { min: 1, max: 999 }),
    note: text(body?.note, 'ghi chú', { required: false, max: 255 }),
    vehicleTypes,
    ...readWindow(body),
    allowDuplicate: body?.allowDuplicate === true,
  };
}

/** Khung giờ giao "HH:MM"–"HH:MM", mỗi đầu có thể bỏ trống; có cả hai đầu thì giờ bắt đầu phải trước giờ kết thúc. */
function readWindow(body) {
  const one = (v, label) => {
    if (v == null || v === '') return null;
    if (parseClock(v) == null) throw badRequest(`${label} phải có dạng HH:MM`);
    return String(v).trim().padStart(5, '0');
  };
  const windowStart = one(body?.windowStart, 'Giờ bắt đầu khung giờ giao');
  const windowEnd = one(body?.windowEnd, 'Giờ kết thúc khung giờ giao');
  if (windowStart && windowEnd && parseClock(windowStart) >= parseClock(windowEnd)) {
    throw badRequest('Giờ bắt đầu khung giờ giao phải trước giờ kết thúc');
  }
  return { windowStart, windowEnd };
}

/**
 * Kiểm tra theo dữ liệu hiện có: khối lượng không vượt tải trọng lớn nhất của xe đang hoạt động thuộc các loại được phép,
 * và cảnh báo đơn trùng (cùng người nhận, địa chỉ, số điện thoại đang chờ xếp) trừ khi Dispatcher xác nhận vẫn lưu.
 */
async function checkOrder(c, o, id = 0) {
  const cap = (await c.query(
    `SELECT max(capacity_kg) AS kg, bool_or(capacity_parcels IS NULL) AS unlimited, max(capacity_parcels) AS parcels
       FROM vehicles WHERE status = 'active' AND vehicle_type = ANY($1)`, [o.vehicleTypes])).rows[0];
  if (cap.kg != null && o.weightKg > cap.kg) throw badRequest(`Khối lượng vượt tải trọng lớn nhất của xe được phép (${cap.kg} kg)`);
  if (cap.kg != null && !cap.unlimited && o.parcels > cap.parcels) throw badRequest(`Số kiện vượt sức chứa lớn nhất của xe được phép (${cap.parcels} kiện)`);
  if (o.allowDuplicate) return;
  const same = (await c.query(
    `SELECT code, phone FROM orders WHERE status = 'pending' AND id <> $1
        AND lower(trim(recipient_name)) = lower($2) AND lower(trim(address)) = lower($3)`, [id, o.recipientName, o.address])).rows
    .filter(r => phoneDigits(r.phone) === phoneDigits(o.phone));
  if (same.length) {
    throw new HttpError(409, 'DUPLICATE_ORDER', `Trùng với đơn ${same.map(r => r.code).join(', ')} đang chờ xếp`, { codes: same.map(r => r.code) });
  }
}

router.post('/', async (req, res) => {
  const o = readOrder(req.body);
  const id = await transaction(async c => {
    const dup = await c.query('SELECT 1 FROM orders WHERE code = $1', [o.code]);
    if (dup.rows.length) throw conflict('Mã đơn đã tồn tại');
    await checkOrder(c, o);
    const { rows } = await c.query(
      `INSERT INTO orders (code, recipient_name, phone, address, latitude, longitude, weight_kg, note, parcels, window_start, window_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [o.code, o.recipientName, o.phone, o.address, o.lat, o.lon, o.weightKg, o.note, o.parcels, o.windowStart, o.windowEnd]);
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
    await checkOrder(c, o, id);
    await c.query(
      `UPDATE orders SET code = $2, recipient_name = $3, phone = $4, address = $5, latitude = $6, longitude = $7,
                         weight_kg = $8, note = $9, parcels = $10, window_start = $11, window_end = $12,
                         version = version + 1 WHERE id = $1`,
      [id, o.code, o.recipientName, o.phone, o.address, o.lat, o.lon, o.weightKg, o.note, o.parcels, o.windowStart, o.windowEnd]);
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
