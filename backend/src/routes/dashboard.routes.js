// Tổng quan ca làm việc của Dispatcher (D01): chỉ số, việc cần xử lý (vị trí cũ, chuyến trễ, chuyến chưa xuất phát,
// lần giao chưa thành công vừa xảy ra, chờ đối chiếu, hàng không khớp), chuyến đang giao.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { loadDepot } from '../services/planning.js';
import { ACTIVE_STATUSES, loadTrip } from '../services/trips.js';

const router = Router();
router.use(requireRole('dispatcher'));

router.get('/', async (_req, res) => {
  const counts = (await query(
    `SELECT count(*) FILTER (WHERE o.status = 'pending') AS pending,
            count(*) FILTER (WHERE o.status = 'pending' AND NOT EXISTS (
              SELECT 1 FROM order_vehicle_types t WHERE t.order_id = o.id AND t.vehicle_type = 'motorcycle')) AS truck_only,
            count(*) FILTER (WHERE o.status = 'needs_action') AS needs_action
       FROM orders o`)).rows[0];
  const ids = (await query('SELECT id FROM trips WHERE status = ANY($1) ORDER BY id', [ACTIVE_STATUSES])).rows.map(r => r.id);
  const trips = [];
  for (const id of ids) trips.push(await loadTrip(id));

  const now = Date.now();
  const m = config.monitor;
  const todo = [];
  for (const t of trips) {
    const base = { tripId: t.id, tripCode: t.code, plate: t.vehicle.plate, driverName: t.driver.name, driverPhone: t.driver.phone };
    if (t.status === 'in_progress' && (!t.position || now - new Date(t.position.observedAt).getTime() > m.stalePositionSeconds * 1000)) {
      todo.push({ type: 'stale_position', ...base, observedAt: t.position?.observedAt ?? null });
    }
    // Trễ so với kế hoạch: giờ về kho dự kiến muộn hơn giờ về theo tuyến ban đầu, hoặc quá giới hạn thời lượng chuyến
    const overShift = t.status === 'in_progress' && t.etaReturn && t.shiftEndAt && t.etaReturn > t.shiftEndAt;
    if (t.status === 'in_progress' && ((t.lateSeconds ?? 0) > m.lateMinutes * 60 || overShift)) {
      todo.push({ type: 'late', ...base, etaReturn: t.etaReturn, plannedReturnAt: t.plannedReturnAt, shiftEndAt: t.shiftEndAt, lateSeconds: t.lateSeconds, overShift: Boolean(overShift) });
    }
    // Đơn dự kiến bắt đầu giao sau giờ kết thúc khung giờ khách hẹn: gọi khách báo trước hoặc hẹn lại
    if (t.status === 'in_progress') {
      for (const s of t.stops) {
        if (s.status !== 'pending' || !(s.etaLateSeconds > 0)) continue;
        todo.push({
          type: 'window_late', ...base, stopId: s.id, orderCode: s.order.code, recipientName: s.order.recipientName,
          phone: s.order.phone, windowEnd: s.order.windowEnd, eta: s.eta, lateSeconds: s.etaLateSeconds,
        });
      }
    }
    if (t.status === 'assigned' && now - new Date(t.createdAt).getTime() > m.assignedIdleMinutes * 60_000) {
      todo.push({ type: 'not_started', ...base, createdAt: t.createdAt });
    }
    // Lần giao chưa thành công vừa xảy ra: gọi khách khi tài xế còn ở gần
    if (t.status === 'in_progress') {
      for (const s of t.stops) {
        if (s.status !== 'failed' || now - new Date(s.attempt.occurredAt).getTime() > m.failedAlertMinutes * 60_000) continue;
        todo.push({
          type: 'failed_attempt', ...base, stopId: s.id, orderCode: s.order.code, recipientName: s.order.recipientName,
          phone: s.order.phone, address: s.order.address, reason: s.attempt.reason, occurredAt: s.attempt.occurredAt,
        });
      }
    }
    if (t.status === 'awaiting_reconciliation') {
      todo.push({ type: 'reconcile', ...base, failed: t.progress.failed, returnedAt: t.returnedAt, aborted: Boolean(t.returnReport?.aborted) });
    }
    if (t.loadingMismatch) {
      todo.push({ type: 'loading_mismatch', ...base, missingOrderIds: t.loadingMismatch.missingOrderIds });
    }
  }
  const inProgress = trips.filter(t => t.status === 'in_progress');
  const depot = await loadDepot();
  res.json({
    depot: depot && { id: depot.id, name: depot.name, lat: depot.latitude, lon: depot.longitude },
    metrics: {
      pendingOrders: Number(counts.pending),
      truckOnlyOrders: Number(counts.truck_only),
      needsActionOrders: Number(counts.needs_action),
      tripsInProgress: inProgress.length,
      stopsDone: inProgress.reduce((s, t) => s + t.progress.done, 0),
      stopsTotal: inProgress.reduce((s, t) => s + t.progress.total, 0),
      awaitingReconciliation: trips.filter(t => t.status === 'awaiting_reconciliation').length,
      assigned: trips.filter(t => t.status === 'assigned').length,
      warnings: todo.filter(x => ['stale_position', 'loading_mismatch', 'late', 'window_late', 'not_started'].includes(x.type)).length,
    },
    thresholds: { stalePositionSeconds: m.stalePositionSeconds, assignedIdleMinutes: m.assignedIdleMinutes, lateMinutes: m.lateMinutes },
    todo,
    trips,
    serverTime: new Date(),
  });
});

export default router;
