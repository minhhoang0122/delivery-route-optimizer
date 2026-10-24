// Optimization Engine: phân công đơn cho xe và sắp thứ tự giao (mục 3.4 của báo cáo).
// Engine không gọi TomTom và không đọc cơ sở dữ liệu. Backend chuẩn bị dữ liệu rồi gọi các hàm dưới đây,
// nhờ đó có thể kiểm thử thuật toán độc lập với dịch vụ bản đồ.
//
// Quy ước:
// - Mỗi đơn và kho là một "điểm" có khóa (point). Hai đơn cùng tọa độ có thể dùng chung một khóa điểm.
// - travel(profile, a, b) trả về số giây đi từ điểm a đến điểm b theo cấu hình xe, hoặc null khi chặng
//   không có dữ liệu hợp lệ. Chặng thiếu dữ liệu không bao giờ được coi là 0 giây.
// - Tuyến của một xe là mảng chỉ số đơn theo thứ tự giao, xuất phát và kết thúc tại kho.
// - Thời gian phụ thuộc giờ (tùy chọn): travelAt(profile, a, b, giờ) trả về số giây đi chặng a → b khi xe rời a
//   lúc `giờ` (giây kể từ 0:00 giờ địa phương). Khi có travelAt, tuyến được tính tiến theo thời gian: xuất phát lúc
//   startSeconds, mỗi chặng lấy thời gian ứng với giờ xe thực sự rời điểm trước, cộng thời gian phục vụ tại điểm.
//   Không có travelAt thì dùng travel như trước (một ma trận cho cả chuyến).
// - Thời gian phục vụ: serviceSeconds của từng đơn, nếu không có thì P.serviceSeconds, mặc định 0. Thời lượng
//   chuyến (và giới hạn maxRouteSeconds) gồm thời gian chạy và thời gian phục vụ.

const now = () => performance.now();

const REASONS = {
  vehicle_type: 'Không có xe phù hợp loại xe',
  capacity: 'Vượt tải của mọi xe phù hợp',
  no_route: 'Thiếu dữ liệu tuyến từ TomTom',
  duration: 'Vượt giới hạn thời lượng chuyến',
};

/** Thời gian một chặng khi rời điểm a lúc `clock`: cùng điểm thì 0, thiếu dữ liệu thì null. */
function leg(P, profile, a, b, clock) {
  if (a === b) return 0;
  const t = P.travelAt ? P.travelAt(profile, a, b, clock) : P.travel(profile, a, b);
  return t == null ? null : t;
}

const serviceOf = (P, o) => P.orders[o].serviceSeconds ?? P.serviceSeconds ?? 0;
const startClock = P => P.startSeconds ?? 0;

/**
 * Tính tiến từ điểm `prev` lúc `clock` qua các đơn route[from..] rồi về kho. Trả về giờ về đến kho, null nếu
 * có chặng không hợp lệ. Mọi hàm đánh giá tuyến cộng theo đúng thứ tự này (chặng rồi phục vụ), nhờ đó cùng
 * một tuyến luôn cho cùng một số, kể cả khi chỉ tính lại phần đuôi lúc chèn đơn.
 */
function forward(P, profile, prev, clock, route, from = 0, arrivals = null) {
  for (let k = from; k < route.length; k++) {
    const u = P.orders[route[k]].point;
    const t = leg(P, profile, prev, u, clock);
    if (t == null) return null;
    clock += t;
    arrivals?.push(clock);
    clock += serviceOf(P, route[k]);
    prev = u;
  }
  const back = leg(P, profile, prev, P.depot, clock);
  return back == null ? null : clock + back;
}

const fits = (P, v, o) => P.orders[o].vehicleTypes.includes(P.vehicles[v].type);
const loadOf = (P, route) => route.reduce((s, o) => s + P.orders[o].weightKg, 0);

/**
 * Thời lượng một tuyến (chạy và phục vụ), tính cả chặng rời điểm xuất phát và chặng về kho.
 * Infinity nếu có chặng không hợp lệ. startSeconds là giờ xuất phát, chỉ có tác dụng khi có travelAt.
 */
export function routeSeconds(P, v, route, start = P.depot, startSeconds = startClock(P)) {
  const end = forward(P, P.vehicles[v].profile, start, startSeconds, route);
  return end == null ? Infinity : end - startSeconds;
}

/**
 * Lịch của một tuyến: giờ đến từng điểm (giây kể từ 0:00, là giờ dự kiến đến), giờ về kho, thời lượng,
 * thời gian chạy và thời gian phục vụ. null nếu có chặng không hợp lệ.
 */
export function routeSchedule(P, v, route, { start = P.depot, startSeconds = startClock(P) } = {}) {
  const arrivals = [];
  const end = forward(P, P.vehicles[v].profile, start, startSeconds, route, 0, arrivals);
  if (end == null) return null;
  const service = route.reduce((s, o) => s + serviceOf(P, o), 0);
  return { arrivals, end, seconds: end - startSeconds, travelSeconds: end - startSeconds - service, serviceSeconds: service };
}

function reasonText(found) {
  // Khi đã có xe đúng loại thì lý do "sai loại xe" không còn ý nghĩa với Dispatcher.
  const keys = [...found].filter(k => k !== 'vehicle_type' || found.size === 1);
  return keys.length ? keys.map(k => REASONS[k]).join('; ') : REASONS.vehicle_type;
}

/**
 * Vị trí chèn có mức tăng thời lượng ΔT thấp nhất của đơn o trên từng xe.
 * Ma trận cố định: ΔT = t(i,u) + t(u,j) − t(i,j) + phục vụ(u).
 * Thời gian phụ thuộc giờ: chèn u làm mọi chặng sau đó rời điểm muộn hơn nên công thức trên không còn đúng;
 * ΔT được tính bằng cách giữ giờ rời các điểm phía trước và tính lại phần đuôi từ vị trí chèn.
 */
function insertionOptions(P, routes, loads, costs, o) {
  if (P.travelAt) return insertionOptionsAt(P, routes, loads, costs, o);
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
      const delta = a + b - c + serviceOf(P, o);
      if (P.maxRouteSeconds && costs[v] + delta > P.maxRouteSeconds) { found.add('duration'); continue; }
      // Bằng nhau thì giữ vị trí đứng trước (số thứ tự vị trí tăng dần)
      if (!best || delta < best.delta) best = { v, p, delta };
    }
    if (best) options.push(best);
  }
  return { options, found };
}

function insertionOptionsAt(P, routes, loads, costs, o) {
  const options = [];
  const found = new Set();
  const u = P.orders[o].point;
  const t0 = startClock(P);
  for (let v = 0; v < P.vehicles.length; v++) {
    if (!fits(P, v, o)) { found.add('vehicle_type'); continue; }
    if (loads[v] + P.orders[o].weightKg > P.vehicles[v].capacityKg) { found.add('capacity'); continue; }
    const profile = P.vehicles[v].profile;
    const r = routes[v];
    // depart[p]: giờ rời điểm thứ p của tuyến hiện tại (p = 0 là kho); không đổi khi chèn đơn vào sau điểm đó
    const depart = [t0];
    let clock = t0;
    let prev = P.depot;
    for (const x of r) {
      const pt = P.orders[x].point;
      const t = leg(P, profile, prev, pt, clock);
      if (t == null) break;
      clock += t;
      clock += serviceOf(P, x);
      depart.push(clock);
      prev = pt;
    }
    let best = null;
    for (let p = 0; p <= r.length; p++) {
      if (p >= depart.length) { found.add('no_route'); break; }
      const i = p === 0 ? P.depot : P.orders[r[p - 1]].point;
      const a = leg(P, profile, i, u, depart[p]);
      if (a == null) { found.add('no_route'); continue; }
      let c = depart[p];
      c += a;
      c += serviceOf(P, o);
      const end = forward(P, profile, u, c, r, p);
      if (end == null) { found.add('no_route'); continue; }
      const seconds = end - t0;
      if (P.maxRouteSeconds && seconds > P.maxRouteSeconds) { found.add('duration'); continue; }
      const delta = seconds - costs[v];
      // Bằng nhau thì giữ vị trí đứng trước (số thứ tự vị trí tăng dần)
      if (!best || delta < best.delta) best = { v, p, delta, seconds };
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
    // Phụ thuộc giờ: lấy đúng thời lượng đã tính cho tuyến mới thay vì cộng dồn ΔT
    costs[best.v] = P.travelAt ? best.seconds : costs[best.v] + best.delta;
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
 *  startTimes[v]  giờ xe v rời start[v] (chỉ dùng khi có travelAt), mặc định P.startSeconds
 *  sameRoute  chỉ đổi thứ tự trong cùng một xe (sau khi xe đã xuất phát)
 * Mỗi phương án được đánh giá bằng routeSeconds trên cả tuyến, nên khi có travelAt mọi chặng phía sau điểm
 * bị đổi đều được tính lại theo giờ rời điểm mới.
 */
export function localSearch(P, initial, {
  maxEvaluations = 10_000, maxMs = 2_000, epsilon = 0,
  start = null, locked = null, sameRoute = false, startTimes = null,
} = {}) {
  const t0 = now();
  const routes = initial.routes.map(r => r.slice());
  const V = routes.length;
  const startOf = v => start?.[v] ?? P.depot;
  const lockOf = v => locked?.[v] ?? 0;
  const clockOf = v => startTimes?.[v] ?? startClock(P);
  const costs = routes.map((r, v) => routeSeconds(P, v, r, startOf(v), clockOf(v)));
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
    const c = routeSeconds(P, v, r, startOf(v), clockOf(v));
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
    routes: improved.routes.map((r, v) => {
      const s = routeSchedule(P, v, r);
      return {
        vehicleId: P.vehicles[v].id,
        orderIds: r.map(o => P.orders[o].id),
        seconds: routeSeconds(P, v, r),
        loadKg: Math.round(loadOf(P, r) * 100) / 100,
        // Giờ dự kiến đến từng đơn và giờ về kho (giây kể từ 0:00, tính từ P.startSeconds)
        arrivalSeconds: s?.arrivals ?? null,
        returnSeconds: s?.end ?? null,
      };
    }),
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
 *  stops:   [{ id, point, serviceSeconds? }] các điểm chưa xử lý theo thứ tự hiện hành; phần tử đầu là điểm kế tiếp
 *  start:   khóa điểm vị trí xe
 *  profile: cấu hình định tuyến của xe
 *  travelAt, startSeconds: tùy chọn, thời gian phụ thuộc giờ; startSeconds là giờ hiện tại của xe
 *  serviceSeconds: thời gian phục vụ mặc định tại mỗi điểm còn lại (0)
 */
export function evaluateReroute({ depot, travel, travelAt = null, startSeconds = 0, serviceSeconds = 0, profile, start, stops, minSavingSeconds = 60, minSavingRatio = 0.05, maxEvaluations = 10_000, maxMs = 2_000 }) {
  const P = {
    depot,
    travel,
    travelAt,
    startSeconds,
    serviceSeconds,
    orders: stops.map(s => ({ id: s.id, code: String(s.id), point: s.point, weightKg: 0, vehicleTypes: ['any'], serviceSeconds: s.serviceSeconds })),
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

// ---------------------------------------------------------------- Thời gian chặng theo giờ từ nhiều khung giờ đã ghi

/** "16:30" → 59.400 (giây kể từ 0:00). */
export function clockSeconds(hhmm) {
  const [h, m = 0, s = 0] = String(hhmm).split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/**
 * Tạo travelAt từ các ma trận đã ghi ở vài khung giờ: slots = [{ seconds, travel(profile, a, b) }].
 * Giữa hai khung giờ liền nhau, thời gian chặng nội suy tuyến tính theo giờ rời điểm; trước khung đầu và sau
 * khung cuối giữ nguyên giá trị của khung gần nhất. Một trong hai khung bao quanh thiếu dữ liệu thì chặng là null.
 *
 * Tính chất FIFO (rời muộn hơn thì không đến sớm hơn): trên đoạn [t1, t2], giờ đến t + τ(t) có độ dốc
 * 1 + (τ2 − τ1)/(t2 − t1), nên FIFO giữ khi τ1 − τ2 ≤ t2 − t1, tức thời gian chặng không giảm nhanh hơn
 * khoảng cách giữa hai khung. Với khung cách 30 phút, chặng phải nhanh lên hơn 30 phút mới vi phạm; dùng
 * fifoCheck để kiểm tra trên dữ liệu thật. Đoạn giữ nguyên ở hai đầu luôn thỏa FIFO.
 */
export function interpolateSlots(slots) {
  const S = slots.slice().sort((x, y) => x.seconds - y.seconds);
  if (!S.length) throw new Error('Cần ít nhất một khung giờ');
  const last = S.length - 1;
  return (profile, a, b, t) => {
    if (a === b) return 0;
    if (t <= S[0].seconds) return S[0].travel(profile, a, b);
    if (t >= S[last].seconds) return S[last].travel(profile, a, b);
    let k = 0;
    while (S[k + 1].seconds <= t) k++;
    const x = S[k].travel(profile, a, b);
    if (t === S[k].seconds) return x;
    const y = S[k + 1].travel(profile, a, b);
    if (x == null || y == null) return null;
    return x + (y - x) * (t - S[k].seconds) / (S[k + 1].seconds - S[k].seconds);
  };
}

/**
 * Kiểm tra FIFO của interpolateSlots trên mọi chặng giữa các điểm cho trước: vi phạm khi một chặng nhanh lên
 * nhiều hơn khoảng cách giữa hai khung giờ liền nhau. margin là phần dư nhỏ nhất (giây) của (t2 − t1) − (τ1 − τ2).
 */
export function fifoCheck(slots, profiles, points) {
  const S = slots.slice().sort((x, y) => x.seconds - y.seconds);
  const violations = [];
  let checked = 0;
  let margin = Infinity;
  for (const profile of profiles) {
    for (const a of points) {
      for (const b of points) {
        if (a === b) continue;
        for (let k = 0; k + 1 < S.length; k++) {
          const x = S[k].travel(profile, a, b);
          const y = S[k + 1].travel(profile, a, b);
          if (x == null || y == null) continue;
          checked++;
          const m = (S[k + 1].seconds - S[k].seconds) - (x - y);
          margin = Math.min(margin, m);
          if (m < 0) violations.push({ profile, a, b, from: S[k].seconds, to: S[k + 1].seconds, before: x, after: y });
        }
      }
    }
  }
  return { checked, violations, margin, ok: violations.length === 0 };
}
