// UC04 Lập kế hoạch và UC05 Duyệt, giao chuyến (Dispatcher).
// Tính phương án có thể kéo dài khi phải lấy dữ liệu TomTom, nên yêu cầu trả về mã lần tính ngay;
// giao diện hỏi lại tiến độ theo mã đó (mục 3.3.4).
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { eventPayload, fingerprint, requireEventId } from '../idempotency.js';
import { getProgress, loadDepot, loadOrders, loadVehicles, orderProblem, prepareSnapshot, runPlanning, vehicleProblem } from '../services/planning.js';
import { commitPlan, planCode } from '../services/trips.js';
import { clockText, roundUp } from '../services/clock.js';
import { idList, integer, paramId, text } from '../validate.js';
import { toOrder } from './orders.routes.js';

const router = Router();
router.use(requireRole('dispatcher'));

/** Dữ liệu cho màn Lập kế hoạch (D08): đơn chờ xếp và xe kèm Driver thường dùng. */
router.get('/options', async (_req, res) => {
  const depot = await loadDepot();
  const orders = await loadOrders();
  const vehicles = await loadVehicles();
  res.json({
    depot: depot && { id: depot.id, name: depot.name, lat: depot.latitude, lon: depot.longitude },
    orders: orders.map(o => ({ ...toOrder(o), problem: orderProblem(o) })),
    vehicles: vehicles.map(v => ({
      id: v.id, plate: v.plate, type: v.vehicle_type, capacityKg: v.capacity_kg, capacityParcels: v.capacity_parcels, routingProfile: v.routing_profile, status: v.status,
      driver: v.driver_id ? { id: v.driver_id, name: v.driver_name } : null,
      problem: vehicleProblem(v),
    })),
    defaults: {
      shiftStart: clockText(roundUp(new Date(), 5)), shiftEnd: config.defaultShiftEnd,
      stopSeconds: config.stopSeconds, serviceSeconds: config.serviceSecondsPerOrder,
      matrixSource: config.matrixSource, hasTomTomKey: Boolean(config.tomtomKey),
    },
  });
});

const toRun = (r, extra = {}) => ({
  id: r.id,
  code: planCode(r.id),
  status: r.status,
  createdAt: r.created_at,
  createdBy: r.created_by_name ?? null,
  snapshot: r.input_snapshot,
  result: r.result,
  progress: r.status === 'running' ? getProgress(r.id) : null,
  ...extra,
});

router.post('/runs', async (req, res) => {
  const clientEventId = requireEventId(req.body);
  const fp = fingerprint(eventPayload(req.body));
  const prior = (await query('SELECT * FROM planning_runs WHERE client_event_id = $1', [clientEventId])).rows[0];
  if (prior) {
    if (prior.request_fingerprint !== fp) throw conflict('Mã thao tác đã được dùng cho một nội dung khác');
    return res.status(202).json({ run: toRun(prior) });
  }
  const orderIds = idList(req.body?.orderIds, 'đơn');
  const vehicleIds = idList(req.body?.vehicleIds, 'xe');
  // Giờ bắt đầu và giờ hết ca (HH:MM); maxRouteMinutes là tùy chọn cũ, vẫn nhận để tương thích
  const shiftStart = text(req.body?.shiftStart, 'giờ bắt đầu ca', { required: false, max: 5 });
  const shiftEnd = text(req.body?.shiftEnd, 'giờ hết ca', { required: false, max: 5 });
  const maxRouteMinutes = integer(req.body?.maxRouteMinutes, 'giới hạn thời lượng chuyến', { required: false, min: 0, max: 24 * 60 });
  const snapshot = await prepareSnapshot({ orderIds, vehicleIds, shiftStart, shiftEnd, maxRouteMinutes });
  const { rows } = await query(
    `INSERT INTO planning_runs (created_by, input_snapshot, status, client_event_id, request_fingerprint)
     VALUES ($1, $2, 'running', $3, $4) RETURNING *`, [req.user.id, snapshot, clientEventId, fp]);
  // Chạy nền, không chờ: giao diện theo dõi tiến độ qua GET /runs/:id
  runPlanning(rows[0].id, snapshot);
  res.status(202).json({ run: toRun(rows[0], { progress: { step: 'matrix', done: 0, total: 0 } }) });
});

router.get('/runs', async (_req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.status, r.created_at, u.full_name AS created_by_name,
            jsonb_array_length(r.input_snapshot->'orders') AS order_count,
            jsonb_array_length(COALESCE(r.result->'routes', '[]')) AS route_count
       FROM planning_runs r JOIN users u ON u.id = r.created_by
      ORDER BY r.id DESC LIMIT 20`);
  res.json({
    runs: rows.map(r => ({
      id: r.id, code: planCode(r.id), status: r.status, createdAt: r.created_at, createdBy: r.created_by_name,
      orderCount: r.order_count, routeCount: r.route_count,
    })),
  });
});

router.get('/runs/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, u.full_name AS created_by_name FROM planning_runs r JOIN users u ON u.id = r.created_by WHERE r.id = $1`, [paramId(req)]);
  if (!rows[0]) throw notFound('Không tìm thấy lần lập kế hoạch');
  const trips = rows[0].status === 'committed'
    ? (await query('SELECT id FROM trips WHERE planning_run_id = $1 ORDER BY id', [rows[0].id])).rows.map(r => r.id) : [];
  res.json({ run: toRun(rows[0], { tripIds: trips }) });
});

router.post('/runs/:id/commit', async (req, res) => {
  const clientEventId = requireEventId(req.body);
  const fp = fingerprint({ runId: paramId(req), ...eventPayload(req.body) });
  const out = await commitPlan(paramId(req), req.user, { clientEventId, fp });
  res.status(out.replayed ? 200 : 201).json(out);
});

export default router;
