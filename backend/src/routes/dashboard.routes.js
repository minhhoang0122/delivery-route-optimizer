// Tổng quan ca làm việc của Dispatcher (D01): chỉ số, việc cần xử lý, chuyến đang giao.
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { config } from '../config.js';
import { query } from '../db.js';
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
  const maxAge = config.reroute.maxPositionAgeSeconds * 1000;
  const todo = [];
  for (const t of trips) {
    if (t.status === 'in_progress' && (!t.position || now - new Date(t.position.observedAt).getTime() > maxAge)) {
      todo.push({ type: 'stale_position', tripId: t.id, tripCode: t.code, plate: t.vehicle.plate, observedAt: t.position?.observedAt ?? null });
    }
    if (t.proposal && !t.proposal.outdated && t.proposal.meetsThreshold) {
      todo.push({ type: 'reroute_proposal', tripId: t.id, tripCode: t.code, savingSeconds: t.proposal.savingSeconds, remaining: t.proposal.currentStopIds.length });
    }
    if (t.status === 'awaiting_reconciliation') {
      todo.push({ type: 'reconcile', tripId: t.id, tripCode: t.code, failed: t.progress.failed, returnedAt: t.returnedAt });
    }
    if (t.loadingMismatch) {
      todo.push({ type: 'loading_mismatch', tripId: t.id, tripCode: t.code, missingOrderIds: t.loadingMismatch.missingOrderIds });
    }
  }
  const inProgress = trips.filter(t => t.status === 'in_progress');
  res.json({
    metrics: {
      pendingOrders: Number(counts.pending),
      truckOnlyOrders: Number(counts.truck_only),
      needsActionOrders: Number(counts.needs_action),
      tripsInProgress: inProgress.length,
      stopsDone: inProgress.reduce((s, t) => s + t.progress.done, 0),
      stopsTotal: inProgress.reduce((s, t) => s + t.progress.total, 0),
      awaitingReconciliation: trips.filter(t => t.status === 'awaiting_reconciliation').length,
      assigned: trips.filter(t => t.status === 'assigned').length,
      warnings: todo.filter(x => x.type === 'stale_position' || x.type === 'reroute_proposal' || x.type === 'loading_mismatch').length,
    },
    todo,
    trips,
    serverTime: new Date(),
  });
});

export default router;
