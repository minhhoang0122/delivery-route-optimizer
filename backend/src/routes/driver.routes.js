// Ứng dụng Driver: xem nhiệm vụ (UC10), xác nhận tuyến mới (UC10.1), bắt đầu chuyến (UC11), gửi vị trí (UC12),
// ghi kết quả (UC13), báo về kho (UC14), xem lại chuyến của mình (UC15).
// Driver chỉ đọc và thao tác trên chuyến được giao cho chính mình.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { query } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { eventPayload, fingerprint, requireEventId } from '../idempotency.js';
import { acknowledgeRoute, ACTIVE_STATUSES, loadTrip, recordAttempt, recordPosition, returnTrip, startTrip, tripCode } from '../services/trips.js';
import { idList, integer, number, oneOf, paramId, text, timestamp } from '../validate.js';

const router = Router();
router.use(requireRole('driver'));

export const FAIL_REASONS = ['Vắng nhà', 'Không liên lạc được', 'Sai địa chỉ', 'Khách từ chối nhận', 'Khác'];

function requireProfile(req) {
  if (!req.user.driver_id) throw forbidden('Tài khoản chưa có hồ sơ Driver. Liên hệ Dispatcher.');
  return req.user.driver_id;
}

async function ownTrip(req) {
  const driverId = requireProfile(req);
  const trip = await loadTrip(paramId(req));
  if (!trip) throw notFound('Không tìm thấy chuyến');
  if (trip.driver.id !== driverId) throw forbidden('Chuyến không được giao cho bạn');
  return trip;
}

router.get('/current-trip', async (req, res) => {
  const driverId = requireProfile(req);
  const { rows } = await query('SELECT id FROM trips WHERE driver_id = $1 AND status = ANY($2) ORDER BY id DESC LIMIT 1', [driverId, ACTIVE_STATUSES]);
  res.json({ trip: rows[0] ? await loadTrip(rows[0].id) : null, serverTime: new Date() });
});

router.get('/trips', async (req, res) => {
  const driverId = requireProfile(req);
  const { rows } = await query(
    `SELECT t.id, t.status, t.created_at, t.started_at, t.returned_at, t.closed_at,
            count(s.id) AS total,
            count(s.id) FILTER (WHERE s.status = 'delivered') AS delivered,
            count(s.id) FILTER (WHERE s.status = 'failed') AS failed
       FROM trips t LEFT JOIN trip_stops s ON s.trip_id = t.id
      WHERE t.driver_id = $1
      GROUP BY t.id ORDER BY t.id DESC LIMIT 30`, [driverId]);
  res.json({
    trips: rows.map(r => ({
      id: r.id, code: tripCode(r.id), status: r.status, createdAt: r.created_at, startedAt: r.started_at,
      returnedAt: r.returned_at, closedAt: r.closed_at,
      total: Number(r.total), delivered: Number(r.delivered), failed: Number(r.failed),
    })),
  });
});

router.get('/trips/:id', async (req, res) => {
  res.json({ trip: await ownTrip(req) });
});

router.post('/trips/:id/start', async (req, res) => {
  const id = paramId(req);
  const clientEventId = requireEventId(req.body);
  await startTrip(id, req.user, {
    checkedOrderIds: idList(req.body?.checkedOrderIds ?? [], 'kiện', { min: 0 }),
    clientEventId, fp: fingerprint(eventPayload(req.body)),
  });
  res.json({ trip: await loadTrip(id) });
});

router.post('/trips/:id/positions', async (req, res) => {
  const observedAt = timestamp(req.body?.observedAt, 'thời điểm ghi nhận');
  if (observedAt.getTime() > Date.now() + 60_000) throw badRequest('Thời điểm ghi nhận ở tương lai');
  await recordPosition(paramId(req), req.user, {
    lat: number(req.body?.lat, 'vĩ độ', { min: -90, max: 90 }),
    lon: number(req.body?.lon, 'kinh độ', { min: -180, max: 180 }),
    observedAt,
    accuracyM: number(req.body?.accuracyM, 'độ chính xác', { required: false, min: 0, max: 99999 }),
    source: oneOf(req.body?.source ?? 'device', 'nguồn vị trí', ['device', 'simulator']),
    clientEventId: requireEventId(req.body),
  });
  res.status(204).end();
});

router.post('/trips/:id/stops/:stopId/attempts', async (req, res) => {
  const id = paramId(req);
  const clientEventId = requireEventId(req.body);
  const result = oneOf(req.body?.result, 'kết quả', ['delivered', 'failed']);
  const reason = result === 'failed' ? oneOf(req.body?.reason, 'lý do chưa giao được', FAIL_REASONS) : null;
  const note = text(req.body?.note, 'ghi chú', { required: reason === 'Khác', max: 255 });
  const occurredAt = timestamp(req.body?.occurredAt, 'thời điểm', { required: false }) ?? new Date();
  if (occurredAt.getTime() > Date.now() + 60_000) throw badRequest('Thời điểm ghi kết quả ở tương lai');
  const out = await recordAttempt(id, paramId(req, 'stopId'), req.user, {
    result, reason, note, occurredAt, clientEventId, fp: fingerprint(eventPayload(req.body)),
  });
  res.status(out.replayed ? 200 : 201).json({ replayed: out.replayed, trip: await loadTrip(id) });
});

router.post('/trips/:id/route-ack', async (req, res) => {
  const id = paramId(req);
  const clientEventId = requireEventId(req.body);
  await acknowledgeRoute(id, req.user, {
    routeVersionId: integer(req.body?.routeVersionId, 'phiên bản tuyến'),
    clientEventId, fp: fingerprint(eventPayload(req.body)),
  });
  res.json({ trip: await loadTrip(id) });
});

router.post('/trips/:id/return', async (req, res) => {
  const id = paramId(req);
  const clientEventId = requireEventId(req.body);
  await returnTrip(id, req.user, {
    returnedOrderIds: idList(req.body?.returnedOrderIds ?? [], 'kiện', { min: 0 }),
    clientEventId, fp: fingerprint(eventPayload(req.body)),
  });
  res.json({ trip: await loadTrip(id) });
});

export default router;
