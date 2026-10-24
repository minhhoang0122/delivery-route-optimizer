// Chuyến giao: giao chuyến từ bản nháp (UC05), bắt đầu chuyến (UC11), ghi kết quả (UC13), báo về kho (UC14),
// đối chiếu và chốt chuyến (UC09), thu hồi (UC16), tự điều chỉnh tuyến còn lại (UC07) và ghi nhận thiết bị Driver đã nhận tuyến (UC10.1).
// Ngoại lệ: kết thúc chuyến do sự cố, giao sau (dời điểm xuống cuối tuyến), bỏ đơn thiếu khỏi chuyến trước khi xuất phát.
// Mọi thao tác ghi khóa dòng trips bằng SELECT … FOR UPDATE rồi kiểm tra trạng thái, nên hai thao tác đồng thời
// trên cùng chuyến (ví dụ bắt đầu và thu hồi) chỉ có một thao tác thành công.
import { detectIncrease, evaluateReroute, stopSchedule } from 'optimization-engine';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { query, transaction } from '../db.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.js';
import { atSeconds, localMidnight, secondsFrom } from './clock.js';
import { distanceToLine } from './geometry.js';
import { buildMatrix, combineMatrices, estimateSeconds, haversineM, loadBatches, locationKey, pointKey, storedTravel } from './matrix.js';
import { routeGeometry } from './tomtom.js';

export const ACTIVE_STATUSES = ['assigned', 'in_progress', 'awaiting_reconciliation'];
export const tripCode = id => `CH-${String(id).padStart(4, '0')}`;
export const planCode = id => `KH-${String(id).padStart(4, '0')}`;

const stale = message => new HttpError(409, 'STALE', message);

/** Lý do Dispatcher ghi cho các điểm chưa giao khi kết thúc chuyến do sự cố (không nằm trong danh sách Driver chọn). */
export const INCIDENT_REASON = 'Sự cố xe/tài xế';
/** Quyết định khi đối chiếu cho đơn chưa giao được: giao lại (xếp vào kế hoạch sau), chuyển hoàn, thất lạc. */
export const DECISIONS = ['requeue', 'return_to_sender', 'lost'];

// ---------------------------------------------------------------- đọc chi tiết chuyến

// Đơn cùng tọa độ dùng chung một điểm giao (một khóa ma trận), nên được giao liền nhau trong một lần dừng
const orderKey = s => locationKey(s.latitude, s.longitude);
const depotKey = t => pointKey('d', t.depot_id, t.depot_lat, t.depot_lon);
const POSITION_KEY = 'vi-tri-xe';

/** Thời gian phục vụ của chuyến: lúc phân chuyến lưu trong profile_snapshot, chuyến cũ dùng cấu hình hiện tại. */
const serviceOf = t => ({
  stopSeconds: t.profile_snapshot?.stopSeconds ?? config.stopSeconds,
  serviceSeconds: t.profile_snapshot?.serviceSeconds ?? config.serviceSecondsPerOrder,
});

/**
 * Thời gian chặng phụ thuộc giờ cho giờ dự kiến: dữ liệu đã lưu, chặng chưa có thì ước lượng theo đường chim bay
 * để luôn có giờ dự kiến. Chặng từ vị trí xe (POSITION_KEY) lấy chặng từ điểm xuất phát `from` nhân tỉ lệ quãng đường
 * còn lại theo đường chim bay (tối đa 2 lần).
 */
function etaTravel(base, coords, { from = null, position = null } = {}) {
  return (profile, a, b, t) => {
    if (a === b) return 0;
    if (a === POSITION_KEY) {
      const target = coords.get(b);
      const full = from && target ? haversineM(coords.get(from), target) : 0;
      const leg = from === b ? 0 : base(profile, from, b, t) ?? estimateSeconds(profile, coords.get(from), target);
      return full > 0 ? leg * Math.min(haversineM(position, target) / full, 2) : estimateSeconds(profile, position, target);
    }
    return base(profile, a, b, t) ?? (coords.has(a) && coords.has(b) ? estimateSeconds(profile, coords.get(a), coords.get(b)) : null);
  };
}

/**
 * Đoạn đường giữa hai điểm, cắt từ đường đi của một phiên bản tuyến (GeoJSON, kinh độ trước).
 * Không có đường đi, hoặc hai điểm không nằm trên đường đi, thì trả null: không vẽ đường thẳng thay cho đường thật.
 */
export function sliceLine(coords, a, b) {
  if (!coords?.length) return null;
  const nearest = (p, from) => {
    let best = { i: -1, d: Infinity };
    for (let i = from; i < coords.length; i++) {
      const d = haversineM({ lat: coords[i][1], lon: coords[i][0] }, p);
      if (d < best.d) best = { i, d };
    }
    return best;
  };
  const s = nearest(a, 0);
  const e = nearest(b, s.i);
  if (s.d > 300 || e.d > 300 || e.i <= s.i) return null;
  return [[a.lon, a.lat], ...coords.slice(s.i, e.i + 1), [b.lon, b.lat]];
}

/** Các chặng bị chậm hẳn theo lần đánh giá đổi tuyến gần nhất trong 30 phút, để vẽ đoạn ùn tắc. */
async function congestionOf(t, stops, versions) {
  const ev = (await query(
    `SELECT payload FROM trip_events WHERE trip_id = $1 AND event_type = 'reroute_evaluated'
        AND created_at > now() - interval '30 minutes' ORDER BY id DESC LIMIT 1`, [t.id])).rows[0];
  const legs = ev?.payload.increase?.slowLegs ?? [];
  if (!legs.length) return [];
  const geom = versions.find(v => v.id === ev.payload.routeVersionId)?.geometry?.coordinates;
  const at = new Map(stops.map(s => [s.id, { lat: s.latitude, lon: s.longitude }]));
  const depot = { lat: t.depot_lat, lon: t.depot_lon };
  return legs.filter(l => at.has(l.fromStopId)).map(l => ({
    fromStopId: l.fromStopId, toStopId: l.toStopId, ratio: Math.round((l.after / l.before) * 10) / 10,
    points: sliceLine(geom, at.get(l.fromStopId), l.toStopId ? at.get(l.toStopId) : depot),
  })).filter(l => l.points);
}

/**
 * Lần hệ thống tự đổi tuyến gần nhất, kèm kết quả đánh giá đã dùng: thứ tự cũ và mới, thời gian trước và sau,
 * các chặng chậm, và thiết bị Driver đã nhận tuyến mới hay chưa.
 */
async function lastReplanOf(t, versions) {
  const { rows } = await query(
    `SELECT r.created_at, r.payload, e.payload AS evaluation, v.id AS route_version_id
       FROM trip_events r
       JOIN trip_events e ON e.trip_id = r.trip_id AND e.event_type = 'reroute_evaluated' AND e.id::text = r.payload->>'evaluationEventId'
       LEFT JOIN route_versions v ON v.trip_id = r.trip_id AND v.version_no = (r.payload->>'toVersion')::int
      WHERE r.trip_id = $1 AND r.event_type = 'route_replanned'
      ORDER BY r.id DESC LIMIT 1`, [t.id]);
  const r = rows[0];
  if (!r) return null;
  const e = r.evaluation;
  const routeVersionId = r.route_version_id;
  // Mã phiên bản tuyến tăng dần, nên thiết bị đã nhận một phiên bản sau (ví dụ sau khi giao sau) cũng là đã nhận phiên bản này
  const received = routeVersionId != null && t.driver_ack_route_version != null && t.driver_ack_route_version >= routeVersionId;
  // Tuyến cũ để so sánh: đường đi của phiên bản trước, cắt từ vị trí xe lúc đổi tuyến về kho
  const from = versions.find(v => v.version_no === r.payload.fromVersion)?.geometry?.coordinates;
  const oldLine = e.position ? sliceLine(from, e.position, { lat: t.depot_lat, lon: t.depot_lon }) : null;
  const receivedAt = received ? (await query(
    `SELECT created_at FROM trip_events WHERE trip_id = $1 AND event_type = 'route_acknowledged'
        AND payload->>'routeVersionId' = $2 ORDER BY id LIMIT 1`, [t.id, String(routeVersionId)])).rows[0]?.created_at ?? null : null;
  return {
    at: r.created_at,
    evaluationEventId: Number(r.payload.evaluationEventId),
    fromVersion: r.payload.fromVersion,
    toVersion: r.payload.toVersion,
    routeVersionId,
    currentSeconds: e.currentSeconds,
    proposedSeconds: e.proposedSeconds,
    savingSeconds: e.savingSeconds,
    savingRatio: e.savingRatio,
    increase: e.increase,
    slowLegs: e.increase?.slowLegs ?? [],
    position: e.position,
    nextStopId: e.nextStopId,
    currentStopIds: e.currentStopIds,
    proposedStopIds: e.proposedStopIds,
    oldGeometry: oldLine && { type: 'LineString', coordinates: oldLine },
    received,
    receivedAt,
  };
}

/**
 * Chi tiết một chuyến cho màn hình Dispatcher và Driver.
 * Giờ dự kiến tính từ ma trận đã lưu, chỉ để hiển thị, không gọi TomTom.
 */
export async function loadTrip(id, { withEvents = false } = {}) {
  const { rows } = await query(
    `SELECT t.*, d.full_name AS driver_name, d.phone AS driver_phone, d.user_id AS driver_user_id,
            v.plate, v.vehicle_type, v.routing_profile, v.capacity_kg, v.capacity_parcels,
            dp.name AS depot_name, dp.address AS depot_address, dp.latitude AS depot_lat, dp.longitude AS depot_lon
       FROM trips t
       JOIN drivers d ON d.id = t.driver_id
       JOIN vehicles v ON v.id = t.vehicle_id
       JOIN depots dp ON dp.id = t.depot_id
      WHERE t.id = $1`, [id]);
  const t = rows[0];
  if (!t) return null;

  // Điểm đã bỏ khỏi chuyến (thiếu hàng lúc xuất phát) không còn thuộc chuyến
  const stopsRes = await query(
    `SELECT s.id, s.order_id, s.status, rs.sequence_no,
            o.code, o.recipient_name, o.phone, o.address, o.latitude, o.longitude, o.weight_kg, o.note, o.status AS order_status,
            o.parcels, o.not_before_at,
            a.result, a.reason, a.note AS attempt_note, a.occurred_at, a.received_at, a.distance_m AS attempt_distance_m,
            a.position_observed_at AS attempt_position_at, ru.role AS recorded_role,
            (SELECT count(*)::int FROM trip_stops f WHERE f.order_id = s.order_id AND f.status = 'failed') AS failed_attempts
       FROM trip_stops s
       JOIN orders o ON o.id = s.order_id
       LEFT JOIN route_stops rs ON rs.stop_id = s.id AND rs.route_version_id = $2
       LEFT JOIN delivery_attempts a ON a.stop_id = s.id
       LEFT JOIN users ru ON ru.id = a.recorded_by
      WHERE s.trip_id = $1 AND s.status <> 'removed'
      ORDER BY rs.sequence_no NULLS LAST, s.id`, [id, t.current_route_version]);
  const stops = stopsRes.rows;

  const versions = (await query(
    `SELECT id, version_no, created_at, objective_seconds, distance_m, reason, matrix_batch_id, geometry
       FROM route_versions WHERE trip_id = $1 ORDER BY version_no`, [id])).rows;
  const current = versions.find(v => v.id === t.current_route_version) || null;

  const pos = (await query(
    `SELECT id, latitude, longitude, observed_at, received_at, accuracy_m, source
       FROM vehicle_positions WHERE trip_id = $1 ORDER BY observed_at DESC LIMIT 1`, [id])).rows[0] || null;

  // Vệt di chuyển của xe, rút gọn còn tối đa khoảng 400 điểm
  const trailRows = ['in_progress', 'awaiting_reconciliation'].includes(t.status) ? (await query(
    'SELECT latitude, longitude FROM vehicle_positions WHERE trip_id = $1 ORDER BY observed_at', [id])).rows : [];
  const every = Math.ceil(trailRows.length / 400) || 1;
  const trail = trailRows.filter((_, i) => i % every === 0 || i === trailRows.length - 1).map(r => [r.longitude, r.latitude]);

  const reports = (await query(
    `SELECT id, event_type, payload, created_at FROM trip_events
      WHERE trip_id = $1 AND event_type IN ('trip_returned', 'trip_aborted', 'loading_mismatch', 'orders_removed', 'stop_deferred',
                                            'trip_started', 'trip_closed', 'customer_rescheduled', 'customer_deferred', 'route_acknowledged')
      ORDER BY id`, [id])).rows;
  const last = (...types) => [...reports].reverse().find(r => types.includes(r.event_type)) || null;
  // Điểm tài xế bấm "Giao sau": ghim ở cuối tuyến trong mọi lần sắp lại
  const deferred = new Set(reports.filter(r => r.event_type === 'stop_deferred').map(r => r.payload.stopId));
  // Báo thiếu hàng chỉ còn hiệu lực khi chưa bỏ đơn thiếu khỏi chuyến sau lần báo đó
  const mismatch = last('loading_mismatch');
  const removed = last('orders_removed');
  const returned = last('trip_returned', 'trip_aborted');

  // Giờ dự kiến cùng mô hình với lập kế hoạch (thời gian phụ thuộc giờ, dừng xe, giao từng đơn, chờ giờ khách hẹn) và không
  // bao giờ ở quá khứ: chuyến đang giao tính từ lúc muộn nhất trong (bây giờ, lúc xuất phát, lần ghi kết quả gần nhất), từ
  // vị trí xe nếu còn mới, nếu không thì từ điểm vừa xử lý gần nhất (hoặc kho); chuyến chưa xuất phát tính từ giờ bắt đầu ca
  const now = Date.now();
  const running = t.status === 'in_progress';
  const shiftStartAt = t.profile_snapshot?.shiftStartAt ? new Date(t.profile_snapshot.shiftStartAt) : null;
  const done = stops.filter(s => s.status !== 'pending');
  const lastDone = [...done].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))[0];
  const startMs = running
    ? Math.max(now, new Date(t.started_at).getTime(), lastDone ? new Date(lastDone.occurred_at).getTime() : 0)
    : Math.max(now, shiftStartAt?.getTime() ?? 0);
  const base = localMidnight(new Date(startMs));
  const prev = lastDone && running ? orderKey(lastDone) : depotKey(t);
  const coords = new Map([[depotKey(t), { lat: t.depot_lat, lon: t.depot_lon }], ...stops.map(s => [orderKey(s), { lat: s.latitude, lon: s.longitude }])]);
  const fresh = running && pos && now - new Date(pos.observed_at).getTime() <= config.monitor.stalePositionSeconds * 1000;
  const stored = await storedTravel([...coords.keys()], [t.routing_profile]);
  const pending = stops.filter(s => s.status === 'pending');
  const eta = new Map();
  let etaReturn = null;
  if (['assigned', 'in_progress'].includes(t.status)) {
    const schedule = stopSchedule({
      depot: depotKey(t),
      travelAt: etaTravel(stored, coords, { from: prev, position: fresh ? { lat: pos.latitude, lon: pos.longitude } : null }),
      startSeconds: secondsFrom(base, startMs), ...serviceOf(t), profile: t.routing_profile, start: fresh ? POSITION_KEY : prev,
      stops: pending.map(s => ({ point: orderKey(s), notBeforeSeconds: s.not_before_at ? secondsFrom(base, s.not_before_at) : null })),
    });
    if (schedule) {
      pending.forEach((s, k) => eta.set(s.id, atSeconds(base, schedule.arrivals[k]).getTime()));
      etaReturn = atSeconds(base, schedule.end);
    }
  }
  // Giờ về kho theo kế hoạch (lúc xuất phát cộng thời gian của tuyến ban đầu) và giờ hết ca
  const initial = versions.find(v => v.version_no === 1);
  const plannedReturnAt = t.started_at && initial ? new Date(new Date(t.started_at).getTime() + initial.objective_seconds * 1000) : null;
  const maxMinutes = Number(t.profile_snapshot?.maxRouteMinutes) || 0;
  const shiftEndAt = t.profile_snapshot?.shiftEndAt ? new Date(t.profile_snapshot.shiftEndAt)
    : t.started_at && maxMinutes > 0 ? new Date(new Date(t.started_at).getTime() + maxMinutes * 60_000) : null;

  const next = stops.find(s => s.status === 'pending') || null;
  const trip = {
    id: t.id,
    code: tripCode(t.id),
    status: t.status,
    stateVersion: t.state_version,
    planningRunId: t.planning_run_id,
    createdAt: t.created_at,
    startedAt: t.started_at,
    returnedAt: t.returned_at,
    closedAt: t.closed_at,
    driver: { id: t.driver_id, name: t.driver_name, phone: t.driver_phone, userId: t.driver_user_id },
    vehicle: { id: t.vehicle_id, plate: t.plate, type: t.vehicle_type, profile: t.routing_profile, capacityKg: t.capacity_kg, capacityParcels: t.capacity_parcels },
    depot: { id: t.depot_id, name: t.depot_name, address: t.depot_address, lat: t.depot_lat, lon: t.depot_lon },
    routeVersion: current && {
      id: current.id, versionNo: current.version_no, createdAt: current.created_at, reason: current.reason,
      objectiveSeconds: current.objective_seconds, distanceM: current.distance_m, geometry: current.geometry,
    },
    routeVersions: versions.map(v => ({ id: v.id, versionNo: v.version_no, createdAt: v.created_at, reason: v.reason, objectiveSeconds: v.objective_seconds })),
    ackRouteVersionId: t.driver_ack_route_version,
    needsAck: t.status === 'in_progress' && t.driver_ack_route_version !== t.current_route_version,
    stops: stops.map((s, i) => ({
      id: s.id,
      seq: s.sequence_no ?? i + 1,
      status: s.status,
      eta: eta.get(s.id) ? new Date(eta.get(s.id)) : null,
      deferred: deferred.has(s.id),
      order: {
        id: s.order_id, code: s.code, recipientName: s.recipient_name, phone: s.phone, address: s.address,
        lat: s.latitude, lon: s.longitude, weightKg: s.weight_kg, parcels: s.parcels, note: s.note, status: s.order_status,
        failedAttempts: s.failed_attempts,
        // Khách hẹn giao sau giờ này (trang theo dõi đơn); tài xế thấy thẻ "Khách hẹn HH:MM"
        notBeforeAt: s.not_before_at,
      },
      attempt: s.result ? {
        result: s.result, reason: s.reason, note: s.attempt_note, occurredAt: s.occurred_at, receivedAt: s.received_at,
        recordedByRole: s.recorded_role, distanceM: s.attempt_distance_m, positionAt: s.attempt_position_at,
        farFromStop: s.attempt_distance_m != null && s.attempt_distance_m > config.podMaxDistanceM,
      } : null,
    })),
    nextStopId: t.status === 'in_progress' ? next?.id ?? null : null,
    progress: {
      total: stops.length,
      done: done.length,
      delivered: stops.filter(s => s.status === 'delivered').length,
      failed: stops.filter(s => s.status === 'failed').length,
    },
    loadKg: Math.round(stops.reduce((sum, s) => sum + s.weight_kg, 0) * 100) / 100,
    loadParcels: stops.reduce((sum, s) => sum + s.parcels, 0),
    // Kiện khách hẹn ngày khác (hoặc không kịp giờ hẹn) đã bỏ khỏi chuyến khi đang giao: tài xế mang về kho
    removedStops: reports.filter(r => r.event_type === 'customer_rescheduled' || (r.event_type === 'customer_deferred' && r.payload.outcome === 'requeued'))
      .map(r => ({ stopId: r.payload.stopId, orderId: r.payload.orderId, orderCode: r.payload.orderCode, reason: r.payload.reasonText, at: r.created_at })),
    position: pos && {
      id: pos.id, lat: pos.latitude, lon: pos.longitude, observedAt: pos.observed_at,
      receivedAt: pos.received_at, accuracyM: pos.accuracy_m, source: pos.source,
    },
    trail,
    congestion: t.status === 'in_progress' ? await congestionOf(t, stops, versions) : [],
    etaReturn,
    plannedReturnAt,
    shiftStartAt,
    shiftEndAt,
    // Lúc thiết bị tài xế nhận phiên bản tuyến hiện hành (để ứng dụng tài xế báo ngắn "Tuyến đã cập nhật")
    routeReceivedAt: reports.find(r => r.event_type === 'route_acknowledged' && r.payload.routeVersionId === t.current_route_version)?.created_at ?? null,
    lateSeconds: running && etaReturn && plannedReturnAt ? Math.round((etaReturn - plannedReturnAt) / 1000) : null,
    staleAfterSeconds: config.monitor.stalePositionSeconds,
    service: serviceOf(t),
    maxDeliveryAttempts: config.maxDeliveryAttempts,
    returnReport: returned && { ...returned.payload, aborted: returned.event_type === 'trip_aborted', reportedAt: returned.created_at },
    abortReport: last('trip_aborted') && { ...last('trip_aborted').payload, reportedAt: last('trip_aborted').created_at },
    loadingMismatch: t.status === 'assigned' && mismatch && (!removed || removed.id < mismatch.id)
      ? { ...mismatch.payload, reportedAt: mismatch.created_at } : null,
    closeReport: last('trip_closed')?.payload ?? null,
    lastReplan: t.status === 'in_progress' ? await lastReplanOf(t, versions) : null,
    serverTime: new Date(),
  };
  if (withEvents) {
    trip.events = (await query(
      `SELECT e.id, e.event_type, e.payload, e.created_at, u.full_name AS actor_name, u.role AS actor_role
         FROM trip_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.trip_id = $1 ORDER BY e.id`, [id])).rows.map(e => ({
      id: e.id, type: e.event_type, payload: e.payload, createdAt: e.created_at, actorName: e.actor_name, actorRole: e.actor_role,
    }));
  }
  return trip;
}

// ---------------------------------------------------------------- tiện ích transaction

export async function lockTrip(c, id) {
  const { rows } = await c.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Không tìm thấy chuyến');
  return rows[0];
}

/** Driver chỉ thao tác trên chuyến được giao cho mình, kể cả khi tự sửa mã chuyến trong yêu cầu (NFR02). */
function ensureOwner(t, user) {
  if (user.role !== 'driver' || t.driver_id !== user.driver_id) throw forbidden('Chuyến không được giao cho bạn');
}

/** Yêu cầu gửi lại cùng mã và cùng nội dung thì trả lại kết quả đã lưu; khác nội dung thì báo xung đột (NFR03). */
async function findReplay(c, tripId, type, clientEventId, fp) {
  if (!clientEventId) return false;
  const { rows } = await c.query(
    'SELECT request_fingerprint FROM trip_events WHERE trip_id = $1 AND event_type = $2 AND client_event_id = $3',
    [tripId, type, clientEventId]);
  if (!rows[0]) return false;
  if (rows[0].request_fingerprint !== fp) throw conflict('Mã thao tác đã được dùng cho một nội dung khác');
  return true;
}

export function addEvent(c, { tripId, actorId, type, payload, clientEventId = null, fp = null }) {
  return c.query(
    `INSERT INTO trip_events (trip_id, actor_id, event_type, payload, client_event_id, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tripId, actorId, type, payload ?? null, clientEventId, fp]);
}

const tripOrderIds = async (c, tripId) =>
  (await c.query(`SELECT order_id FROM trip_stops WHERE trip_id = $1 AND status <> 'removed' ORDER BY order_id`, [tripId])).rows.map(r => r.order_id);

/**
 * Thời lượng đi qua các điểm theo thứ tự, xuất phát bây giờ (giây, gồm thời gian phục vụ), từ dữ liệu phụ thuộc giờ đã lưu;
 * chặng chưa có thì ước lượng theo đường chim bay. points: [điểm xuất phát, ...điểm giao, kho].
 */
async function sequenceSeconds(points, profile, t) {
  const coords = new Map(points.map(p => [p.key, p]));
  const travelAt = etaTravel(await storedTravel([...coords.keys()], [profile]), coords);
  const base = localMidnight();
  const schedule = stopSchedule({
    depot: points.at(-1).key, travelAt, startSeconds: secondsFrom(base, new Date()), ...serviceOf(t), profile,
    start: points[0].key, stops: points.slice(1, -1).map(p => ({ point: p.key })),
  });
  return Math.round(schedule?.seconds ?? 0);
}

/**
 * Tạo phiên bản tuyến mới với thứ tự sequence (mã điểm dừng), như khi hệ thống đổi tuyến (UC07).
 * ack: thiết bị Driver đã có thứ tự mới (Driver vừa yêu cầu), nên ghi luôn là đã nhận.
 */
export async function addRouteVersion(c, t, { reason, sequence, objectiveSeconds, ack = false }) {
  const cur = (await c.query('SELECT version_no, matrix_batch_id FROM route_versions WHERE id = $1', [t.current_route_version])).rows[0];
  const rvId = (await c.query(
    `INSERT INTO route_versions (trip_id, matrix_batch_id, version_no, objective_seconds, reason)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`, [t.id, cur.matrix_batch_id, cur.version_no + 1, Math.round(objectiveSeconds), reason])).rows[0].id;
  for (let i = 0; i < sequence.length; i++) {
    await c.query('INSERT INTO route_stops (route_version_id, stop_id, sequence_no) VALUES ($1, $2, $3)', [rvId, sequence[i], i + 1]);
  }
  await c.query(
    `UPDATE trips SET current_route_version = $2, state_version = state_version + 1,
                      driver_ack_route_version = CASE WHEN $3 THEN $2 ELSE driver_ack_route_version END WHERE id = $1`,
    [t.id, rvId, ack]);
  return { routeVersionId: rvId, fromVersion: cur.version_no, toVersion: cur.version_no + 1 };
}

/** Thứ tự các điểm dừng của phiên bản tuyến hiện hành, kèm tọa độ. */
export const currentOrder = async (c, t) => (await c.query(
  `SELECT s.id, s.order_id, s.status, o.code, o.latitude AS lat, o.longitude AS lon
     FROM route_stops rs JOIN trip_stops s ON s.id = rs.stop_id JOIN orders o ON o.id = s.order_id
    WHERE rs.route_version_id = $1 AND s.status <> 'removed' ORDER BY rs.sequence_no`, [t.current_route_version])).rows;

const depotOf = async (c, t) => {
  const d = (await c.query('SELECT id, latitude AS lat, longitude AS lon FROM depots WHERE id = $1', [t.depot_id])).rows[0];
  return { ...d, key: pointKey('d', d.id, d.lat, d.lon) };
};
const stopPoint = s => ({ lat: s.lat, lon: s.lon, key: locationKey(s.lat, s.lon) });
const profileOf = async (c, t) => (await c.query('SELECT routing_profile FROM vehicles WHERE id = $1', [t.vehicle_id])).rows[0].routing_profile;

/**
 * Lấy đường đi sau khi transaction đã kết thúc, vì không giữ transaction mở trong lúc gọi TomTom (mục 3.3.2).
 * routeGeometry tự thử lại khi TomTom tạm từ chối; vẫn thiếu thì backfillGeometry (geometry.js) lấy bổ sung theo chu kỳ.
 */
export function fillGeometryLater(routeVersionId, points, profile) {
  routeGeometry(points, profile)
    .then(g => g && query('UPDATE route_versions SET geometry = $2 WHERE id = $1', [routeVersionId, g]))
    .catch(err => console.error('Không lấy được đường đi', err.message));
}

// ---------------------------------------------------------------- UC05 duyệt bản nháp và giao chuyến

export async function commitPlan(runId, user, { clientEventId, fp }) {
  return transaction(async c => {
    const run = (await c.query('SELECT * FROM planning_runs WHERE id = $1 FOR UPDATE', [runId])).rows[0];
    if (!run) throw notFound('Không tìm thấy bản nháp');
    const existing = (await c.query(
      `SELECT DISTINCT t.id, e.client_event_id, e.request_fingerprint FROM trips t
         JOIN trip_events e ON e.trip_id = t.id AND e.event_type = 'trip_assigned'
        WHERE t.planning_run_id = $1 ORDER BY t.id`, [runId])).rows;
    if (run.status === 'committed') {
      if (existing.length && existing[0].client_event_id === clientEventId && existing[0].request_fingerprint === fp) {
        return { tripIds: existing.map(r => r.id), replayed: true };
      }
      throw conflict('Bản nháp này đã được phân chuyến');
    }
    if (run.status !== 'draft') throw conflict('Bản nháp không còn hiệu lực, cần tính lại phương án');

    const snap = run.input_snapshot;
    const result = run.result;
    const orderIds = result.routes.flatMap(r => r.orderIds).sort((a, b) => a - b);
    const vehicleIds = result.routes.map(r => r.vehicleId).sort((a, b) => a - b);
    const driverIds = result.routes.map(r => r.driverId).sort((a, b) => a - b);
    const problems = [];

    // Khóa đơn, xe rồi Driver theo thứ tự mã tăng dần để hai giao dịch đồng thời không chờ vòng lẫn nhau
    const orders = (await c.query('SELECT id, code, status, version FROM orders WHERE id = ANY($1) ORDER BY id FOR UPDATE', [orderIds])).rows;
    for (const o of orders) {
      const snapOrder = snap.orders.find(x => x.id === o.id);
      if (o.status !== 'pending') problems.push(`${o.code} không còn ở trạng thái chờ xếp`);
      else if (snapOrder && snapOrder.version !== o.version) problems.push(`${o.code} đã bị sửa sau khi lập kế hoạch`);
    }
    const vehicles = (await c.query('SELECT * FROM vehicles WHERE id = ANY($1) ORDER BY id FOR UPDATE', [vehicleIds])).rows;
    for (const v of vehicles) {
      const snapVehicle = snap.vehicles.find(x => x.id === v.id);
      if (v.status !== 'active') problems.push(`Xe ${v.plate} đang bảo trì`);
      // Loại xe, tải trọng hay cấu hình định tuyến đổi thì tuyến trong bản nháp có thể không còn hợp lệ
      else if (snapVehicle && (snapVehicle.type !== v.vehicle_type || Number(snapVehicle.capacityKg) !== Number(v.capacity_kg)
        || snapVehicle.profile !== v.routing_profile || (snapVehicle.capacityParcels ?? null) !== (v.capacity_parcels ?? null))) problems.push(`Xe ${v.plate} đã bị sửa cấu hình sau khi lập kế hoạch`);
    }
    const drivers = (await c.query(
      `SELECT d.*, u.status AS account_status FROM drivers d JOIN users u ON u.id = d.user_id
        WHERE d.id = ANY($1) ORDER BY d.id FOR UPDATE OF d`, [driverIds])).rows;
    for (const r of result.routes) {
      const d = drivers.find(x => x.id === r.driverId);
      if (!d || d.status !== 'active' || d.account_status !== 'active') problems.push(`Tài xế ${d?.full_name ?? r.driverId} không còn sẵn sàng`);
      else if (d.default_vehicle_id !== r.vehicleId) problems.push(`Tài xế ${d.full_name} đã đổi xe thường dùng`);
    }
    const busy = (await c.query(
      `SELECT id, driver_id, vehicle_id FROM trips WHERE status = ANY($1) AND (driver_id = ANY($2) OR vehicle_id = ANY($3))`,
      [ACTIVE_STATUSES, driverIds, vehicleIds])).rows;
    if (busy.length) problems.push('Có tài xế hoặc xe đang ở chuyến khác chưa kết thúc');
    if (problems.length) throw conflict('Dữ liệu đã thay đổi so với bản nháp, chưa phân chuyến', problems);

    const profileBatch = async profile => (await c.query(
      `SELECT b.id FROM planning_run_matrices m JOIN matrix_batches b ON b.id = m.matrix_batch_id
        WHERE m.planning_run_id = $1 AND b.profile_snapshot->>'profile' = $2 ORDER BY b.started_at DESC LIMIT 1`,
      [runId, profile])).rows[0]?.id ?? null;

    const tripIds = [];
    for (const r of result.routes) {
      const v = vehicles.find(x => x.id === r.vehicleId);
      const d = drivers.find(x => x.id === r.driverId);
      // Ca làm việc và thời gian phục vụ lúc lập kế hoạch: dùng cho giờ dự kiến, đổi tuyến và khách hẹn giờ
      const profileSnapshot = {
        plate: v.plate, vehicleType: v.vehicle_type, routingProfile: v.routing_profile, capacityKg: v.capacity_kg,
        capacityParcels: v.capacity_parcels, driverName: d.full_name, maxRouteMinutes: snap.params.maxRouteMinutes,
        shiftStartAt: snap.params.shiftStartAt ?? null, shiftEndAt: snap.params.shiftEndAt ?? null,
        stopSeconds: snap.params.stopSeconds ?? config.stopSeconds, serviceSeconds: snap.params.serviceSeconds ?? config.serviceSecondsPerOrder,
      };
      const tripId = (await c.query(
        `INSERT INTO trips (depot_id, driver_id, vehicle_id, planning_run_id, profile_snapshot)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [snap.depot.id, d.id, v.id, runId, profileSnapshot])).rows[0].id;
      const routeVersionId = (await c.query(
        `INSERT INTO route_versions (trip_id, matrix_batch_id, version_no, objective_seconds, distance_m, reason, geometry)
         VALUES ($1, $2, 1, $3, $4, 'initial', $5) RETURNING id`,
        [tripId, await profileBatch(v.routing_profile), Math.round(r.seconds), r.distanceM, r.geometry])).rows[0].id;
      let seq = 0;
      for (const orderId of r.orderIds) {
        const stopId = (await c.query('INSERT INTO trip_stops (trip_id, order_id) VALUES ($1, $2) RETURNING id', [tripId, orderId])).rows[0].id;
        await c.query('INSERT INTO active_assignments (order_id, trip_id, stop_id) VALUES ($1, $2, $3)', [orderId, tripId, stopId]);
        await c.query('INSERT INTO route_stops (route_version_id, stop_id, sequence_no) VALUES ($1, $2, $3)', [routeVersionId, stopId, ++seq]);
      }
      await c.query('UPDATE trips SET current_route_version = $2 WHERE id = $1', [tripId, routeVersionId]);
      await addEvent(c, {
        tripId, actorId: user.id, type: 'trip_assigned', clientEventId, fp,
        payload: { planningRunId: runId, routeVersionNo: 1, orderIds: r.orderIds, objectiveSeconds: r.seconds },
      });
      tripIds.push(tripId);
    }
    await c.query(`UPDATE orders SET status = 'assigned', version = version + 1 WHERE id = ANY($1)`, [orderIds]);
    await c.query(`UPDATE planning_runs SET status = 'committed' WHERE id = $1`, [runId]);
    return { tripIds, replayed: false };
  });
}

// ---------------------------------------------------------------- UC11 bắt đầu chuyến

export async function startTrip(tripId, user, { checkedOrderIds, clientEventId, fp }) {
  const outcome = await transaction(async c => {
    const t = await lockTrip(c, tripId);
    ensureOwner(t, user);
    if (await findReplay(c, tripId, 'trip_started', clientEventId, fp)) return { ok: true };
    if (t.status === 'revoked') throw conflict('Chuyến đã bị thu hồi');
    if (t.status !== 'assigned') throw conflict('Chuyến không ở trạng thái chờ xuất phát');
    const orderIds = await tripOrderIds(c, tripId);
    const checked = new Set(checkedOrderIds);
    const missing = orderIds.filter(id => !checked.has(id));
    const extra = checkedOrderIds.filter(id => !orderIds.includes(id));
    if (missing.length || extra.length) {
      // Hàng thực nhận không khớp: báo cho Dispatcher và không cho xuất phát
      if (!(await findReplay(c, tripId, 'loading_mismatch', clientEventId, fp))) {
        await addEvent(c, { tripId, actorId: user.id, type: 'loading_mismatch', clientEventId, fp, payload: { missingOrderIds: missing, extraOrderIds: extra } });
      }
      return { ok: false, missing };
    }
    await c.query(
      `UPDATE trips SET status = 'in_progress', started_at = now(), driver_ack_route_version = current_route_version,
                        state_version = state_version + 1 WHERE id = $1`, [tripId]);
    await c.query(`UPDATE orders SET status = 'in_delivery', version = version + 1 WHERE id = ANY($1)`, [orderIds]);
    await addEvent(c, { tripId, actorId: user.id, type: 'trip_started', clientEventId, fp, payload: { checkedOrderIds: orderIds } });
    return { ok: true };
  });
  if (!outcome.ok) throw conflict('Hàng thực nhận không khớp danh sách, đã báo cho điều phối viên', { missingOrderIds: outcome.missing });
}

// ---------------------------------------------------------------- UC13 ghi kết quả giao

export async function recordAttempt(tripId, stopId, user, { result, reason, note, occurredAt, clientEventId, fp }) {
  return transaction(async c => {
    // Khóa chuyến và kiểm tra quyền trước khi tìm yêu cầu gửi lặp: hai lần gửi cùng mã đến đồng thời
    // thì lần sau chờ lần trước xong rồi nhận lại kết quả cũ, không bị báo "đã có kết quả cuối"
    const t = await lockTrip(c, tripId);
    ensureOwner(t, user);
    const prior = (await c.query('SELECT stop_id, request_fingerprint FROM delivery_attempts WHERE client_event_id = $1', [clientEventId])).rows[0];
    if (prior) {
      if (prior.stop_id === stopId && prior.request_fingerprint === fp) return { replayed: true };
      throw conflict('Mã thao tác đã được dùng cho một nội dung khác');
    }
    if (t.status !== 'in_progress') throw conflict('Chuyến không ở trạng thái đang giao');
    // Cho lệch đồng hồ thiết bị tối đa 1 phút
    if (new Date(occurredAt).getTime() < new Date(t.started_at).getTime() - 60_000) throw badRequest('Thời điểm ghi kết quả trước lúc bắt đầu chuyến');
    const stop = (await c.query(
      `SELECT s.*, o.latitude, o.longitude FROM trip_stops s JOIN orders o ON o.id = s.order_id
        WHERE s.id = $1 AND s.trip_id = $2 FOR UPDATE OF s`, [stopId, tripId])).rows[0];
    if (!stop || stop.status === 'removed') throw notFound('Điểm dừng không thuộc chuyến này');
    if (stop.status !== 'pending') throw conflict('Điểm dừng đã có kết quả cuối');
    // Tài xế ghi kết quả cho điểm không phải điểm kế tiếp (khác điểm giao): vẫn nhận, rồi hệ thống sắp lại phần còn lại
    const next = (await currentOrder(c, t)).find(s => s.status === 'pending');
    const outOfOrder = Boolean(next && next.id !== stopId && locationKey(next.lat, next.lon) !== locationKey(stop.latitude, stop.longitude));
    // Bằng chứng giao hàng tối thiểu: vị trí xe mới nhất lúc ghi và khoảng cách tới điểm giao
    const pos = (await c.query(
      'SELECT latitude, longitude, observed_at FROM vehicle_positions WHERE trip_id = $1 ORDER BY observed_at DESC LIMIT 1', [tripId])).rows[0];
    const distance = pos ? Math.round(haversineM({ lat: pos.latitude, lon: pos.longitude }, { lat: stop.latitude, lon: stop.longitude })) : null;
    await c.query(
      `INSERT INTO delivery_attempts (stop_id, client_event_id, request_fingerprint, result, reason, note, occurred_at, recorded_by,
                                      position_lat, position_lon, position_observed_at, distance_m)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [stopId, clientEventId, fp, result, reason, note, occurredAt, user.id, pos?.latitude ?? null, pos?.longitude ?? null, pos?.observed_at ?? null, distance]);
    await c.query('UPDATE trip_stops SET status = $2 WHERE id = $1', [stopId, result]);
    await c.query('UPDATE orders SET status = $2, version = version + 1 WHERE id = $1',
      [stop.order_id, result === 'delivered' ? 'delivered' : 'needs_action']);
    await c.query('UPDATE trips SET state_version = state_version + 1 WHERE id = $1', [tripId]);
    await addEvent(c, {
      tripId, actorId: user.id, type: 'attempt_recorded', clientEventId, fp,
      payload: { stopId, orderId: stop.order_id, result, reason, distanceM: distance, outOfOrder, expectedStopId: outOfOrder ? next.id : undefined },
    });
    return { replayed: false, outOfOrder, from: { lat: stop.latitude, lon: stop.longitude } };
  });
}

// ---------------------------------------------------------------- giao sau

/**
 * Driver báo khách vắng, quay lại sau: điểm đó xuống cuối các điểm còn lại, thành một phiên bản tuyến mới như khi hệ thống
 * đổi tuyến (người thực hiện để trống, Driver yêu cầu ghi trong payload). Dispatcher không phải duyệt.
 * Điểm kế tiếp luôn là điểm chưa giao đầu tiên theo thứ tự hiện hành, nên sau khi giao sau điểm kế tiếp là điểm đứng sau nó.
 */
export async function deferStop(tripId, stopId, user, { clientEventId, fp }) {
  const out = await transaction(async c => {
    const t = await lockTrip(c, tripId);
    ensureOwner(t, user);
    if (await findReplay(c, tripId, 'stop_deferred', clientEventId, fp)) return null;
    if (t.status !== 'in_progress') throw conflict('Chuyến không ở trạng thái đang giao');
    const order = await currentOrder(c, t);
    const target = order.find(s => s.id === stopId);
    if (!target) throw notFound('Điểm dừng không thuộc chuyến này');
    if (target.status !== 'pending') throw conflict('Điểm dừng đã có kết quả cuối');
    const pending = order.filter(s => s.status === 'pending');
    if (pending.length < 2) throw conflict('Chỉ còn một điểm chưa giao');
    if (pending.at(-1).id === stopId) throw conflict('Điểm này đã ở cuối tuyến');
    const rest = [...pending.filter(s => s.id !== stopId), target];
    const depot = await depotOf(c, t);
    const profile = await profileOf(c, t);
    // Điểm xuất phát của phần còn lại: điểm vừa xử lý gần nhất hoặc kho; đường đi vẽ từ vị trí xe nếu vị trí còn mới
    const lastDone = (await c.query(
      `SELECT s.order_id, o.latitude AS lat, o.longitude AS lon FROM delivery_attempts a
         JOIN trip_stops s ON s.id = a.stop_id JOIN orders o ON o.id = s.order_id
        WHERE s.trip_id = $1 ORDER BY a.occurred_at DESC LIMIT 1`, [tripId])).rows[0];
    const from = lastDone ? stopPoint(lastDone) : depot;
    const pos = (await c.query(
      `SELECT latitude AS lat, longitude AS lon FROM vehicle_positions
        WHERE trip_id = $1 AND observed_at > now() - make_interval(secs => $2) ORDER BY observed_at DESC LIMIT 1`,
      [tripId, config.monitor.stalePositionSeconds])).rows[0];
    const start = pos ?? { lat: from.lat, lon: from.lon };
    const restPoints = rest.map(stopPoint);
    const v = await addRouteVersion(c, t, {
      reason: 'deferred', ack: true,
      sequence: [...order.filter(s => s.status !== 'pending').map(s => s.id), ...rest.map(s => s.id)],
      objectiveSeconds: await sequenceSeconds([from, ...restPoints, depot], profile, t),
    });
    await addEvent(c, {
      tripId, actorId: null, type: 'stop_deferred', clientEventId, fp,
      payload: { stopId, orderId: target.order_id, requestedBy: user.id, ...v, start, stopIds: rest.map(s => s.id) },
    });
    return { ...v, points: [start, ...restPoints, depot], profile };
  });
  if (out) fillGeometryLater(out.routeVersionId, out.points, out.profile);
}

// ---------------------------------------------------------------- UC12 vị trí xe

export async function recordPosition(tripId, user, { lat, lon, observedAt, accuracyM, source, clientEventId }) {
  const t = (await query('SELECT id, driver_id, status FROM trips WHERE id = $1', [tripId])).rows[0];
  if (!t) throw notFound('Không tìm thấy chuyến');
  ensureOwner(t, user);
  if (t.status !== 'in_progress') throw conflict('Chỉ gửi vị trí khi chuyến đang giao');
  // Vị trí sai số quá lớn (thường là định vị theo mạng di động) bỏ luôn, không làm lệch vị trí xe và giờ dự kiến
  if (accuracyM != null && accuracyM > config.positionMaxAccuracyM) return { dropped: true };
  // Vị trí cũ đến muộn vẫn được lưu nhưng không thay vị trí mới hơn, vì vị trí hiện tại luôn lấy theo observed_at lớn nhất
  await query(
    `INSERT INTO vehicle_positions (trip_id, latitude, longitude, observed_at, accuracy_m, source, client_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (client_event_id) DO NOTHING`,
    [tripId, lat, lon, observedAt, accuracyM, source, clientEventId]);
  // Xét lệch tuyến sau khi đã trả lời thiết bị: không làm chậm việc gửi vị trí
  setImmediate(() => checkOffRoute(tripId).catch(err => console.error('Kiểm tra lệch tuyến lỗi', err.message)));
  return { dropped: false };
}

// ---------------------------------------------------------------- UC10.1 thiết bị Driver nhận tuyến mới

/**
 * Ứng dụng Driver tự gọi khi tải chuyến và thấy phiên bản tuyến mới (Driver không bấm gì). Ghi nhận thiết bị đã nhận
 * tuyến hiện hành; trước khi nhận, hệ thống không đổi tuyến thêm lần nữa.
 */
export async function acknowledgeRoute(tripId, user, { routeVersionId, clientEventId, fp }) {
  return transaction(async c => {
    const t = await lockTrip(c, tripId);
    ensureOwner(t, user);
    if (await findReplay(c, tripId, 'route_acknowledged', clientEventId, fp)) return;
    if (t.status !== 'in_progress') throw conflict('Chuyến không ở trạng thái đang giao');
    if (t.current_route_version !== routeVersionId) throw stale('Tuyến vừa được cập nhật thêm, tải lại chuyến');
    await c.query('UPDATE trips SET driver_ack_route_version = $2 WHERE id = $1', [tripId, routeVersionId]);
    await addEvent(c, { tripId, actorId: user.id, type: 'route_acknowledged', clientEventId, fp, payload: { routeVersionId } });
  });
}

// ---------------------------------------------------------------- UC14 báo về kho

/** Chốt chuyến và giải phóng đơn, xe, Driver. actorId để trống là hệ thống tự chốt. */
async function finishTrip(c, tripId, actorId, payload, ids = {}) {
  await c.query('DELETE FROM active_assignments WHERE trip_id = $1', [tripId]);
  await c.query(`UPDATE trips SET status = 'closed', closed_at = now(), state_version = state_version + 1 WHERE id = $1`, [tripId]);
  await addEvent(c, { tripId, actorId, type: 'trip_closed', payload, ...ids });
}

export async function returnTrip(tripId, user, { returnedOrderIds, clientEventId, fp }) {
  return transaction(async c => {
    const t = await lockTrip(c, tripId);
    ensureOwner(t, user);
    if (await findReplay(c, tripId, 'trip_returned', clientEventId, fp)) return;
    if (t.status !== 'in_progress') throw conflict('Chuyến không ở trạng thái đang giao');
    const stops = (await c.query(
      `SELECT s.id, s.order_id, s.status, o.code FROM trip_stops s JOIN orders o ON o.id = s.order_id
        WHERE s.trip_id = $1 AND s.status <> 'removed'`, [tripId])).rows;
    const pending = stops.filter(s => s.status === 'pending');
    // Báo cáo chỉ được nhận khi mọi điểm đã có kết quả được máy chủ xác nhận (mục 3.5)
    if (pending.length) throw conflict(`Còn ${pending.length} điểm chưa có kết quả`, { pendingOrderCodes: pending.map(s => s.code) });
    const failed = stops.filter(s => s.status === 'failed').map(s => s.order_id);
    const wrong = returnedOrderIds.filter(id => !failed.includes(id));
    if (wrong.length) throw badRequest('Chỉ khai báo các kiện chưa giao được');
    await c.query(`UPDATE trips SET status = 'awaiting_reconciliation', returned_at = now(), state_version = state_version + 1 WHERE id = $1`, [tripId]);
    await addEvent(c, { tripId, actorId: user.id, type: 'trip_returned', clientEventId, fp, payload: { returnedOrderIds, failedOrderIds: failed } });
    // Giao hết, không có hàng mang về: không còn gì để đối chiếu, hệ thống tự chốt và giải phóng xe, Driver ngay
    if (!failed.length) await finishTrip(c, tripId, null, { auto: true, requeue: [], returnToSender: [], lost: [] });
  });
}

// ---------------------------------------------------------------- kết thúc chuyến do sự cố

/**
 * Dispatcher kết thúc chuyến đang giao khi xe hỏng, Driver ốm, mất điện thoại…: mọi điểm chưa giao thành chưa giao được
 * với lý do INCIDENT_REASON do Dispatcher ghi, chuyến chuyển sang chờ đối chiếu như khi Driver báo về kho.
 * Hàng mang về được coi là mọi kiện chưa giao được; kiện không về tới kho thì khi đối chiếu chọn Thất lạc.
 */
export async function abortTrip(tripId, user, { note, clientEventId, fp }) {
  return transaction(async c => {
    const t = await lockTrip(c, tripId);
    if (await findReplay(c, tripId, 'trip_aborted', clientEventId, fp)) return;
    if (t.status !== 'in_progress') throw conflict('Chỉ kết thúc do sự cố được chuyến đang giao');
    const stops = (await c.query(`SELECT id, order_id, status FROM trip_stops WHERE trip_id = $1 AND status <> 'removed' FOR UPDATE`, [tripId])).rows;
    const pending = stops.filter(s => s.status === 'pending');
    for (const s of pending) {
      await c.query(
        `INSERT INTO delivery_attempts (stop_id, client_event_id, result, reason, note, occurred_at, recorded_by)
         VALUES ($1, $2, 'failed', $3, $4, now(), $5)`, [s.id, randomUUID(), INCIDENT_REASON, note, user.id]);
    }
    const pendingIds = pending.map(s => s.id);
    await c.query(`UPDATE trip_stops SET status = 'failed' WHERE id = ANY($1)`, [pendingIds]);
    await c.query(`UPDATE orders SET status = 'needs_action', version = version + 1 WHERE id = ANY($1)`, [pending.map(s => s.order_id)]);
    const failed = stops.filter(s => s.status !== 'delivered').map(s => s.order_id);
    await c.query(`UPDATE trips SET status = 'awaiting_reconciliation', returned_at = now(), state_version = state_version + 1 WHERE id = $1`, [tripId]);
    await addEvent(c, {
      tripId, actorId: user.id, type: 'trip_aborted', clientEventId, fp,
      payload: { reason: INCIDENT_REASON, note, stopIds: pendingIds, orderIds: pending.map(s => s.order_id), failedOrderIds: failed, returnedOrderIds: failed },
    });
  });
}

// ---------------------------------------------------------------- UC09 đối chiếu và chốt chuyến

/**
 * Đơn chưa giao được mặc định giao lại (vào kế hoạch sau) nếu kiện đã mang về kho và chưa quá config.maxDeliveryAttempts lần;
 * Dispatcher chỉ phải chọn cho ngoại lệ. Kiện không có trong báo cáo hàng mang về chỉ chọn được Thất lạc.
 */
export async function closeTrip(tripId, user, { stateVersion, goodsMatched, decisions, clientEventId, fp }) {
  return transaction(async c => {
    const t = await lockTrip(c, tripId);
    if (await findReplay(c, tripId, 'trip_closed', clientEventId, fp)) return;
    if (t.status !== 'awaiting_reconciliation') throw conflict('Chuyến không ở trạng thái chờ đối chiếu');
    if (t.state_version !== stateVersion) throw stale('Dữ liệu chuyến đã thay đổi, tải lại trước khi chốt');
    const stops = (await c.query(
      `SELECT s.order_id, s.status, o.code,
              (SELECT count(*)::int FROM trip_stops f WHERE f.order_id = s.order_id AND f.status = 'failed') AS attempts
         FROM trip_stops s JOIN orders o ON o.id = s.order_id WHERE s.trip_id = $1 AND s.status <> 'removed'`, [tripId])).rows;
    if (stops.some(s => s.status === 'pending')) throw conflict('Còn điểm chưa có kết quả, chưa thể chốt chuyến');
    const report = (await c.query(
      `SELECT payload FROM trip_events WHERE trip_id = $1 AND event_type IN ('trip_returned', 'trip_aborted') ORDER BY id DESC LIMIT 1`,
      [tripId])).rows[0]?.payload;
    const returned = new Set((report?.returnedOrderIds ?? []).map(Number));
    const byOrder = new Map(decisions.map(d => [Number(d?.orderId), d?.decision]));
    const chosen = { requeue: [], return_to_sender: [], lost: [] };
    const undecided = [];
    const notReturned = [];
    for (const s of stops.filter(x => x.status === 'failed')) {
      let d = DECISIONS.includes(byOrder.get(s.order_id)) ? byOrder.get(s.order_id) : null;
      if (!d && returned.has(s.order_id) && s.attempts < config.maxDeliveryAttempts) d = 'requeue';
      if (!d) undecided.push(s);
      else if (d !== 'lost' && !returned.has(s.order_id)) notReturned.push(s);
      else chosen[d].push(s.order_id);
    }
    if (notReturned.length) {
      throw conflict(`Kiện ${notReturned.map(s => s.code).join(', ')} không có trong báo cáo hàng mang về, chỉ chọn được Thất lạc`,
        { orderIds: notReturned.map(s => s.order_id) });
    }
    if (undecided.length) throw conflict(`Còn ${undecided.length} đơn chưa có quyết định`, { orderIds: undecided.map(s => s.order_id) });
    if (goodsMatched !== true) throw conflict('Hàng thực tế tại kho chưa được xác nhận khớp với báo cáo');
    await c.query(`UPDATE orders SET status = 'pending', version = version + 1 WHERE id = ANY($1)`, [chosen.requeue]);
    await c.query(`UPDATE orders SET status = 'return_to_sender', version = version + 1 WHERE id = ANY($1)`, [chosen.return_to_sender]);
    await c.query(`UPDATE orders SET status = 'lost', version = version + 1 WHERE id = ANY($1)`, [chosen.lost]);
    // Chốt chuyến mới giải phóng đơn, xe và Driver
    await finishTrip(c, tripId, user.id,
      { requeue: chosen.requeue, returnToSender: chosen.return_to_sender, lost: chosen.lost, goodsMatched: true }, { clientEventId, fp });
  });
}

// ---------------------------------------------------------------- UC16 thu hồi chuyến chưa xuất phát

export async function revokeTrip(tripId, user, { stateVersion, goodsReturned, clientEventId, fp }) {
  return transaction(async c => {
    const t = await lockTrip(c, tripId);
    if (await findReplay(c, tripId, 'trip_revoked', clientEventId, fp)) return;
    if (t.status === 'in_progress') throw conflict('Tài xế đã bắt đầu chuyến, không thể thu hồi');
    if (t.status !== 'assigned') throw conflict('Chỉ thu hồi được chuyến đã phân nhưng chưa xuất phát');
    if (t.state_version !== stateVersion) throw stale('Dữ liệu chuyến đã thay đổi, tải lại trước khi thu hồi');
    if (goodsReturned !== true) throw conflict('Cần đối chiếu lại hàng đã bàn giao trước khi thu hồi');
    const orderIds = await tripOrderIds(c, tripId);
    await c.query(`UPDATE orders SET status = 'pending', version = version + 1 WHERE id = ANY($1)`, [orderIds]);
    await c.query('DELETE FROM active_assignments WHERE trip_id = $1', [tripId]);
    await c.query(`UPDATE trips SET status = 'revoked', closed_at = now(), state_version = state_version + 1 WHERE id = $1`, [tripId]);
    await addEvent(c, { tripId, actorId: user.id, type: 'trip_revoked', clientEventId, fp, payload: { orderIds } });
  });
}

// ---------------------------------------------------------------- bỏ đơn thiếu khỏi chuyến

/**
 * Hàng thiếu khi xuất phát (Driver báo không khớp): Dispatcher bỏ các đơn thiếu khỏi chuyến chưa xuất phát. Đơn bỏ ra về
 * chờ xếp, chuyến có phiên bản tuyến mới gồm các điểm còn lại theo thứ tự cũ; Driver kiểm lại hàng rồi bắt đầu chuyến.
 */
export async function removeOrders(tripId, user, { orderIds, stateVersion, clientEventId, fp }) {
  const out = await transaction(async c => {
    const t = await lockTrip(c, tripId);
    if (await findReplay(c, tripId, 'orders_removed', clientEventId, fp)) return null;
    if (t.status !== 'assigned') throw conflict('Chỉ bỏ đơn khỏi chuyến chưa xuất phát');
    if (t.state_version !== stateVersion) throw stale('Dữ liệu chuyến đã thay đổi, tải lại trước khi bỏ đơn');
    const order = await currentOrder(c, t);
    if (orderIds.some(id => !order.some(s => s.order_id === id))) throw badRequest('Có đơn không thuộc chuyến này');
    const keep = order.filter(s => !orderIds.includes(s.order_id));
    if (!keep.length) throw conflict('Không thể bỏ hết đơn khỏi chuyến, hãy thu hồi chuyến');
    await c.query(`UPDATE trip_stops SET status = 'removed' WHERE trip_id = $1 AND order_id = ANY($2)`, [tripId, orderIds]);
    await c.query('DELETE FROM active_assignments WHERE trip_id = $1 AND order_id = ANY($2)', [tripId, orderIds]);
    await c.query(`UPDATE orders SET status = 'pending', version = version + 1 WHERE id = ANY($1)`, [orderIds]);
    const depot = await depotOf(c, t);
    const profile = await profileOf(c, t);
    const points = [depot, ...keep.map(stopPoint), depot];
    const v = await addRouteVersion(c, t, { reason: 'orders_removed', sequence: keep.map(s => s.id), objectiveSeconds: await sequenceSeconds(points, profile, t) });
    await addEvent(c, {
      tripId, actorId: user.id, type: 'orders_removed', clientEventId, fp,
      payload: { orderIds, orderCodes: order.filter(s => orderIds.includes(s.order_id)).map(s => s.code), ...v },
    });
    return { ...v, points, profile };
  });
  if (out) fillGeometryLater(out.routeVersionId, out.points, out.profile);
}

// ---------------------------------------------------------------- UC07 điều chỉnh tuyến còn lại

const ageSeconds = t => (Date.now() - new Date(t).getTime()) / 1000;

/** Các đợt ma trận mà tuyến hiện hành đã dùng, để phát hiện tăng thời gian so với đợt mới. */
async function previousBatchIds(trip) {
  const replan = (await query(
    `SELECT payload FROM trip_events WHERE trip_id = $1 AND event_type = 'route_replanned' ORDER BY id DESC LIMIT 1`, [trip.id])).rows[0];
  if (replan?.payload?.batchIds) return replan.payload.batchIds;
  return (await query('SELECT matrix_batch_id FROM planning_run_matrices WHERE planning_run_id = $1', [trip.planningRunId])).rows.map(r => r.matrix_batch_id);
}

/**
 * Đánh giá đổi thứ tự các điểm còn lại (UC07, do kiểm tra theo chu kỳ gọi). Chỉ lấy chặng từ vị trí xe khi thời gian
 * các chặng chung tăng vượt ngưỡng (mục 3.4.5), và chỉ lưu kết quả đánh giá khi phương án mới hợp lệ và đạt
 * ngưỡng tiết kiệm; các trường hợp còn lại trả về skipped và giữ tuyến hiện hành.
 */
export async function evaluateTripReroute(tripId) {
  const trip = await loadTrip(tripId);
  if (!trip) throw notFound('Không tìm thấy chuyến');
  if (trip.status !== 'in_progress') throw conflict('Chỉ đánh giá đổi tuyến khi chuyến đang giao');
  if (trip.needsAck) throw conflict('Thiết bị tài xế chưa nhận tuyến hiện hành, chưa đánh giá thêm');
  if (!trip.position) throw conflict('Chưa có vị trí xe để đánh giá');
  if (ageSeconds(trip.position.observedAt) > config.reroute.maxPositionAgeSeconds) {
    throw conflict(`Vị trí xe cũ hơn ${config.reroute.maxPositionAgeSeconds} giây, chưa đánh giá được`);
  }
  const remaining = trip.stops.filter(s => s.status === 'pending');
  if (remaining.length < 3) throw conflict('Còn ít hơn 3 điểm chưa giao nên không có thứ tự nào khác để đổi');

  const profile = trip.vehicle.profile;
  const posKey = pointKey('p', trip.position.id, trip.position.lat, trip.position.lon);
  const dKey = pointKey('d', trip.depot.id, trip.depot.lat, trip.depot.lon);
  const key = s => locationKey(s.order.lat, s.order.lon);
  const stopPoints = remaining.map(s => ({ key: key(s), lat: s.order.lat, lon: s.order.lon }));
  const maxAgeSeconds = config.matrixSource === 'tomtom' ? config.reroute.maxEvaluationAgeSeconds : null;
  const t0 = performance.now();
  const depotPoint = { key: dKey, lat: trip.depot.lat, lon: trip.depot.lon };
  const service = { stopSeconds: trip.service.stopSeconds, serviceSeconds: trip.service.serviceSeconds };
  const base = localMidnight();
  const nowSeconds = secondsFrom(base, new Date());
  const stops = remaining.map(s => ({
    id: s.id, point: key(s), pinned: s.deferred,
    notBeforeSeconds: s.order.notBeforeAt ? secondsFrom(base, s.order.notBeforeAt) : null,
  }));
  // Bước 1: chỉ các chặng nối tiếp theo thứ tự hiện hành (điểm kế tiếp → điểm sau → … → kho), k chặng cho k điểm,
  // đủ để phát hiện tăng thời gian. Với nguồn tomtom, mỗi lần kiểm tra chỉ tốn khoảng k yêu cầu Routing
  const chain = [...remaining.map(key), dKey];
  const chainPairs = chain.slice(0, -1).map((a, i) => [a, chain[i + 1]]).filter(([a, b]) => a !== b);
  const chainMatrix = await buildMatrix({ points: [depotPoint, ...stopPoints], profiles: [profile], maxAgeSeconds, pairs: chainPairs });
  const oldAt = await loadBatches(await previousBatchIds(trip));
  // Thời gian phụ thuộc giờ: mỗi chặng so tại giờ xe dự kiến rời điểm đầu theo thứ tự hiện hành (dữ liệu mới, có phục vụ)
  const sched = stopSchedule({ depot: dKey, travelAt: chainMatrix.travelAt, startSeconds: nowSeconds, ...service, profile, start: chain[0], stops: stops.slice(1) });
  const departAt = new Map();
  chain.slice(0, -1).forEach((a, i) => {
    const t = i === 0 ? nowSeconds : sched ? sched.arrivals[i - 1] + (chain[i - 1] !== a ? service.stopSeconds : 0) + service.serviceSeconds : nowSeconds;
    if (!departAt.has(`${a}|${chain[i + 1]}`)) departAt.set(`${a}|${chain[i + 1]}`, t);
  });
  const at = (a, b) => departAt.get(`${a}|${b}`) ?? nowSeconds;
  const increase = detectIncrease({
    points: chain, profile,
    oldTravel: (p, a, b) => oldAt(p, a, b, at(a, b)),
    newTravel: (p, a, b) => chainMatrix.travelAt(p, a, b, at(a, b)),
  });
  increase.slowLegs = increase.slowLegs.map(l => ({
    fromStopId: remaining[l.index].id, toStopId: remaining[l.index + 1]?.id ?? null, before: l.before, after: l.after,
  }));
  // Chưa đủ ngưỡng, hoặc không còn chặng chung để so sánh: giữ tuyến hiện hành, không gọi thêm TomTom
  if (!increase.triggered) return { skipped: true, increase };

  // Bước 2: chỉ khi đã phát hiện tăng mới lấy các chặng còn lại giữa kho và các điểm (khoảng k² chặng) và chặng
  // từ vị trí xe tới các điểm còn lại (k chặng). Optimization Engine chỉ đi từ vị trí xe ra,
  // không bao giờ quay về vị trí xe, nên không lấy chiều ngược lại
  const inChain = new Set(chainPairs.map(([a, b]) => `${a}|${b}`));
  const uniq = [...new Set(chain)];
  const restPairs = uniq.flatMap(a => uniq.filter(b => b !== a && !inChain.has(`${a}|${b}`)).map(b => [a, b]));
  const restMatrix = await buildMatrix({ points: [depotPoint, ...stopPoints], profiles: [profile], maxAgeSeconds, pairs: restPairs });
  const posMatrix = await buildMatrix({
    points: [{ key: posKey, lat: trip.position.lat, lon: trip.position.lon }, ...stopPoints], profiles: [profile], maxAgeSeconds,
    pairs: [...new Set(remaining.map(key))].map(k => [posKey, k]),
  });
  const matrix = combineMatrices(combineMatrices(chainMatrix, restMatrix), posMatrix);
  const matrixMs = performance.now() - t0;

  // Điểm kế tiếp giữ nguyên, điểm giao sau ghim cuối tuyến, đơn khách hẹn giờ thì chờ đến giờ hẹn
  const ev = evaluateReroute({
    depot: dKey, travelAt: matrix.travelAt, startSeconds: nowSeconds, ...service, profile, start: posKey, stops,
    minSavingSeconds: config.reroute.minSavingSeconds, minSavingRatio: config.reroute.minSavingRatio,
    maxEvaluations: config.maxEvaluations, maxMs: config.maxSearchMs,
  });
  if (!(ev.valid && ev.meetsThreshold)) return { skipped: true, increase, ...ev };

  const payload = {
    stateVersion: trip.stateVersion,
    routeVersionId: trip.routeVersion.id,
    routeVersionNo: trip.routeVersion.versionNo,
    positionId: trip.position.id,
    position: { lat: trip.position.lat, lon: trip.position.lon, observedAt: trip.position.observedAt },
    nextStopId: remaining[0].id,
    currentStopIds: remaining.map(s => s.id),
    ...ev,
    increase,
    matrix: { batchIds: matrix.batchIds, ...matrix.stats, ms: Math.round(matrixMs) },
  };
  const { rows } = await query(
    `INSERT INTO trip_events (trip_id, actor_id, event_type, payload) VALUES ($1, NULL, 'reroute_evaluated', $2) RETURNING id, created_at`,
    [tripId, payload]);
  return { eventId: rows[0].id, createdAt: rows[0].created_at, ...payload };
}

/**
 * Hệ thống áp dụng thứ tự mới của một lần đánh giá, không cần Dispatcher duyệt. Mọi điều kiện được kiểm tra lại
 * dưới khóa chuyến (mục 3.4.7); không đạt thì báo lỗi và giữ tuyến hiện hành.
 */
export async function applyReroute(tripId, eventId) {
  const applied = await transaction(async c => {
    const t = await lockTrip(c, tripId);
    const ev = (await c.query(
      `SELECT * FROM trip_events WHERE id = $1 AND trip_id = $2 AND event_type = 'reroute_evaluated'`, [eventId, tripId])).rows[0];
    if (!ev) throw notFound('Không tìm thấy kết quả đánh giá đổi tuyến');
    const handled = (await c.query(
      `SELECT 1 FROM trip_events WHERE trip_id = $1 AND event_type = 'route_replanned' AND payload->>'evaluationEventId' = $2`,
      [tripId, String(eventId)])).rows.length;
    if (handled) throw conflict('Kết quả đánh giá này đã được áp dụng');
    const p = ev.payload;
    if (t.status !== 'in_progress') throw conflict('Chuyến không còn ở trạng thái đang giao');
    if (!p.valid || !p.meetsThreshold) throw conflict('Phương án mới không đạt điều kiện áp dụng');
    // Kiểm tra lại dưới khóa (mục 3.4.7): trạng thái, phiên bản tuyến, thiết bị Driver đã nhận tuyến hiện hành, độ mới của dữ liệu
    if (t.state_version !== p.stateVersion || t.current_route_version !== p.routeVersionId) {
      throw stale('Chuyến vừa thay đổi (điểm đã giao hoặc tuyến mới), cần đánh giá lại');
    }
    if (t.driver_ack_route_version !== t.current_route_version) throw conflict('Thiết bị tài xế chưa nhận tuyến hiện hành');
    if (ageSeconds(ev.created_at) > config.reroute.maxEvaluationAgeSeconds) {
      throw stale(`Kết quả đánh giá đã cũ hơn ${config.reroute.maxEvaluationAgeSeconds} giây, cần đánh giá lại`);
    }
    const pos = (await c.query('SELECT latitude, longitude, observed_at FROM vehicle_positions WHERE trip_id = $1 ORDER BY observed_at DESC LIMIT 1', [tripId])).rows[0];
    if (!pos || ageSeconds(pos.observed_at) > config.reroute.maxPositionAgeSeconds) throw stale('Vị trí xe đã cũ, cần đánh giá lại');
    const moved = haversineM({ lat: pos.latitude, lon: pos.longitude }, p.position);
    if (moved > config.reroute.maxDisplacementM) throw stale(`Xe đã đi thêm ${Math.round(moved)} m kể từ lúc đánh giá, cần đánh giá lại`);
    const lastReplan = (await c.query(`SELECT created_at FROM route_versions WHERE trip_id = $1 AND reason = 'replan' ORDER BY version_no DESC LIMIT 1`, [tripId])).rows[0];
    if (lastReplan && ageSeconds(lastReplan.created_at) < config.reroute.cooldownSeconds) {
      throw conflict(`Chưa đủ ${config.reroute.cooldownSeconds} giây kể từ lần đổi tuyến trước`);
    }
    const order = (await c.query(
      `SELECT s.id, s.status FROM route_stops rs JOIN trip_stops s ON s.id = rs.stop_id
        WHERE rs.route_version_id = $1 ORDER BY rs.sequence_no`, [t.current_route_version])).rows;
    const pendingIds = order.filter(s => s.status === 'pending').map(s => s.id);
    if (pendingIds.join(',') !== p.currentStopIds.join(',')) throw stale('Danh sách điểm chưa giao đã thay đổi, cần đánh giá lại');

    const fromNo = (await c.query('SELECT version_no FROM route_versions WHERE id = $1', [t.current_route_version])).rows[0].version_no;
    const batchId = p.matrix.batchIds.at(-1) ?? null;
    const rvId = (await c.query(
      `INSERT INTO route_versions (trip_id, matrix_batch_id, version_no, objective_seconds, reason)
       VALUES ($1, $2, $3, $4, 'replan') RETURNING id`, [tripId, batchId, fromNo + 1, Math.round(p.proposedSeconds)])).rows[0].id;
    // Điểm đã xử lý giữ nguyên vị trí, điểm kế tiếp vẫn đứng đầu phần còn lại
    const sequence = [...order.filter(s => s.status !== 'pending').map(s => s.id), ...p.proposedStopIds];
    for (let i = 0; i < sequence.length; i++) {
      await c.query('INSERT INTO route_stops (route_version_id, stop_id, sequence_no) VALUES ($1, $2, $3)', [rvId, sequence[i], i + 1]);
    }
    await c.query('UPDATE trips SET current_route_version = $2, state_version = state_version + 1 WHERE id = $1', [tripId, rvId]);
    // Người thực hiện để trống: hệ thống tự đổi tuyến
    await addEvent(c, {
      tripId, actorId: null, type: 'route_replanned',
      payload: {
        evaluationEventId: eventId, routeVersionId: rvId, fromVersion: fromNo, toVersion: fromNo + 1,
        savingSeconds: p.savingSeconds, batchIds: p.matrix.batchIds,
      },
    });
    return { rvId, fromNo, p };
  });
  const trip = await loadTrip(tripId);
  const byId = new Map(trip.stops.map(s => [s.id, s]));
  fillGeometryLater(applied.rvId, [applied.p.position, ...applied.p.proposedStopIds.map(id => byId.get(id).order), trip.depot], trip.vehicle.profile);
  return { routeVersionId: applied.rvId, fromVersion: applied.fromNo, toVersion: applied.fromNo + 1, savingSeconds: applied.p.savingSeconds };
}

// ---------------------------------------------------------------- đi theo tài xế: giao khác thứ tự, lệch tuyến

/**
 * Dữ liệu để sắp lại các điểm còn lại của một chuyến: điểm xuất phát, giờ xuất phát (giây kể từ 0:00 của ngày đó) và thời
 * gian phụ thuộc giờ giữa điểm xuất phát, các điểm chưa giao và kho. Chặng chưa có thì lấy thêm như lập kế hoạch, vẫn
 * không có thì ước lượng theo đường chim bay, để luôn sắp lại được.
 *  from:      { lat, lon, key? } điểm xuất phát; mặc định vị trí xe còn mới, nếu không thì điểm vừa xử lý gần nhất hoặc kho
 *  notBefore: Map(mã điểm dừng → thời điểm hoặc null) giờ hẹn mới chưa lưu (khách vừa chọn)
 * Chuyến chưa xuất phát tính từ kho lúc bắt đầu ca (hoặc bây giờ nếu đã qua giờ đó).
 */
export async function remainingContext(trip, { from = null, notBefore = new Map() } = {}) {
  const profile = trip.vehicle.profile;
  const dKey = pointKey('d', trip.depot.id, trip.depot.lat, trip.depot.lon);
  const pending = trip.stops.filter(s => s.status === 'pending');
  const key = s => locationKey(s.order.lat, s.order.lon);
  const running = trip.status === 'in_progress';
  const now = Date.now();
  let start = from;
  if (!start && running && trip.position && ageSeconds(trip.position.observedAt) <= config.monitor.stalePositionSeconds) {
    start = { lat: trip.position.lat, lon: trip.position.lon, key: pointKey('p', trip.position.id, trip.position.lat, trip.position.lon) };
  }
  if (!start && running) {
    const lastDone = trip.stops.filter(s => s.attempt).sort((a, b) => new Date(b.attempt.occurredAt) - new Date(a.attempt.occurredAt))[0];
    if (lastDone) start = { lat: lastDone.order.lat, lon: lastDone.order.lon };
  }
  start ??= { lat: trip.depot.lat, lon: trip.depot.lon, key: dKey };
  start = { ...start, key: start.key ?? locationKey(start.lat, start.lon) };
  const startMs = running ? now : Math.max(now, trip.shiftStartAt ? new Date(trip.shiftStartAt).getTime() : 0);
  const base = localMidnight(new Date(startMs));
  const startSeconds = secondsFrom(base, startMs);
  const points = [start, { key: dKey, lat: trip.depot.lat, lon: trip.depot.lon }, ...pending.map(s => ({ key: key(s), lat: s.order.lat, lon: s.order.lon }))];
  const coords = new Map(points.map(p => [p.key, p]));
  const targets = [...coords.keys()].filter(k => k !== start.key);
  // Chặng từ điểm xuất phát tới các điểm còn lại và kho; giữa các điểm còn lại và kho theo cả hai chiều
  const pairs = [...targets.map(b => [start.key, b]), ...targets.flatMap(a => targets.filter(b => b !== a).map(b => [a, b]))];
  const matrix = await buildMatrix({
    points: [...coords.values()], profiles: [profile], pairs, departAt: new Date(startMs),
    maxAgeSeconds: config.matrixSource === 'tomtom' ? config.reroute.maxEvaluationAgeSeconds : null,
  });
  const travelAt = etaTravel(matrix.travelAt, coords);
  const stops = pending.map(s => {
    const nb = notBefore.has(s.id) ? notBefore.get(s.id) : s.order.notBeforeAt;
    return { id: s.id, point: key(s), pinned: s.deferred, notBeforeSeconds: nb ? secondsFrom(base, nb) : null };
  });
  const byId = new Map(stops.map(s => [s.id, s]));
  return {
    trip, profile, depot: dKey, start, base, startSeconds, travelAt, stops, pending, matrix, service: trip.service,
    /** Sắp lại phần còn lại (Optimization Engine). lockNext: giữ điểm kế tiếp. */
    evaluate: ({ lockNext = false, exclude = null } = {}) => evaluateReroute({
      depot: dKey, travelAt, startSeconds, ...trip.service, profile, start: start.key,
      stops: exclude ? stops.filter(s => !exclude.has(s.id)) : stops, lockNext,
      minSavingSeconds: config.reroute.minSavingSeconds, minSavingRatio: config.reroute.minSavingRatio,
      maxEvaluations: config.maxEvaluations, maxMs: config.maxSearchMs,
    }),
    /** Lịch theo một thứ tự (mã điểm dừng): giờ dự kiến từng điểm (giây kể từ 0:00) và giờ về kho. */
    schedule: ids => stopSchedule({
      depot: dKey, travelAt, startSeconds, ...trip.service, profile, start: start.key, stops: ids.map(id => byId.get(id)),
    }),
  };
}

// Mỗi chuyến chỉ một lần sắp lại theo tài xế chạy cùng lúc; lần xét lệch tuyến gần nhất của từng chuyến
const following = new Set();
const offRouteCheckedAt = new Map();

/**
 * Hệ thống đi theo tài xế (tài xế giao khác thứ tự, xe lệch tuyến): sắp lại mọi điểm còn lại từ chỗ tài xế đang đứng,
 * không giữ điểm kế tiếp và không cần ngưỡng tiết kiệm. Điểm giao sau vẫn ghim cuối tuyến, đơn khách hẹn giờ chờ đến
 * giờ hẹn. Thứ tự mới khác thứ tự hiện hành thì tạo phiên bản tuyến mới (người thực hiện để trống: hệ thống); ứng dụng
 * tài xế tự nhận tuyến mới khi tải chuyến.
 */
export async function followDriver(tripId, { trigger, from = null, stopId = null }) {
  if (following.has(tripId)) return null;
  following.add(tripId);
  try {
    const trip = await loadTrip(tripId);
    if (!trip || trip.status !== 'in_progress') return null;
    const pending = trip.stops.filter(s => s.status === 'pending');
    if (pending.length < 2) return { changed: false };
    const ctx = await remainingContext(trip, { from });
    const ev = ctx.evaluate({ lockNext: false });
    if (!ev.valid) return null;
    const currentIds = pending.map(s => s.id);
    if (ev.proposedStopIds.join(',') === currentIds.join(',')) return { changed: false };
    const out = await transaction(async c => {
      const t = await lockTrip(c, tripId);
      // Chuyến vừa thay đổi (thêm kết quả, tuyến mới): bỏ lần sắp này, lần thay đổi sau tự xét lại
      if (t.status !== 'in_progress' || t.state_version !== trip.stateVersion) return null;
      const order = await currentOrder(c, t);
      const v = await addRouteVersion(c, t, {
        reason: trigger, sequence: [...order.filter(s => s.status !== 'pending').map(s => s.id), ...ev.proposedStopIds],
        objectiveSeconds: ev.proposedSeconds,
      });
      await addEvent(c, {
        tripId, actorId: null, type: 'route_resequenced',
        payload: {
          trigger, stopId, ...v, start: { lat: ctx.start.lat, lon: ctx.start.lon }, stopIds: ev.proposedStopIds, previousStopIds: currentIds,
          currentSeconds: ev.currentSeconds, proposedSeconds: ev.proposedSeconds, flippedPairs: ev.flippedPairs,
        },
      });
      return v;
    });
    if (!out) return null;
    const byId = new Map(trip.stops.map(s => [s.id, s.order]));
    fillGeometryLater(out.routeVersionId, [ctx.start, ...ev.proposedStopIds.map(id => byId.get(id)), trip.depot], ctx.profile);
    return { changed: true, ...out, stopIds: ev.proposedStopIds };
  } finally {
    following.delete(tripId);
  }
}

/**
 * Lệch tuyến (UC07): các vị trí mới nhất kể từ khi có tuyến hiện hành đều cách đường đi của tuyến quá OFF_ROUTE_METERS,
 * ít nhất OFF_ROUTE_POSITIONS vị trí liên tiếp và kéo dài ít nhất OFF_ROUTE_SECONDS giây: sắp lại các điểm còn lại từ vị
 * trí xe. Tuyến chưa có đường đi thì không xét được. Mỗi chuyến xét tối đa một lần trong OFF_ROUTE_SECONDS (ít nhất 30 giây).
 */
export async function checkOffRoute(tripId) {
  const { meters, seconds, positions } = config.offRoute;
  if (!meters || following.has(tripId)) return null;
  if (Date.now() - (offRouteCheckedAt.get(tripId) ?? 0) < Math.max(30, seconds) * 1000) return null;
  const t = (await query(
    `SELECT t.status, rv.geometry, rv.created_at FROM trips t JOIN route_versions rv ON rv.id = t.current_route_version WHERE t.id = $1`,
    [tripId])).rows[0];
  if (!t || t.status !== 'in_progress' || !t.geometry?.coordinates?.length) return null;
  const rows = (await query(
    `SELECT id, latitude AS lat, longitude AS lon, observed_at FROM vehicle_positions
      WHERE trip_id = $1 AND observed_at > $2 ORDER BY observed_at DESC LIMIT 200`, [tripId, t.created_at])).rows;
  const off = [];
  for (const r of rows) {
    if (distanceToLine(r, t.geometry.coordinates) <= meters) break;
    off.push(r);
  }
  if (!off.length || off.length < Math.max(1, positions)) return null;
  if ((new Date(off[0].observed_at) - new Date(off.at(-1).observed_at)) / 1000 < seconds) return null;
  offRouteCheckedAt.set(tripId, Date.now());
  const p = off[0];
  return followDriver(tripId, { trigger: 'off_route', from: { lat: p.lat, lon: p.lon, key: pointKey('p', p.id, p.lat, p.lon) } });
}

// ---------------------------------------------------------------- kiểm tra theo chu kỳ (UC07)

let checking = false;

/**
 * Mỗi chu kỳ xét các chuyến đang giao: bỏ qua chuyến mà thiết bị Driver chưa nhận tuyến hiện hành, vị trí đã cũ,
 * còn ít hơn 3 điểm hoặc chưa hết thời gian chờ sau lần đổi tuyến trước. Phương án mới hợp lệ và đạt ngưỡng
 * tiết kiệm thì hệ thống áp dụng ngay; không đạt điều kiện áp dụng thì giữ tuyến hiện hành.
 * Trả về kết quả từng chuyến: applied (đã đổi tuyến), kept (đã xét, giữ tuyến) hoặc skipped (không xét), kèm lý do.
 */
export async function periodicRerouteCheck() {
  if (checking) return [];
  checking = true;
  const results = [];
  try {
    const { rows } = await query(`SELECT id FROM trips WHERE status = 'in_progress' ORDER BY id`);
    for (const { id } of rows) {
      const trip = await loadTrip(id);
      const out = (outcome, reason, extra) => results.push({ tripId: id, code: trip.code, outcome, reason, ...extra });
      if (trip.needsAck) { out('skipped', 'needs_ack'); continue; }
      if (!trip.position || ageSeconds(trip.position.observedAt) > config.reroute.maxPositionAgeSeconds) { out('skipped', 'stale_position'); continue; }
      if (trip.stops.filter(s => s.status === 'pending').length < 3) { out('skipped', 'few_stops'); continue; }
      // Trong thời gian chờ sau lần đổi tuyến trước thì không đánh giá, tránh tốn yêu cầu TomTom cho phương án không áp dụng được
      if (trip.lastReplan && ageSeconds(trip.lastReplan.at) < config.reroute.cooldownSeconds) { out('skipped', 'cooldown'); continue; }
      try {
        const ev = await evaluateTripReroute(id);
        if (ev.skipped) {
          if (!ev.increase.legs) console.log(`Kiểm tra định kỳ ${trip.code}: không còn chặng chung đủ dữ liệu để so sánh, giữ tuyến hiện hành`);
          else if (ev.increase.triggered && ev.valid === false) console.log(`Kiểm tra định kỳ ${trip.code}: ${ev.reason}, giữ tuyến hiện hành`);
          else if (ev.increase.triggered) {
            console.log(`Kiểm tra định kỳ ${trip.code}: thời gian còn lại tăng ${ev.increase.increase} giây nhưng thứ tự mới chỉ tiết kiệm ${ev.savingSeconds} giây, chưa đạt ngưỡng, giữ tuyến hiện hành`);
          }
          out('kept', ev.increase.triggered ? 'below_threshold' : 'no_increase');
          continue;
        }
        try {
          const r = await applyReroute(id, ev.eventId);
          console.log(`Kiểm tra định kỳ ${trip.code}: thời gian còn lại tăng ${ev.increase.increase} giây, đã đổi sang tuyến phiên bản ${r.toVersion}, tiết kiệm ${ev.savingSeconds} giây`);
          out('applied', null, r);
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          // Dữ liệu vừa thay đổi hoặc không còn đạt điều kiện: giữ tuyến hiện hành, chu kỳ sau đánh giá lại
          console.log(`Kiểm tra định kỳ ${trip.code}: không đổi tuyến (${err.message}), giữ tuyến hiện hành`);
          out('kept', err.message);
        }
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(`Kiểm tra định kỳ ${trip.code} lỗi`, err.message);
        out('kept', err.message);
      }
    }
  } finally {
    checking = false;
  }
  return results;
}
