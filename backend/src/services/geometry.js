// Lấy bổ sung đường đi còn thiếu (GeoJSON) cho tuyến của chuyến chưa kết thúc và bản nháp kế hoạch.
// Đường đi thường được lấy ngay khi lập kế hoạch hoặc đổi tuyến; nếu lần đó TomTom từ chối (429, lỗi mạng…)
// thì việc này thử lại theo chu kỳ, mỗi lượt tối đa vài yêu cầu, mỗi tuyến chờ lâu dần giữa các lần thử.
import { query } from '../db.js';
import { hasKey, routeGeometry } from './tomtom.js';

const PER_RUN = 2;
const MAX_ATTEMPTS = 8;
const attempts = new Map();

/** Đến lượt thử lại chưa: lần thử thứ n chờ 2^n phút (tối đa 30 phút), quá MAX_ATTEMPTS thì thôi đến khi khởi động lại. */
function due(key) {
  const a = attempts.get(key);
  return !a || (a.count < MAX_ATTEMPTS && Date.now() >= a.next);
}
function failed(key) {
  const count = (attempts.get(key)?.count ?? 0) + 1;
  attempts.set(key, { count, next: Date.now() + Math.min(30, 2 ** count) * 60_000 });
}

/** Các điểm của một phiên bản tuyến theo đúng thứ tự xe chạy. */
async function routeVersionPoints(rv) {
  const depot = { lat: rv.depot_lat, lon: rv.depot_lon };
  if (rv.reason === 'replan') {
    // Tuyến đổi giữa chừng bắt đầu từ vị trí xe lúc đánh giá, đi qua các điểm còn lại theo thứ tự mới rồi về kho
    const ev = (await query(
      `SELECT e.payload FROM trip_events r
         JOIN trip_events e ON e.trip_id = r.trip_id AND e.event_type = 'reroute_evaluated' AND e.id::text = r.payload->>'evaluationEventId'
        WHERE r.trip_id = $1 AND r.event_type = 'route_replanned' AND (r.payload->>'toVersion')::int = $2
        ORDER BY r.id DESC LIMIT 1`, [rv.trip_id, rv.version_no])).rows[0]?.payload;
    if (!ev?.position || !ev.proposedStopIds?.length) return null;
    const stops = (await query(
      `SELECT s.id, o.latitude AS lat, o.longitude AS lon FROM trip_stops s JOIN orders o ON o.id = s.order_id WHERE s.id = ANY($1)`,
      [ev.proposedStopIds])).rows;
    const byId = new Map(stops.map(s => [s.id, s]));
    if (ev.proposedStopIds.some(id => !byId.has(id))) return null;
    return [ev.position, ...ev.proposedStopIds.map(id => byId.get(id)), depot];
  }
  if (rv.reason === 'deferred') {
    // Giao sau: từ vị trí xe (hoặc điểm vừa xử lý) lúc Driver dời điểm, qua các điểm còn lại theo thứ tự mới rồi về kho
    const ev = (await query(
      `SELECT payload FROM trip_events WHERE trip_id = $1 AND event_type = 'stop_deferred' AND (payload->>'routeVersionId')::int = $2
        ORDER BY id DESC LIMIT 1`, [rv.trip_id, rv.id])).rows[0]?.payload;
    if (!ev?.start || !ev.stopIds?.length) return null;
    const stops = (await query(
      `SELECT s.id, o.latitude AS lat, o.longitude AS lon FROM trip_stops s JOIN orders o ON o.id = s.order_id WHERE s.id = ANY($1)`,
      [ev.stopIds])).rows;
    const byId = new Map(stops.map(s => [s.id, s]));
    if (ev.stopIds.some(id => !byId.has(id))) return null;
    return [ev.start, ...ev.stopIds.map(id => byId.get(id)), depot];
  }
  const stops = (await query(
    `SELECT o.latitude AS lat, o.longitude AS lon FROM route_stops rs
       JOIN trip_stops s ON s.id = rs.stop_id JOIN orders o ON o.id = s.order_id
      WHERE rs.route_version_id = $1 ORDER BY rs.sequence_no`, [rv.id])).rows;
  return stops.length ? [depot, ...stops, depot] : null;
}

/**
 * Một lượt lấy bổ sung: ưu tiên tuyến của chuyến chưa kết thúc (mới nhất trước), rồi tới bản nháp kế hoạch.
 * Không có khóa TomTom thì không làm gì. Trả về số đường đi đã lấy được.
 */
export async function backfillGeometry({ limit = PER_RUN } = {}) {
  if (!hasKey()) return 0;
  let calls = 0;
  let filled = 0;

  const versions = (await query(
    `SELECT rv.id, rv.trip_id, rv.version_no, rv.reason, v.routing_profile,
            dp.latitude AS depot_lat, dp.longitude AS depot_lon
       FROM route_versions rv
       JOIN trips t ON t.id = rv.trip_id
       JOIN vehicles v ON v.id = t.vehicle_id
       JOIN depots dp ON dp.id = t.depot_id
      WHERE rv.geometry IS NULL AND t.status IN ('assigned', 'in_progress')
      ORDER BY rv.id DESC`)).rows;
  for (const rv of versions) {
    const key = `rv${rv.id}`;
    if (calls >= limit) return filled;
    if (!due(key)) continue;
    const points = await routeVersionPoints(rv);
    if (!points) { failed(key); continue; }
    calls++;
    const g = await routeGeometry(points, rv.routing_profile).catch(() => null);
    if (!g) { failed(key); continue; }
    await query('UPDATE route_versions SET geometry = $2 WHERE id = $1 AND geometry IS NULL', [rv.id, g]);
    attempts.delete(key);
    filled++;
  }

  const drafts = (await query(`SELECT id, input_snapshot, result FROM planning_runs WHERE status = 'draft' ORDER BY id DESC`)).rows;
  for (const run of drafts) {
    const snap = run.input_snapshot;
    const routes = run.result?.routes ?? [];
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const key = `pr${run.id}:${i}`;
      if (r.geometry || !due(key)) continue;
      if (calls >= limit) return filled;
      const v = snap.vehicles.find(x => x.id === r.vehicleId);
      const orders = r.orderIds.map(id => snap.orders.find(o => o.id === id));
      if (!v || orders.some(o => !o)) { failed(key); continue; }
      calls++;
      const g = await routeGeometry([snap.depot, ...orders, snap.depot], v.profile).catch(() => null);
      if (!g) { failed(key); continue; }
      // Chỉ ghi khi bản nháp vẫn còn hiệu lực và tuyến đó vẫn chưa có đường đi
      await query(
        `UPDATE planning_runs SET result = jsonb_set(result, ARRAY['routes', $2::text, 'geometry'], $3::jsonb)
          WHERE id = $1 AND status = 'draft' AND COALESCE(result->'routes'->$4::int->'geometry', 'null'::jsonb) = 'null'::jsonb`,
        [run.id, String(i), JSON.stringify(g), i]);
      attempts.delete(key);
      filled++;
    }
  }
  return filled;
}
