// Theo dõi chuyến (UC06), điều chỉnh tuyến (UC07), đối chiếu và chốt chuyến (UC08, UC09), thu hồi (UC16). Dispatcher.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { query } from '../db.js';
import { notFound } from '../errors.js';
import { eventPayload, fingerprint, requireEventId } from '../idempotency.js';
import { ACTIVE_STATUSES, approveReroute, closeTrip, dismissReroute, evaluateTripReroute, loadTrip, revokeTrip } from '../services/trips.js';
import { integer, oneOf, paramId } from '../validate.js';

const router = Router();
router.use(requireRole('dispatcher'));

const STATUSES = ['assigned', 'in_progress', 'awaiting_reconciliation', 'closed', 'revoked'];

// ?status=active trả về mọi chuyến chưa kết thúc; có thể truyền nhiều trạng thái cách nhau dấu phẩy
router.get('/', async (req, res) => {
  const raw = String(req.query.status || 'active');
  const statuses = raw === 'active' ? ACTIVE_STATUSES : raw.split(',').map(s => oneOf(s, 'trạng thái', STATUSES));
  const { rows } = await query(
    `SELECT id FROM trips WHERE status = ANY($1) ORDER BY id DESC LIMIT $2`,
    [statuses, integer(req.query.limit, 'số dòng', { required: false, min: 1, max: 200 }) ?? 50]);
  const trips = [];
  for (const r of rows) trips.push(await loadTrip(r.id));
  res.json({ trips, serverTime: new Date() });
});

router.get('/:id', async (req, res) => {
  const trip = await loadTrip(paramId(req), { withEvents: true });
  if (!trip) throw notFound('Không tìm thấy chuyến');
  res.json({ trip });
});

router.post('/:id/revoke', async (req, res) => {
  const id = paramId(req);
  const clientEventId = requireEventId(req.body);
  await revokeTrip(id, req.user, {
    stateVersion: integer(req.body?.stateVersion, 'phiên bản chuyến'),
    goodsReturned: req.body?.goodsReturned === true,
    clientEventId, fp: fingerprint(eventPayload(req.body)),
  });
  res.json({ trip: await loadTrip(id, { withEvents: true }) });
});

router.post('/:id/close', async (req, res) => {
  const id = paramId(req);
  const clientEventId = requireEventId(req.body);
  await closeTrip(id, req.user, {
    stateVersion: integer(req.body?.stateVersion, 'phiên bản chuyến'),
    goodsMatched: req.body?.goodsMatched === true,
    decisions: Array.isArray(req.body?.decisions) ? req.body.decisions : [],
    clientEventId, fp: fingerprint(eventPayload(req.body)),
  });
  res.json({ trip: await loadTrip(id, { withEvents: true }) });
});

router.post('/:id/reroute-evaluations', async (req, res) => {
  const evaluation = await evaluateTripReroute(paramId(req), req.user);
  res.status(201).json({ evaluation });
});

router.post('/:id/reroute-evaluations/:eventId/approve', async (req, res) => {
  const id = paramId(req);
  await approveReroute(id, paramId(req, 'eventId'), req.user);
  res.json({ trip: await loadTrip(id, { withEvents: true }) });
});

router.post('/:id/reroute-evaluations/:eventId/dismiss', async (req, res) => {
  const id = paramId(req);
  await dismissReroute(id, paramId(req, 'eventId'), req.user);
  res.json({ trip: await loadTrip(id, { withEvents: true }) });
});

export default router;
