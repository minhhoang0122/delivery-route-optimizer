// Lập kế hoạch giao hàng (UC04): kiểm tra đầu vào, lập ma trận, gọi Optimization Engine, lưu bản nháp.
// Bản nháp chỉ là đề xuất, chưa giữ chỗ đơn, xe hay Driver (planning_runs, mục 3.2.4).
import { plan } from 'optimization-engine';
import { config } from '../config.js';
import { query, transaction } from '../db.js';
import { badRequest } from '../errors.js';
import { buildMatrix, pointKey } from './matrix.js';
import { routeGeometry } from './tomtom.js';

const ACTIVE = `('assigned', 'in_progress', 'awaiting_reconciliation')`;

// Tiến độ của các lần tính đang chạy, để giao diện hỏi lại theo mã yêu cầu (mục 3.3.4)
const progress = new Map();
export const getProgress = id => progress.get(id) || null;

export async function loadDepot(depotId) {
  const { rows } = await query(
    depotId ? 'SELECT * FROM depots WHERE id = $1' : 'SELECT * FROM depots ORDER BY id LIMIT 1',
    depotId ? [depotId] : []);
  return rows[0] || null;
}

/** Đơn chờ xếp kèm loại xe được phép. */
export async function loadOrders(where = `o.status = 'pending'`, params = []) {
  const { rows } = await query(
    `SELECT o.*, COALESCE(array_agg(t.vehicle_type ORDER BY t.vehicle_type) FILTER (WHERE t.vehicle_type IS NOT NULL), '{}') AS vehicle_types
       FROM orders o LEFT JOIN order_vehicle_types t ON t.order_id = o.id
      WHERE ${where}
      GROUP BY o.id ORDER BY o.code`, params);
  return rows;
}

/** Xe kèm Driver thường dùng và tình trạng bận của cả hai. */
export async function loadVehicles(where = 'TRUE', params = []) {
  const { rows } = await query(
    `SELECT v.*, d.id AS driver_id, d.full_name AS driver_name, d.phone AS driver_phone, d.status AS driver_status,
            u.status AS account_status,
            EXISTS (SELECT 1 FROM trips t WHERE t.vehicle_id = v.id AND t.status IN ${ACTIVE}) AS vehicle_busy,
            EXISTS (SELECT 1 FROM trips t WHERE t.driver_id = d.id AND t.status IN ${ACTIVE}) AS driver_busy
       FROM vehicles v
       LEFT JOIN drivers d ON d.default_vehicle_id = v.id
       LEFT JOIN users u ON u.id = d.user_id
      WHERE ${where}
      ORDER BY v.id`, params);
  return rows;
}

/** Lý do một xe không tham gia được kế hoạch, hoặc null nếu sẵn sàng. */
export function vehicleProblem(v) {
  if (v.status !== 'active') return 'Xe đang bảo trì';
  if (v.vehicle_busy) return 'Xe đang có chuyến hoạt động';
  if (!v.driver_id) return 'Xe chưa có Driver thường dùng';
  if (v.driver_status !== 'active') return 'Driver ngừng hoạt động';
  if (v.account_status !== 'active') return 'Tài khoản Driver đã bị khóa';
  if (v.driver_busy) return 'Driver đang có chuyến hoạt động';
  return null;
}

/** Lý do một đơn không vào được kế hoạch (FR02), hoặc null nếu hợp lệ. */
export function orderProblem(o) {
  if (o.status !== 'pending') return 'Đơn không ở trạng thái chờ xếp';
  if (!(o.weight_kg > 0)) return 'Khối lượng phải lớn hơn 0';
  if (!o.vehicle_types.length) return 'Chưa chọn loại xe được phép';
  if (o.latitude == null || o.longitude == null) return 'Thiếu tọa độ';
  return null;
}

/** Kiểm tra đầu vào và tạo bản chụp dữ liệu tại thời điểm lập kế hoạch (input_snapshot). */
export async function prepareSnapshot({ orderIds, vehicleIds, maxRouteMinutes, depotId }) {
  const depot = await loadDepot(depotId);
  if (!depot) throw badRequest('Chưa khai báo kho xuất phát');
  const orders = await loadOrders('o.id = ANY($1)', [orderIds]);
  const vehicles = await loadVehicles('v.id = ANY($1)', [vehicleIds]);
  const problems = [];
  for (const id of orderIds) {
    const o = orders.find(x => x.id === id);
    const p = o ? orderProblem(o) : 'Không tìm thấy đơn';
    if (p) problems.push({ type: 'order', id, code: o?.code, reason: p });
  }
  for (const id of vehicleIds) {
    const v = vehicles.find(x => x.id === id);
    const p = v ? vehicleProblem(v) : 'Không tìm thấy xe';
    if (p) problems.push({ type: 'vehicle', id, plate: v?.plate, reason: p });
  }
  if (problems.length) throw badRequest('Dữ liệu đầu vào không hợp lệ, chưa lưu bản nháp', problems);
  return {
    depot: { id: depot.id, name: depot.name, address: depot.address, lat: depot.latitude, lon: depot.longitude },
    orders: orders.map(o => ({
      id: o.id, code: o.code, version: o.version, recipientName: o.recipient_name, address: o.address,
      lat: o.latitude, lon: o.longitude, weightKg: o.weight_kg, vehicleTypes: o.vehicle_types,
    })),
    vehicles: vehicles.map(v => ({
      id: v.id, plate: v.plate, type: v.vehicle_type, profile: v.routing_profile, capacityKg: v.capacity_kg,
      driverId: v.driver_id, driverName: v.driver_name,
    })),
    params: { maxRouteMinutes: maxRouteMinutes || null, maxEvaluations: config.maxEvaluations, maxMs: config.maxSearchMs },
  };
}

const depotKey = d => pointKey('d', d.id, d.lat, d.lon);
const orderKey = o => pointKey('o', o.id, o.lat, o.lon);

/** Chạy nền: lập ma trận, Insertion Heuristic, Local Search rồi lưu bản nháp. */
export async function runPlanning(runId, snapshot) {
  const set = (step, extra = {}) => progress.set(runId, { step, ...extra });
  try {
    set('matrix', { done: 0, total: 0 });
    const t0 = performance.now();
    const points = [
      { key: depotKey(snapshot.depot), lat: snapshot.depot.lat, lon: snapshot.depot.lon },
      ...snapshot.orders.map(o => ({ key: orderKey(o), lat: o.lat, lon: o.lon })),
    ];
    const profiles = [...new Set(snapshot.vehicles.map(v => v.profile))];
    const matrix = await buildMatrix({
      points, profiles,
      onProgress: (done, total) => set('matrix', { done, total }),
    });
    const matrixMs = performance.now() - t0;

    set('optimize');
    const P = {
      depot: depotKey(snapshot.depot),
      travel: matrix.travel,
      orders: snapshot.orders.map(o => ({ id: o.id, code: o.code, point: orderKey(o), weightKg: o.weightKg, vehicleTypes: o.vehicleTypes })),
      vehicles: [...snapshot.vehicles].sort((a, b) => a.id - b.id)
        .map(v => ({ id: v.id, type: v.type, profile: v.profile, capacityKg: v.capacityKg })),
      maxRouteSeconds: snapshot.params.maxRouteMinutes ? snapshot.params.maxRouteMinutes * 60 : null,
    };
    const out = plan(P, { maxEvaluations: snapshot.params.maxEvaluations, maxMs: snapshot.params.maxMs });

    const orderById = new Map(snapshot.orders.map(o => [o.id, o]));
    const routes = [];
    for (const r of out.routes) {
      if (!r.orderIds.length) continue;
      const v = snapshot.vehicles.find(x => x.id === r.vehicleId);
      const seq = [P.depot, ...r.orderIds.map(id => orderKey(orderById.get(id))), P.depot];
      // Thiếu quãng đường của một chặng (ví dụ đợt sự cố giả định không ghi quãng đường) thì để trống, không cộng 0
      let distanceM = 0;
      for (let i = 0; i + 1 < seq.length && distanceM != null; i++) {
        const d = matrix.distance(v.profile, seq[i], seq[i + 1]);
        distanceM = d == null ? null : distanceM + d;
      }
      routes.push({ vehicleId: v.id, driverId: v.driverId, orderIds: r.orderIds, seconds: r.seconds, distanceM, loadKg: r.loadKg, geometry: null });
    }

    if (!routes.length) {
      await query(`UPDATE planning_runs SET status = 'failed', result = $2 WHERE id = $1`, [runId, {
        error: 'Không lập được tuyến hợp lệ nào', unassigned: out.unassigned, matrix: matrix.stats,
      }]);
      progress.delete(runId);
      return;
    }

    // Đường đi để vẽ bản đồ: một lần gọi Calculate Route cho mỗi tuyến, theo đúng thứ tự đã chọn
    set('geometry');
    for (const r of routes) {
      const v = snapshot.vehicles.find(x => x.id === r.vehicleId);
      const pts = [snapshot.depot, ...r.orderIds.map(id => orderById.get(id)), snapshot.depot];
      r.geometry = await routeGeometry(pts, v.profile).catch(() => null);
    }

    const result = {
      routes,
      unassigned: out.unassigned,
      stats: { ...out.stats, matrixMs: Math.round(matrixMs) },
      matrix: { batchIds: matrix.batchIds, ...matrix.stats },
    };
    await transaction(async c => {
      // Chỉ bản nháp mới nhất còn hiệu lực. Khóa để hai lần tính xong cùng lúc không cùng thành bản nháp;
      // lần tính cũ xong sau lần tính mới thì tự thành bản đã thay thế, không thay bản nháp mới hơn
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('planning_runs_draft'))`);
      await c.query(
        `UPDATE planning_runs SET result = $2,
                status = CASE WHEN EXISTS (SELECT 1 FROM planning_runs n WHERE n.id > $1 AND n.status = 'draft')
                              THEN 'superseded' ELSE 'draft' END
          WHERE id = $1`, [runId, result]);
      await c.query(
        `INSERT INTO planning_run_matrices (planning_run_id, matrix_batch_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING`,
        [runId, matrix.batchIds]);
      await c.query(`UPDATE planning_runs SET status = 'superseded' WHERE status = 'draft' AND id < $1`, [runId]);
    });
  } catch (err) {
    console.error('Lập kế hoạch lỗi', err);
    await query(`UPDATE planning_runs SET status = 'failed', result = $2 WHERE id = $1`,
      [runId, { error: 'Lỗi khi tính phương án: ' + (err.message || 'không rõ') }]).catch(() => {});
  } finally {
    progress.delete(runId);
  }
}

/** Lần tính dở dang khi máy chủ khởi động lại thì đánh dấu thất bại. */
export async function failInterruptedRuns() {
  await query(`UPDATE planning_runs SET status = 'failed', result = '{"error":"Máy chủ khởi động lại trong lúc tính"}' WHERE status = 'running'`);
}
