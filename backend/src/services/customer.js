// Khách theo dõi đơn qua đường dẫn có mã theo dõi (không đăng nhập) và tự hẹn lại trước khi tài xế đến.
// Trang chỉ nhận dữ liệu tối thiểu của đúng đơn đó: trạng thái, khung giờ dự kiến, số điểm dừng trước điểm của khách, vị trí
// xe khi chỉ còn tối đa 2 điểm dừng (bảo vệ vị trí tài xế), kết quả giao và tên gọi của tài xế. Không có thông tin của khách
// khác, không có số điện thoại tài xế.
// Khách hẹn "giao sau HH:MM": hệ thống tự sắp lại các điểm còn lại (Optimization Engine, xe đến sớm thì chờ); không kịp trước
// giờ hết ca thì đơn ra khỏi chuyến, về chờ xếp ca sau. Khách hẹn ngày khác: đơn ra khỏi chuyến, về chờ xếp. Điều phối viên
// và tài xế không phải thao tác; nhật ký chuyến ghi người thực hiện là khách hàng.
import { config } from '../config.js';
import { query, transaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { atSeconds, clockText, nextClock, roundUp } from './clock.js';
import { haversineM, locationKey } from './matrix.js';
import { addEvent, addRouteVersion, currentOrder, fillGeometryLater, loadTrip, lockTrip, remainingContext } from './trips.js';

const TOKEN = /^[0-9a-f]{64}$/;
const MIN = 60_000;
const OPEN = ['assigned', 'in_progress'];

async function orderByToken(token) {
  if (!TOKEN.test(String(token))) throw notFound('Không tìm thấy đơn');
  const o = (await query('SELECT id, code, status, latitude, longitude, not_before_at FROM orders WHERE tracking_token = $1', [token])).rows[0];
  if (!o) throw notFound('Không tìm thấy đơn');
  return o;
}

/** Tên gọi của tài xế: người Việt gọi theo tên, là chữ cuối của họ tên. */
const givenName = full => String(full ?? '').trim().split(/\s+/).at(-1) || null;

/** Chuyến của đơn: chuyến đang giữ đơn, nếu không thì chuyến gần nhất đã có kết quả giao. */
async function tripOf(orderId) {
  const a = (await query('SELECT trip_id, stop_id FROM active_assignments WHERE order_id = $1', [orderId])).rows[0];
  if (a) return { tripId: a.trip_id, stopId: a.stop_id, active: true };
  const s = (await query(
    `SELECT trip_id, id FROM trip_stops WHERE order_id = $1 AND status IN ('delivered', 'failed') ORDER BY id DESC LIMIT 1`, [orderId])).rows[0];
  return s ? { tripId: s.trip_id, stopId: s.id, active: false } : null;
}

const fresh = (trip, now) => trip.position && now - new Date(trip.position.observedAt).getTime() <= config.monitor.stalePositionSeconds * 1000;
/** Xe đã ở gần điểm giao: tài xế đang tới, khách không hẹn lại được nữa. */
const arriving = (trip, stop, now = Date.now()) => trip.status === 'in_progress' && fresh(trip, now)
  && haversineM(trip.position, stop.order) <= config.tracking.arrivingMeters;

/** Các giờ khách chọn được: mỗi 30 phút, từ ít nhất 30 phút sau bây giờ tới 30 phút trước giờ hết ca. */
function deferTimes(trip, now) {
  const end = trip.shiftEndAt ? new Date(trip.shiftEndAt).getTime() - 30 * MIN : now + 4 * 60 * MIN;
  const out = [];
  for (let t = roundUp(new Date(now + 30 * MIN), 30).getTime(); t <= end && out.length < 16; t += 30 * MIN) out.push(clockText(new Date(t)));
  return out;
}

/** Khung giờ dự kiến quanh giờ đến: rộng 15% thời gian còn lại mỗi phía (5–30 phút), làm tròn 5 phút, không trước giờ hẹn. */
function etaWindow(eta, now, notBeforeAt) {
  const t = new Date(eta).getTime();
  const half = Math.min(30 * MIN, Math.max(5 * MIN, 0.15 * (t - now)));
  const step = 5 * MIN;
  const from = Math.max(Math.floor((t - half) / step) * step, notBeforeAt ? new Date(notBeforeAt).getTime() : 0);
  return { from: new Date(from), to: new Date(Math.max(from + step, Math.ceil((t + half) / step) * step)) };
}

/** Dữ liệu trang theo dõi đơn của khách. */
export async function trackingView(token) {
  const o = await orderByToken(token);
  const link = await tripOf(o.id);
  const trip = link ? await loadTrip(link.tripId) : null;
  const stop = trip?.stops.find(s => s.id === link.stopId) ?? null;
  const now = Date.now();
  const view = {
    code: o.code, status: o.status, notBeforeAt: o.not_before_at,
    driverName: null, eta: null, stopsBefore: null, vehicle: null, destination: null, result: null, actions: null,
    updatedAt: new Date(now),
  };
  if (!trip || !stop) return view;
  view.driverName = givenName(trip.driver.name);
  if (stop.attempt && ['delivered', 'needs_action', 'return_to_sender', 'lost'].includes(o.status)) {
    view.result = { result: stop.attempt.result, at: stop.attempt.occurredAt, reason: stop.attempt.result === 'failed' ? stop.attempt.reason : null };
  }
  if (!link.active || stop.status !== 'pending' || !OPEN.includes(trip.status)) return view;
  if (stop.eta) view.eta = etaWindow(stop.eta, now, o.not_before_at);
  // Số điểm dừng (điểm giao khác nhau) xe còn phải ghé trước điểm của khách
  const mine = locationKey(stop.order.lat, stop.order.lon);
  const before = new Set(trip.stops.filter(s => s.status === 'pending' && s.seq < stop.seq).map(s => locationKey(s.order.lat, s.order.lon)));
  before.delete(mine);
  view.stopsBefore = before.size;
  // Vị trí xe chỉ hiện khi xe sắp tới: còn tối đa 2 điểm dừng trước điểm của khách
  if (trip.status === 'in_progress' && before.size <= 2 && fresh(trip, now)) {
    view.vehicle = { lat: trip.position.lat, lon: trip.position.lon, observedAt: trip.position.observedAt };
    view.destination = { lat: stop.order.lat, lon: stop.order.lon };
  }
  if (!arriving(trip, stop, now)) view.actions = { deferTimes: deferTimes(trip, now), shiftEndAt: trip.shiftEndAt };
  return view;
}

/** Đơn còn hẹn lại được: đang trong chuyến chưa kết thúc, chưa có kết quả, tài xế chưa tới gần. */
async function openStop(o) {
  const link = await tripOf(o.id);
  if (!link?.active) throw conflict('Đơn không còn trong chuyến giao');
  const trip = await loadTrip(link.tripId);
  const stop = trip?.stops.find(s => s.id === link.stopId);
  if (!trip || !OPEN.includes(trip.status) || !stop || stop.status !== 'pending') throw conflict('Đơn đã có kết quả giao hoặc chuyến đã kết thúc');
  if (arriving(trip, stop)) throw conflict('Tài xế đang đến điểm giao');
  return { trip, stop };
}

/**
 * Bỏ một điểm khỏi chuyến (khách hẹn lại): đơn về chờ xếp, giờ hẹn bỏ đi (ca sau xếp lại từ đầu), chuyến có phiên bản tuyến
 * mới gồm các điểm còn lại theo thứ tự cũ. Chuyến chưa xuất phát không còn điểm nào thì tự thu hồi.
 */
async function removeStop(c, t, { stopId, orderId, seconds }) {
  await c.query(`UPDATE trip_stops SET status = 'removed' WHERE id = $1`, [stopId]);
  await c.query('DELETE FROM active_assignments WHERE stop_id = $1', [stopId]);
  await c.query(`UPDATE orders SET status = 'pending', not_before_at = NULL, version = version + 1 WHERE id = $1`, [orderId]);
  const order = await currentOrder(c, t);
  if (!order.length && t.status === 'assigned') {
    await c.query(`UPDATE trips SET status = 'revoked', closed_at = now(), state_version = state_version + 1 WHERE id = $1`, [t.id]);
    await addEvent(c, { tripId: t.id, actorId: null, type: 'trip_revoked', payload: { orderIds: [], auto: true } });
    return { revoked: true };
  }
  const v = await addRouteVersion(c, t, { reason: 'customer', sequence: order.map(s => s.id), objectiveSeconds: seconds });
  return { ...v, stopIds: order.filter(s => s.status === 'pending').map(s => s.id) };
}

/** Thực hiện thao tác của khách; dữ liệu chuyến vừa đổi (tài xế ghi kết quả cùng lúc) thì tính lại, tối đa 3 lần. */
async function withRetry(fn) {
  for (let i = 0; i < 3; i++) {
    const out = await fn();
    if (out !== 'stale') return out;
  }
  throw conflict('Chuyến đang cập nhật, thử lại sau ít phút');
}

/** "Tôi không có nhà, giao sau HH:MM". */
export async function customerDefer(token, hhmm) {
  const o = await orderByToken(token);
  await withRetry(async () => {
    const { trip, stop } = await openStop(o);
    const now = new Date();
    const notBeforeAt = nextClock(hhmm, now);
    if (!notBeforeAt) throw badRequest('Giờ hẹn phải có dạng HH:MM');
    const shiftEnd = trip.shiftEndAt ? new Date(trip.shiftEndAt) : null;
    const ctx = await remainingContext(trip, { notBefore: new Map([[stop.id, notBeforeAt]]) });
    const pendingIds = ctx.pending.map(s => s.id);
    const without = pendingIds.filter(id => id !== stop.id);
    // Sắp lại phần còn lại với giờ hẹn mới; điểm kế tiếp của khách khác giữ nguyên để tài xế không phải quay đầu
    const next = trip.status === 'in_progress' ? ctx.pending[0] : null;
    const lockNext = Boolean(next && locationKey(next.order.lat, next.order.lon) !== locationKey(stop.order.lat, stop.order.lon));
    let ev = null;
    let etaAt = null;
    let feasible = !shiftEnd || notBeforeAt < shiftEnd;
    if (feasible) {
      ev = ctx.evaluate({ lockNext });
      const sched = ev.valid ? ctx.schedule(ev.proposedStopIds) : null;
      if (!sched) feasible = false;
      else {
        etaAt = atSeconds(ctx.base, sched.arrivals[ev.proposedStopIds.indexOf(stop.id)]);
        const endAt = atSeconds(ctx.base, sched.end);
        if (shiftEnd && (etaAt > shiftEnd || endAt > shiftEnd)) {
          // Chuyến đã về kho sau giờ hết ca kể cả khi bỏ đơn này thì chỉ cần giao được trước giờ hết ca
          const rest = ctx.schedule(without);
          feasible = etaAt <= shiftEnd && Boolean(rest) && atSeconds(ctx.base, rest.end) > shiftEnd;
        }
      }
    }
    const restSeconds = ctx.schedule(without)?.seconds ?? 0;
    const out = await transaction(async c => {
      const t = await lockTrip(c, trip.id);
      if (t.state_version !== trip.stateVersion) return 'stale';
      const base = { by: 'customer', stopId: stop.id, orderId: o.id, orderCode: o.code, notBeforeAt };
      if (!feasible) {
        const v = await removeStop(c, t, { stopId: stop.id, orderId: o.id, seconds: restSeconds });
        await addEvent(c, {
          tripId: t.id, actorId: null, type: 'customer_deferred',
          payload: { ...base, outcome: 'requeued', reasonText: 'Không kịp giao trước giờ hết ca', ...v, start: { lat: ctx.start.lat, lon: ctx.start.lon } },
        });
        return { v, points: v.stopIds };
      }
      await c.query('UPDATE orders SET not_before_at = $2, version = version + 1 WHERE id = $1', [o.id, notBeforeAt]);
      const order = await currentOrder(c, t);
      const changed = ev.proposedStopIds.join(',') !== order.filter(s => s.status === 'pending').map(s => s.id).join(',');
      const v = changed ? await addRouteVersion(c, t, {
        reason: 'customer', sequence: [...order.filter(s => s.status !== 'pending').map(s => s.id), ...ev.proposedStopIds],
        objectiveSeconds: ev.proposedSeconds,
      }) : null;
      await addEvent(c, {
        tripId: t.id, actorId: null, type: 'customer_deferred',
        payload: {
          ...base, outcome: changed ? 'resequenced' : 'kept', etaAt,
          ...(v ? { ...v, stopIds: ev.proposedStopIds, start: { lat: ctx.start.lat, lon: ctx.start.lon } } : {}),
        },
      });
      if (!changed) await c.query('UPDATE trips SET state_version = state_version + 1 WHERE id = $1', [t.id]);
      return { v, points: v ? ev.proposedStopIds : null };
    });
    if (out === 'stale') return out;
    if (out.v?.routeVersionId && out.points) {
      const byId = new Map(trip.stops.map(s => [s.id, s.order]));
      fillGeometryLater(out.v.routeVersionId, [ctx.start, ...out.points.map(id => byId.get(id)), trip.depot], ctx.profile);
    }
    return out;
  });
  return trackingView(token);
}

/** "Hẹn ngày khác": đơn ra khỏi chuyến, về chờ xếp. */
export async function customerReschedule(token) {
  const o = await orderByToken(token);
  await withRetry(async () => {
    const { trip, stop } = await openStop(o);
    const ctx = await remainingContext(trip);
    const without = ctx.pending.map(s => s.id).filter(id => id !== stop.id);
    const seconds = ctx.schedule(without)?.seconds ?? 0;
    const out = await transaction(async c => {
      const t = await lockTrip(c, trip.id);
      if (t.state_version !== trip.stateVersion) return 'stale';
      const v = await removeStop(c, t, { stopId: stop.id, orderId: o.id, seconds });
      await addEvent(c, {
        tripId: t.id, actorId: null, type: 'customer_rescheduled',
        payload: { by: 'customer', stopId: stop.id, orderId: o.id, orderCode: o.code, reasonText: 'Khách hẹn ngày khác', ...v, start: { lat: ctx.start.lat, lon: ctx.start.lon } },
      });
      return v;
    });
    if (out === 'stale') return out;
    if (out.routeVersionId && out.stopIds?.length) {
      const byId = new Map(trip.stops.map(s => [s.id, s.order]));
      fillGeometryLater(out.routeVersionId, [ctx.start, ...out.stopIds.map(id => byId.get(id)), trip.depot], ctx.profile);
    }
    return out;
  });
  return trackingView(token);
}
