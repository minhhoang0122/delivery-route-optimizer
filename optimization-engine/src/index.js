// Optimization Engine: phân công đơn cho xe và sắp thứ tự giao (mục 3.4 của báo cáo).
// Engine không gọi TomTom và không đọc cơ sở dữ liệu. Backend chuẩn bị dữ liệu rồi gọi các hàm dưới đây,
// nhờ đó có thể kiểm thử thuật toán độc lập với dịch vụ bản đồ.
//
// Quy ước:
// - Mỗi đơn và kho là một "điểm" có khóa (point). Hai đơn cùng tọa độ có thể dùng chung một khóa điểm.
// - travel(profile, a, b) trả về số giây đi từ điểm a đến điểm b theo cấu hình xe, hoặc null khi chặng
//   không có dữ liệu hợp lệ. Chặng thiếu dữ liệu không bao giờ được coi là 0 giây.
// - Tuyến của một xe là mảng chỉ số đơn theo thứ tự giao, xuất phát và kết thúc tại kho.

const now = () => performance.now();

const REASONS = {
  vehicle_type: 'Không có xe phù hợp loại xe',
  capacity: 'Vượt tải của mọi xe phù hợp',
  no_route: 'Thiếu dữ liệu tuyến từ TomTom',
  duration: 'Vượt giới hạn thời lượng chuyến',
};

/** Thời gian một chặng: cùng điểm thì 0, thiếu dữ liệu thì null. */
function leg(P, profile, a, b) {
  if (a === b) return 0;
  const t = P.travel(profile, a, b);
  return t == null ? null : t;
}

const fits = (P, v, o) => P.orders[o].vehicleTypes.includes(P.vehicles[v].type);
const loadOf = (P, route) => route.reduce((s, o) => s + P.orders[o].weightKg, 0);

/** Thời gian một tuyến, tính cả chặng rời điểm xuất phát và chặng về kho. Infinity nếu có chặng không hợp lệ. */
export function routeSeconds(P, v, route, start = P.depot) {
  const profile = P.vehicles[v].profile;
  let total = 0;
  let prev = start;
  for (const o of route) {
    const t = leg(P, profile, prev, P.orders[o].point);
    if (t == null) return Infinity;
    total += t;
    prev = P.orders[o].point;
  }
  const back = leg(P, profile, prev, P.depot);
  return back == null ? Infinity : total + back;
}

function reasonText(found) {
  // Khi đã có xe đúng loại thì lý do "sai loại xe" không còn ý nghĩa với Dispatcher.
  const keys = [...found].filter(k => k !== 'vehicle_type' || found.size === 1);
  return keys.length ? keys.map(k => REASONS[k]).join('; ') : REASONS.vehicle_type;
}

/** Vị trí chèn có mức tăng ΔT = t(i,u) + t(u,j) − t(i,j) thấp nhất của đơn o trên từng xe. */
function insertionOptions(P, routes, loads, costs, o) {
  const options = [];
  const found = new Set();
  const u = P.orders[o].point;
  for (let v = 0; v < P.vehicles.length; v++) {
    if (!fits(P, v, o)) { found.add('vehicle_type'); continue; }
    if (loads[v] + P.orders[o].weightKg > P.vehicles[v].capacityKg) { found.add('capacity'); continue; }
    const profile = P.vehicles[v].profile;
    const r = routes[v];
    let best = null;
    for (let p = 0; p <= r.length; p++) {
      const i = p === 0 ? P.depot : P.orders[r[p - 1]].point;
      const j = p === r.length ? P.depot : P.orders[r[p]].point;
      const a = leg(P, profile, i, u);
      const b = leg(P, profile, u, j);
      const c = leg(P, profile, i, j);
      if (a == null || b == null || c == null) { found.add('no_route'); continue; }
      const delta = a + b - c;
      if (P.maxRouteSeconds && costs[v] + delta > P.maxRouteSeconds) { found.add('duration'); continue; }
      // Bằng nhau thì giữ vị trí đứng trước (số thứ tự vị trí tăng dần)
      if (!best || delta < best.delta) best = { v, p, delta };
    }
    if (best) options.push(best);
  }
  return { options, found };
}

/**
 * Insertion Heuristic (mục 3.4.3, Hình 3.8 nửa trên).
 * Xét đơn theo khối lượng giảm dần, bằng nhau thì theo mã đơn tăng dần. Với mỗi đơn, thử mọi xe phù hợp
 * và mọi vị trí giữa hai điểm liên tiếp, chọn cách chèn hợp lệ có ΔT nhỏ nhất; bằng nhau thì theo thứ tự xe
 * (mã xe tăng dần) rồi vị trí. Đơn không còn vị trí hợp lệ được đưa vào danh sách chưa phân công kèm lý do.
 */
export function insertion(P) {
  const t0 = now();
  const routes = P.vehicles.map(() => []);
  const loads = routes.map(() => 0);
  const costs = routes.map(() => 0);
  const queue = P.orders.map((_, o) => o)
    .sort((a, b) => P.orders[b].weightKg - P.orders[a].weightKg || P.orders[a].code.localeCompare(P.orders[b].code));
  const unassigned = [];
  for (const o of queue) {
    const { options, found } = insertionOptions(P, routes, loads, costs, o);
    let best = null;
    for (const opt of options) if (!best || opt.delta < best.delta) best = opt;
    if (!best) { unassigned.push({ order: o, reason: reasonText(found) }); continue; }
    routes[best.v].splice(best.p, 0, o);
    loads[best.v] += P.orders[o].weightKg;
    costs[best.v] += best.delta;
  }
  return { routes, unassigned, stats: { ms: now() - t0, evaluations: 0 } };
}

/**
 * Local Search theo Best Improvement (mục 3.4.4, Hình 3.8 nửa dưới).
 * Mỗi lượt quét mọi phương án lân cận tạo bằng Relocate và Swap theo thứ tự cố định, nhận phương án hợp lệ
 * giảm tổng thời gian nhiều nhất (tiết kiệm phải lớn hơn ε) rồi lặp lại. Giới hạn tính toán được kiểm tra
 * trước mỗi lần xét một phương án (NFR09). Local Search không thêm hoặc bớt đơn.
 *  start[v]   điểm xe v đang đứng (chuyến đang giao), mặc định là kho
 *  locked[v]  số đơn đầu tuyến của xe v không được đổi (đã xử lý và điểm kế tiếp)
 *  sameRoute  chỉ đổi thứ tự trong cùng một xe (sau khi xe đã xuất phát)
 */
export function localSearch(P, initial, {
  maxEvaluations = 10_000, maxMs = 2_000, epsilon = 0,
  start = null, locked = null, sameRoute = false,
} = {}) {
  const t0 = now();
  const routes = initial.routes.map(r => r.slice());
  const V = routes.length;
  const startOf = v => start?.[v] ?? P.depot;
  const lockOf = v => locked?.[v] ?? 0;
  const costs = routes.map((r, v) => routeSeconds(P, v, r, startOf(v)));
  let evaluations = 0;
  let moves = 0;
  let stopReason = null;

  const withinLimits = () => {
    if (evaluations >= maxEvaluations) stopReason = 'Đạt giới hạn số phép đánh giá';
    else if (now() - t0 >= maxMs) stopReason = 'Đạt giới hạn thời gian tính';
    return !stopReason;
  };
  const value = (v, r) => {
    if (loadOf(P, r) > P.vehicles[v].capacityKg) return Infinity;
    const c = routeSeconds(P, v, r, startOf(v));
    return P.maxRouteSeconds && c > P.maxRouteSeconds ? Infinity : c;
  };

  // Relocate: lấy một đơn khỏi vị trí a của xe v1, chèn vào vị trí b của xe v2 (có thể cùng xe).
  function* relocate() {
    for (let v1 = 0; v1 < V; v1++) {
      for (let a = lockOf(v1); a < routes[v1].length; a++) {
        const o = routes[v1][a];
        const removed = routes[v1].slice(0, a).concat(routes[v1].slice(a + 1));
        for (let v2 = 0; v2 < V; v2++) {
          if (v2 !== v1 && (sameRoute || !fits(P, v2, o))) continue;
          const base = v2 === v1 ? removed : routes[v2];
          for (let b = lockOf(v2); b <= base.length; b++) {
            if (v2 === v1 && b === a) continue;
            const moved = base.slice(0, b).concat([o], base.slice(b));
            yield v2 === v1 ? [[v1, moved]] : [[v1, removed], [v2, moved]];
          }
        }
      }
    }
  }
  // Swap: đổi chỗ hai đơn, trên cùng xe hoặc giữa hai xe phù hợp loại hàng.
  function* swap() {
    for (let v1 = 0; v1 < V; v1++) {
      for (let a = lockOf(v1); a < routes[v1].length; a++) {
        for (let v2 = v1; v2 < V && (!sameRoute || v2 === v1); v2++) {
          for (let b = v2 === v1 ? a + 1 : lockOf(v2); b < routes[v2].length; b++) {
            const o1 = routes[v1][a];
            const o2 = routes[v2][b];
            if (v1 === v2) {
              const r = routes[v1].slice();
              r[a] = o2; r[b] = o1;
              yield [[v1, r]];
            } else if (fits(P, v1, o2) && fits(P, v2, o1)) {
              const r1 = routes[v1].slice(); r1[a] = o2;
              const r2 = routes[v2].slice(); r2[b] = o1;
              yield [[v1, r1], [v2, r2]];
            }
          }
        }
      }
    }
  }

  while (true) {
    let best = null;
    scan: for (const neighbours of [relocate, swap]) {
      for (const change of neighbours()) {
        if (!withinLimits()) break scan;
        evaluations++;
        let delta = 0;
        const next = [];
        for (const [v, r] of change) {
          const c = value(v, r);
          if (c === Infinity) { delta = Infinity; break; }
          delta += c - costs[v];
          next.push([v, r, c]);
        }
        // Chỉ nhận phương án tiết kiệm vượt ngưỡng ε và tốt nhất trong lượt
        if (delta < -epsilon && (!best || delta < best.delta)) best = { delta, next };
      }
    }
    if (!best) break;
    for (const [v, r, c] of best.next) { routes[v] = r; costs[v] = c; }
    moves++;
    if (stopReason) break;
  }
  return {
    routes,
    unassigned: initial.unassigned,
    stats: { ms: now() - t0, evaluations, moves, stopReason: stopReason ?? 'Không còn phương án cải thiện' },
  };
}

export const totalSeconds = (P, routes) => routes.reduce((s, r, v) => s + routeSeconds(P, v, r), 0);

/**
 * Lập kế hoạch đầy đủ (UC04): Insertion Heuristic tạo phương án ban đầu, Local Search cải thiện.
 * Trả về tuyến theo mã xe, đơn chưa phân công kèm lý do và các chỉ số để Dispatcher so sánh.
 */
export function plan(P, options = {}) {
  const first = insertion(P);
  const insertionTotal = totalSeconds(P, first.routes);
  const improved = localSearch(P, first, options);
  const finalTotal = totalSeconds(P, improved.routes);
  return {
    routes: improved.routes.map((r, v) => ({
      vehicleId: P.vehicles[v].id,
      orderIds: r.map(o => P.orders[o].id),
      seconds: routeSeconds(P, v, r),
      loadKg: Math.round(loadOf(P, r) * 100) / 100,
    })),
    unassigned: improved.unassigned.map(u => ({ orderId: P.orders[u.order].id, reason: u.reason })),
    stats: {
      insertionSeconds: insertionTotal,
      finalSeconds: finalTotal,
      evaluations: improved.stats.evaluations,
      moves: improved.stats.moves,
      stopReason: improved.stats.stopReason,
      ms: Math.round((first.stats.ms + improved.stats.ms) * 10) / 10,
    },
  };
}

/**
 * Đánh giá đổi thứ tự các điểm còn lại của một xe đang giao (UC07, mục 3.4.5–3.4.7).
 * Phần tuyến được tính từ vị trí hiện tại, qua điểm kế tiếp đang khóa, các điểm còn lại rồi về kho.
 * Cả thứ tự hiện hành và thứ tự đề xuất được tính trên cùng một ma trận mới.
 *  stops:   [{ id, point }] các điểm chưa xử lý theo thứ tự hiện hành; phần tử đầu là điểm kế tiếp
 *  start:   khóa điểm vị trí xe
 *  profile: cấu hình định tuyến của xe
 */
export function evaluateReroute({ depot, travel, profile, start, stops, minSavingSeconds = 60, minSavingRatio = 0.05, maxEvaluations = 10_000, maxMs = 2_000 }) {
  const P = {
    depot,
    travel,
    orders: stops.map(s => ({ id: s.id, code: String(s.id), point: s.point, weightKg: 0, vehicleTypes: ['any'] })),
    vehicles: [{ id: 0, type: 'any', profile, capacityKg: Infinity }],
  };
  const current = stops.map((_, i) => i);
  const T = routeSeconds(P, 0, current, start);
  if (!Number.isFinite(T)) {
    return { valid: false, reason: 'Tuyến hiện hành có chặng không có dữ liệu hợp lệ' };
  }
  const result = localSearch(P, { routes: [current], unassigned: [] }, {
    start: [start], locked: [Math.min(1, stops.length)], sameRoute: true, maxEvaluations, maxMs,
  });
  const T2 = routeSeconds(P, 0, result.routes[0], start);
  const G = T - T2;
  return {
    valid: true,
    currentSeconds: T,
    proposedSeconds: T2,
    savingSeconds: G,
    savingRatio: T > 0 ? G / T : 0,
    // Điều kiện áp dụng ban đầu: G ≥ max(60 giây, 5% × T) (mục 3.4.6)
    meetsThreshold: G > 0 && G >= Math.max(minSavingSeconds, minSavingRatio * T),
    proposedStopIds: result.routes[0].map(i => stops[i].id),
    evaluations: result.stats.evaluations,
  };
}

/**
 * Phát hiện tăng thời gian giữa hai đợt dữ liệu (mục 3.4.5): chỉ so các chặng có cùng điểm đầu và điểm cuối,
 * bỏ chặng xuất phát từ vị trí xe. Kích hoạt khi tăng tương đối ≥ 10% hoặc tăng tuyệt đối ≥ 120 giây.
 * slowLegs liệt kê các chặng chậm hẳn (gấp 1,5 lần và thêm ít nhất 60 giây) để vẽ đoạn ùn tắc trên bản đồ.
 */
export function detectIncrease({ points, profile, oldTravel, newTravel, relative = 0.10, absolute = 120 }) {
  let before = 0;
  let after = 0;
  let legs = 0;
  const slowLegs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = oldTravel(profile, points[i], points[i + 1]);
    const b = newTravel(profile, points[i], points[i + 1]);
    if (a == null || b == null) continue;
    before += a; after += b; legs++;
    if (b - a >= 60 && b >= a * 1.5) slowLegs.push({ index: i, before: a, after: b });
  }
  const increase = after - before;
  return {
    legs, before, after, increase, slowLegs,
    triggered: legs > 0 && (increase >= absolute || (before > 0 && increase / before >= relative)),
  };
}
