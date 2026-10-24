// Optimization Engine: phân công đơn cho xe và sắp thứ tự giao (mục 3.4 của báo cáo).
// Engine không gọi TomTom và không đọc cơ sở dữ liệu. Backend chuẩn bị dữ liệu rồi gọi các hàm dưới đây,
// nhờ đó có thể kiểm thử thuật toán độc lập với dịch vụ bản đồ.
//
// Quy ước:
// - Mỗi đơn và kho là một "điểm" có khóa (point). Nhiều đơn cùng địa chỉ dùng chung một khóa điểm.
// - travel(profile, a, b) trả về số giây đi từ điểm a đến điểm b theo cấu hình xe, hoặc null khi chặng
//   không có dữ liệu hợp lệ. Chặng thiếu dữ liệu không bao giờ được coi là 0 giây.
// - Tuyến của một xe là mảng chỉ số đơn theo thứ tự giao, xuất phát và kết thúc tại kho.
// - Thời gian phụ thuộc giờ (tùy chọn): travelAt(profile, a, b, giờ) trả về số giây đi chặng a → b khi xe rời a
//   lúc `giờ` (giây kể từ 0:00 giờ địa phương). Khi có travelAt, tuyến được tính tiến theo thời gian: xuất phát lúc
//   startSeconds, mỗi chặng lấy thời gian ứng với giờ xe thực sự rời điểm trước, cộng thời gian phục vụ tại điểm.
//   Không có travelAt thì dùng travel như trước (một ma trận cho cả chuyến).
// - Thời gian phục vụ: mỗi lần dừng ở một điểm mất P.stopSeconds (đỗ xe, tìm cửa; mặc định 0), mỗi đơn thêm
//   serviceSeconds của đơn hoặc P.serviceSeconds (giao, ký nhận; mặc định 0). Nhiều đơn liên tiếp ở cùng một điểm
//   chỉ tính một lần dừng. Thời lượng chuyến gồm thời gian chạy và thời gian phục vụ.
// - Tải: mỗi xe có capacityKg và tùy chọn capacityParcels (số kiện thùng xe chứa được); mỗi đơn có weightKg và
//   parcels (mặc định 1 kiện).
// - Mục tiêu (P.objective):
//     'makespan' (mặc định): các tài xế chạy song song nên trước hết giảm giờ xe cuối cùng về kho (giao xong mọi đơn
//                 sớm nhất), bằng nhau thì giảm tổng thời lượng các chuyến (chạy và phục vụ).
//     'total':    giảm tổng thời lượng các chuyến (mục tiêu ban đầu, giữ để so sánh).
// - Giới hạn thời gian: P.shiftEndSeconds là giờ kết thúc ca (giây kể từ 0:00), mọi xe phải về kho trước giờ đó;
//   P.maxRouteSeconds (cách cũ, vẫn dùng được) giới hạn thời lượng một chuyến.

const now = () => performance.now();

const REASONS = {
  vehicle_type: 'Không có xe phù hợp loại xe',
  capacity: 'Vượt tải của mọi xe phù hợp',
  parcels: 'Vượt số kiện xe chở được',
  no_route: 'Thiếu dữ liệu tuyến từ TomTom',
  duration: 'Vượt giới hạn thời lượng chuyến',
  shift: 'Không kịp trong ca',
};

/** Thời gian một chặng khi rời điểm a lúc `clock`: cùng điểm thì 0, thiếu dữ liệu thì null. */
function leg(P, profile, a, b, clock) {
  if (a === b) return 0;
  const t = P.travelAt ? P.travelAt(profile, a, b, clock) : P.travel(profile, a, b);
  return t == null ? null : t;
}

const serviceOf = (P, o) => P.orders[o].serviceSeconds ?? P.serviceSeconds ?? 0;
const stopOf = P => P.stopSeconds ?? 0;
const parcelsOf = (P, o) => P.orders[o].parcels ?? 1;
const startClock = P => P.startSeconds ?? 0;
const objectiveOf = P => P.objective ?? 'makespan';

/**
 * Tính tiến từ điểm `prev` lúc `clock` qua các đơn route[from..] rồi về kho. Trả về giờ về đến kho, null nếu
 * có chặng không hợp lệ. Mọi hàm đánh giá tuyến cộng theo đúng thứ tự này (chặng, dừng, phục vụ), nhờ đó cùng
 * một tuyến luôn cho cùng một số, kể cả khi chỉ tính lại phần đuôi lúc chèn đơn.
 */
function forward(P, profile, prev, clock, route, from = 0, arrivals = null) {
  const stop = stopOf(P);
  for (let k = from; k < route.length; k++) {
    const u = P.orders[route[k]].point;
    const t = leg(P, profile, prev, u, clock);
    if (t == null) return null;
    clock += t;
    arrivals?.push(clock);
    if (u !== prev) clock += stop;
    clock += serviceOf(P, route[k]);
    prev = u;
  }
  const back = leg(P, profile, prev, P.depot, clock);
  return back == null ? null : clock + back;
}

const fits = (P, v, o) => P.orders[o].vehicleTypes.includes(P.vehicles[v].type);
const loadOf = (P, route) => route.reduce((s, o) => s + P.orders[o].weightKg, 0);
const parcelLoadOf = (P, route) => route.reduce((s, o) => s + parcelsOf(P, o), 0);
const parcelCap = (P, v) => P.vehicles[v].capacityParcels ?? Infinity;

/** Giới hạn thời gian của một chuyến: thời lượng (maxRouteSeconds) và giờ về kho so với giờ hết ca. */
function timeViolation(P, seconds, end) {
  if (P.maxRouteSeconds && seconds > P.maxRouteSeconds) return 'duration';
  if (P.shiftEndSeconds != null && end > P.shiftEndSeconds + 1e-9) return 'shift';
  return null;
}

/**
 * Thời lượng một tuyến (chạy và phục vụ), tính cả chặng rời điểm xuất phát và chặng về kho.
 * Infinity nếu có chặng không hợp lệ. startSeconds là giờ xuất phát, chỉ có tác dụng khi có travelAt.
 */
export function routeSeconds(P, v, route, start = P.depot, startSeconds = startClock(P)) {
  const end = forward(P, P.vehicles[v].profile, start, startSeconds, route);
  return end == null ? Infinity : end - startSeconds;
}

/**
 * Lịch của một tuyến: giờ đến từng đơn (giây kể từ 0:00, là giờ dự kiến đến), giờ về kho, thời lượng,
 * thời gian chạy, thời gian phục vụ (dừng và giao) và số lần dừng. null nếu có chặng không hợp lệ.
 */
export function routeSchedule(P, v, route, { start = P.depot, startSeconds = startClock(P) } = {}) {
  const arrivals = [];
  const end = forward(P, P.vehicles[v].profile, start, startSeconds, route, 0, arrivals);
  if (end == null) return null;
  let stops = 0;
  let service = 0;
  let prev = start;
  for (const o of route) {
    if (P.orders[o].point !== prev) stops++;
    service += serviceOf(P, o);
    prev = P.orders[o].point;
  }
  service += stops * stopOf(P);
  return { arrivals, end, seconds: end - startSeconds, travelSeconds: end - startSeconds - service, serviceSeconds: service, stops };
}

/** Tổng thời lượng các chuyến (chạy và phục vụ). */
export const totalSeconds = (P, routes) => routes.reduce((s, r, v) => s + routeSeconds(P, v, r), 0);

/** Giờ xe cuối cùng về kho (giây kể từ 0:00); không xe nào có đơn thì là giờ xuất phát. */
export function finishSeconds(P, routes) {
  let m = startClock(P);
  routes.forEach((r, v) => { if (r.length) m = Math.max(m, startClock(P) + routeSeconds(P, v, r)); });
  return m;
}

function reasonText(found) {
  // Khi đã có xe đúng loại thì lý do "sai loại xe" không còn ý nghĩa với Dispatcher.
  const keys = [...found].filter(k => k !== 'vehicle_type' || found.size === 1);
  return keys.length ? keys.map(k => REASONS[k]).join('; ') : REASONS.vehicle_type;
}

/**
 * Vị trí chèn có mức tăng thời lượng ΔT thấp nhất của đơn o trên từng xe. Trên một xe, ΔT nhỏ nhất cũng là giờ
 * về kho sớm nhất, nên vị trí này tốt nhất cho cả hai mục tiêu.
 * Ma trận cố định: ΔT = t(i,u) + t(u,j) − t(i,j) + phục vụ(u), cộng thời gian dừng nếu u khác điểm i, trừ một lần
 * dừng nếu j cùng điểm với u (j được giao ngay khi xe đang dừng ở u).
 * Thời gian phụ thuộc giờ: chèn u làm mọi chặng sau đó rời điểm muộn hơn nên công thức trên không còn đúng;
 * ΔT được tính bằng cách giữ giờ rời các điểm phía trước và tính lại phần đuôi từ vị trí chèn.
 * Mỗi phương án trả về { v, p, delta, seconds, end }: xe, vị trí, ΔT, thời lượng mới và giờ về kho mới.
 */
function insertionOptions(P, routes, loads, parcels, costs, o) {
  if (P.travelAt) return insertionOptionsAt(P, routes, loads, parcels, costs, o);
  const options = [];
  const found = new Set();
  const u = P.orders[o].point;
  const st = stopOf(P);
  const t0 = startClock(P);
  let positions = 0;
  for (let v = 0; v < P.vehicles.length; v++) {
    if (!fitsLoad(P, v, o, loads, parcels, found)) continue;
    const profile = P.vehicles[v].profile;
    const r = routes[v];
    let best = null;
    for (let p = 0; p <= r.length; p++) {
      positions++;
      const i = p === 0 ? P.depot : P.orders[r[p - 1]].point;
      const j = p === r.length ? P.depot : P.orders[r[p]].point;
      const a = leg(P, profile, i, u);
      const b = leg(P, profile, u, j);
      const c = leg(P, profile, i, j);
      if (a == null || b == null || c == null) { found.add('no_route'); continue; }
      let delta = a + b - c + serviceOf(P, o);
      if (st) delta += st * ((u !== i) + (j !== P.depot && j !== u) - (j !== P.depot && j !== i));
      const seconds = costs[v] + delta;
      const bad = timeViolation(P, seconds, t0 + seconds);
      if (bad) { found.add(bad); continue; }
      // Bằng nhau thì giữ vị trí đứng trước (số thứ tự vị trí tăng dần)
      if (!best || delta < best.delta) best = { v, p, delta, seconds, end: t0 + seconds };
    }
    if (best) options.push(best);
  }
  return { options, found, positions };
}

/** Loại xe, tải trọng và số kiện; ghi lý do vào found khi không chở được. */
function fitsLoad(P, v, o, loads, parcels, found) {
  if (!fits(P, v, o)) { found.add('vehicle_type'); return false; }
  if (loads[v] + P.orders[o].weightKg > P.vehicles[v].capacityKg) { found.add('capacity'); return false; }
  if (parcels[v] + parcelsOf(P, o) > parcelCap(P, v)) { found.add('parcels'); return false; }
  return true;
}

function insertionOptionsAt(P, routes, loads, parcels, costs, o) {
  const options = [];
  const found = new Set();
  const u = P.orders[o].point;
  const st = stopOf(P);
  const t0 = startClock(P);
  let positions = 0;
  for (let v = 0; v < P.vehicles.length; v++) {
    if (!fitsLoad(P, v, o, loads, parcels, found)) continue;
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
      if (pt !== prev) clock += st;
      clock += serviceOf(P, x);
      depart.push(clock);
      prev = pt;
    }
    let best = null;
    for (let p = 0; p <= r.length; p++) {
      if (p >= depart.length) { found.add('no_route'); break; }
      positions++;
      const i = p === 0 ? P.depot : P.orders[r[p - 1]].point;
      const a = leg(P, profile, i, u, depart[p]);
      if (a == null) { found.add('no_route'); continue; }
      let c = depart[p];
      c += a;
      if (u !== i) c += st;
      c += serviceOf(P, o);
      const end = forward(P, profile, u, c, r, p);
      if (end == null) { found.add('no_route'); continue; }
      const seconds = end - t0;
      const bad = timeViolation(P, seconds, end);
      if (bad) { found.add(bad); continue; }
      const delta = seconds - costs[v];
      // Bằng nhau thì giữ vị trí đứng trước (số thứ tự vị trí tăng dần)
      if (!best || delta < best.delta) best = { v, p, delta, seconds, end };
    }
    if (best) options.push(best);
  }
  return { options, found, positions };
}

/** So sánh từ điển hai khóa [mục tiêu chính, mục tiêu phụ]: âm nếu a tốt hơn b. */
const compareKeys = (a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);

/**
 * Insertion Heuristic (mục 3.4.3, Hình 3.8 nửa trên).
 * Xét đơn theo khối lượng giảm dần, bằng nhau thì theo mã đơn tăng dần. Với mỗi đơn, thử mọi xe phù hợp
 * và mọi vị trí giữa hai điểm liên tiếp, chọn cách chèn hợp lệ tốt nhất theo mục tiêu:
 *  - 'makespan': khóa (giờ xe cuối về kho sau khi chèn, ΔT). Chèn vào xe còn dư thời gian thì giờ xe cuối không đổi,
 *    khi đó chọn ΔT nhỏ nhất; xe chưa có đơn được dùng ngay khi chuyến khứ hồi của nó không làm muộn giờ xe cuối.
 *  - 'total': khóa ΔT (cách cũ).
 * Bằng nhau thì theo thứ tự xe (mã xe tăng dần) rồi vị trí. Đơn không còn vị trí hợp lệ được đưa vào danh sách
 * chưa phân công kèm lý do.
 * Thứ tự xét đơn (rule):
 *  - 'greedy': theo khối lượng giảm dần như trên (hoặc theo queue cho trước). Mặc định của mục tiêu 'total'.
 *  - 'regret2': mỗi bước tính khóa tốt nhất và tốt nhì của từng đơn còn lại (trên các xe khác nhau), chèn trước đơn có
 *    độ tiếc nuối (khóa tốt nhì − khóa tốt nhất) lớn nhất, tức đơn sẽ thiệt nhiều nhất nếu để sau; đơn chỉ còn một xe
 *    chở được có độ tiếc nuối vô cùng. Mặc định của mục tiêu 'makespan': với thứ tự khối lượng giảm dần, các đơn
 *    5–20 kg được xếp trước vào xe máy còn dư thời gian, xe máy đầy tải sớm và các đơn nhẹ còn lại dồn hết sang xe tải
 *    (kịch bản 60 đơn: 7 đơn không kịp trong ca); Regret-2 không gặp hiện tượng này (thí nghiệm mục 4.4).
 * routes là các tuyến có sẵn để chèn thêm (mặc định mọi xe chưa có đơn).
 */
export function insertion(P, { rule = null, queue = null, routes: initial = null } = {}) {
  const t0 = now();
  const objective = objectiveOf(P);
  rule ??= objective === 'makespan' ? 'regret2' : 'greedy';
  const routes = initial ? initial.map(r => r.slice()) : P.vehicles.map(() => []);
  const loads = routes.map(r => loadOf(P, r));
  const parcels = routes.map(r => parcelLoadOf(P, r));
  const costs = routes.map((r, v) => (r.length ? routeSeconds(P, v, r) : 0));
  const ends = costs.map(c => startClock(P) + c);
  const order = queue ?? P.orders.map((_, o) => o)
    .sort((a, b) => P.orders[b].weightKg - P.orders[a].weightKg || P.orders[a].code.localeCompare(P.orders[b].code));
  const unassigned = [];
  let positions = 0;

  // Giờ về kho muộn nhất của các xe khác v (xe chưa có đơn tính bằng giờ xuất phát)
  const otherMax = v => ends.reduce((m, e, w) => (w === v ? m : Math.max(m, e)), startClock(P));
  const keyOf = opt => (objective === 'total' ? [opt.delta, 0] : [Math.max(otherMax(opt.v), opt.end), opt.delta]);
  const bestOf = options => {
    let best = null;
    let second = null;
    for (const opt of options) {
      const k = keyOf(opt);
      if (!best || compareKeys(k, best.key) < 0) { second = best; best = { opt, key: k }; }
      else if (!second || compareKeys(k, second.key) < 0) second = { opt, key: k };
    }
    return { best, second };
  };
  const apply = (o, best) => {
    routes[best.v].splice(best.p, 0, o);
    loads[best.v] += P.orders[o].weightKg;
    parcels[best.v] += parcelsOf(P, o);
    // Lấy đúng thời lượng đã tính cho tuyến mới (phụ thuộc giờ) hoặc cộng dồn ΔT (ma trận cố định)
    costs[best.v] = P.travelAt ? best.seconds : costs[best.v] + best.delta;
    ends[best.v] = startClock(P) + costs[best.v];
  };

  if (rule === 'regret2') {
    const left = order.slice();
    while (left.length) {
      let pick = null;
      for (let k = 0; k < left.length; k++) {
        const { options, found, positions: n } = insertionOptions(P, routes, loads, parcels, costs, left[k]);
        positions += n;
        const { best, second } = bestOf(options);
        if (!best) { pick = { k, best: null, found }; break; }
        const regret = second ? [second.key[0] - best.key[0], second.key[1] - best.key[1]] : [Infinity, Infinity];
        // Tiếc nuối lớn hơn được chọn trước; bằng nhau thì khóa tốt hơn, rồi theo thứ tự trong hàng đợi
        if (!pick || compareKeys(regret, pick.regret) > 0 || (compareKeys(regret, pick.regret) === 0 && compareKeys(best.key, pick.best.key) < 0)) {
          pick = { k, best, regret };
        }
      }
      const [o] = left.splice(pick.k, 1);
      if (!pick.best) unassigned.push({ order: o, reason: reasonText(pick.found) });
      else apply(o, pick.best.opt);
    }
  } else {
    for (const o of order) {
      const { options, found, positions: n } = insertionOptions(P, routes, loads, parcels, costs, o);
      positions += n;
      const { best } = bestOf(options);
      if (!best) { unassigned.push({ order: o, reason: reasonText(found) }); continue; }
      apply(o, best.opt);
    }
  }
  return { routes, unassigned, stats: { ms: now() - t0, evaluations: 0, positions } };
}

/**
 * Local Search theo Best Improvement (mục 3.4.4, Hình 3.8 nửa dưới).
 * Mỗi lượt quét mọi phương án lân cận tạo bằng các phép biến đổi theo thứ tự cố định (mặc định Relocate rồi Swap),
 * nhận phương án hợp lệ tốt nhất trong lượt nếu nó cải thiện mục tiêu quá ngưỡng ε rồi lặp lại:
 *  - 'makespan': (M', T') tốt hơn (M, T) khi M' < M − ε, hoặc M' ≤ M và T' < T − ε (M là giờ xe cuối về kho,
 *    T là tổng thời lượng các chuyến). Mỗi bước M không tăng và M hoặc T giảm thật sự, nên không lặp vòng.
 *  - 'total': nhận khi T giảm hơn ε (cách cũ).
 * ε tính bằng giây, mặc định 1e-6 (chỉ để bỏ sai số làm tròn của phép nội suy). Giới hạn tính toán được kiểm tra
 * trước mỗi lần xét một phương án (NFR09). Local Search không thêm hoặc bớt đơn.
 *  start[v]   điểm xe v đang đứng (chuyến đang giao), mặc định là kho
 *  locked[v]  số đơn đầu tuyến của xe v không được đổi (đã xử lý và điểm kế tiếp)
 *  startTimes[v]  giờ xe v rời start[v] (chỉ dùng khi có travelAt), mặc định P.startSeconds
 *  sameRoute  chỉ đổi thứ tự trong cùng một xe (sau khi xe đã xuất phát)
 *  moves      các phép biến đổi: 'relocate', 'swap' (mặc định) và tùy chọn 'oropt' (chuyển đoạn 2–3 đơn liên tiếp),
 *             '2opt' (đảo ngược một đoạn trong cùng tuyến), dùng cho thí nghiệm so sánh
 * Mỗi phương án được đánh giá bằng cách tính lại cả tuyến, nên khi có travelAt mọi chặng phía sau điểm
 * bị đổi đều được tính lại theo giờ rời điểm mới.
 */
export function localSearch(P, initial, {
  maxEvaluations = 10_000, maxMs = 2_000, epsilon = 1e-6,
  start = null, locked = null, sameRoute = false, startTimes = null, moves = ['relocate', 'swap'],
} = {}) {
  const t0 = now();
  const objective = objectiveOf(P);
  const routes = initial.routes.map(r => r.slice());
  const V = routes.length;
  const startOf = v => start?.[v] ?? P.depot;
  const lockOf = v => locked?.[v] ?? 0;
  const clockOf = v => startTimes?.[v] ?? startClock(P);
  const costs = routes.map((r, v) => routeSeconds(P, v, r, startOf(v), clockOf(v)));
  const ends = routes.map((r, v) => clockOf(v) + costs[v]);
  let evaluations = 0;
  let accepted = 0;
  let stopReason = null;

  const withinLimits = () => {
    if (evaluations >= maxEvaluations) stopReason = 'Đạt giới hạn số phép đánh giá';
    else if (now() - t0 >= maxMs) stopReason = 'Đạt giới hạn thời gian tính';
    return !stopReason;
  };
  // Giá trị một tuyến mới: { c: thời lượng, end: giờ về kho }, null nếu vượt tải, thiếu chặng hoặc vượt giới hạn thời gian.
  // Tuyến đã bỏ một đơn của Relocate được dùng lại cho mọi vị trí chèn nên giữ kết quả theo đúng mảng đó.
  const memo = new WeakMap();
  const value = (v, r) => {
    if (memo.has(r)) return memo.get(r);
    let out = null;
    if (loadOf(P, r) <= P.vehicles[v].capacityKg && parcelLoadOf(P, r) <= parcelCap(P, v)) {
      const end = forward(P, P.vehicles[v].profile, startOf(v), clockOf(v), r);
      if (end != null && !timeViolation(P, end - clockOf(v), end)) out = { c: end - clockOf(v), end };
    }
    memo.set(r, out);
    return out;
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
  // Or-opt: chuyển một đoạn 2–3 đơn liên tiếp (giữ thứ tự) sang vị trí khác của cùng xe hoặc xe khác.
  function* oropt() {
    for (const len of [2, 3]) {
      for (let v1 = 0; v1 < V; v1++) {
        for (let a = lockOf(v1); a + len <= routes[v1].length; a++) {
          const seg = routes[v1].slice(a, a + len);
          const removed = routes[v1].slice(0, a).concat(routes[v1].slice(a + len));
          for (let v2 = 0; v2 < V; v2++) {
            if (v2 !== v1 && (sameRoute || !seg.every(o => fits(P, v2, o)))) continue;
            const base = v2 === v1 ? removed : routes[v2];
            for (let b = lockOf(v2); b <= base.length; b++) {
              if (v2 === v1 && b === a) continue;
              const moved = base.slice(0, b).concat(seg, base.slice(b));
              yield v2 === v1 ? [[v1, moved]] : [[v1, removed], [v2, moved]];
            }
          }
        }
      }
    }
  }
  // 2-opt: đảo ngược đoạn a..b trong cùng một tuyến.
  function* twoOpt() {
    for (let v = 0; v < V; v++) {
      for (let a = lockOf(v); a < routes[v].length; a++) {
        for (let b = a + 2; b < routes[v].length; b++) {
          const r = routes[v].slice(0, a).concat(routes[v].slice(a, b + 1).reverse(), routes[v].slice(b + 1));
          yield [[v, r]];
        }
      }
    }
  }
  const GEN = { relocate, swap, oropt, '2opt': twoOpt };
  const gens = moves.map(m => GEN[m]);

  const sum = xs => xs.reduce((s, x) => s + x, 0);
  let M = Math.max(...ends);
  let T = sum(costs);
  while (true) {
    let best = null;
    scan: for (const neighbours of gens) {
      for (const change of neighbours()) {
        if (!withinLimits()) break scan;
        evaluations++;
        const next = [];
        for (const [v, r] of change) {
          const x = value(v, r);
          if (!x) break;
          next.push([v, r, x]);
        }
        if (next.length < change.length) continue;
        if (objective === 'total') {
          let delta = 0;
          for (const [v, , x] of next) delta += x.c - costs[v];
          // Chỉ nhận phương án tiết kiệm vượt ngưỡng ε và tốt nhất trong lượt
          if (delta < -epsilon && (!best || delta < best.delta)) best = { delta, next };
        } else {
          let M2 = -Infinity;
          let T2 = 0;
          for (let w = 0; w < V; w++) {
            const x = next.find(n => n[0] === w)?.[2];
            M2 = Math.max(M2, x ? x.end : ends[w]);
            T2 += x ? x.c : costs[w];
          }
          const improves = M2 < M - epsilon || (M2 <= M && T2 < T - epsilon);
          if (improves && (!best || M2 < best.M || (M2 === best.M && T2 < best.T))) best = { M: M2, T: T2, next };
        }
      }
    }
    if (!best) break;
    for (const [v, r, x] of best.next) { routes[v] = r; costs[v] = x.c; ends[v] = x.end; }
    M = Math.max(...ends);
    T = sum(costs);
    accepted++;
    if (stopReason) break;
  }
  return {
    routes,
    unassigned: initial.unassigned,
    stats: { ms: now() - t0, evaluations, moves: accepted, stopReason: stopReason ?? 'Không còn phương án cải thiện' },
  };
}

/**
 * Lập kế hoạch đầy đủ (UC04): Insertion Heuristic tạo phương án ban đầu, Local Search cải thiện.
 * Trả về tuyến theo mã xe, đơn chưa phân công kèm lý do và các chỉ số để Dispatcher so sánh.
 * options: các tùy chọn của localSearch, thêm objective (ghi đè P.objective) và insertion ('greedy' | 'regret2';
 * mặc định theo mục tiêu, xem insertion).
 */
export function plan(P, options = {}) {
  const Q = options.objective ? { ...P, objective: options.objective } : P;
  const first = insertion(Q, { rule: options.insertion });
  let improved = localSearch(Q, first, options);
  // Local Search làm tuyến gọn hơn nên đơn chưa xếp có thể vừa: thử chèn lại rồi cải thiện tiếp, tối đa 3 lần
  let evaluations = improved.stats.evaluations;
  let moves = improved.stats.moves;
  let ms = first.stats.ms + improved.stats.ms;
  for (let round = 0; round < 3 && improved.unassigned.length; round++) {
    const again = insertion(Q, { routes: improved.routes, queue: improved.unassigned.map(u => u.order) });
    if (again.unassigned.length === improved.unassigned.length) break;
    improved = localSearch(Q, again, { ...options, maxEvaluations: Math.max(1, (options.maxEvaluations ?? 10_000) - evaluations) });
    evaluations += improved.stats.evaluations;
    moves += improved.stats.moves;
    ms += again.stats.ms + improved.stats.ms;
  }
  return {
    routes: improved.routes.map((r, v) => {
      const s = routeSchedule(Q, v, r);
      return {
        vehicleId: Q.vehicles[v].id,
        orderIds: r.map(o => Q.orders[o].id),
        seconds: routeSeconds(Q, v, r),
        loadKg: Math.round(loadOf(Q, r) * 100) / 100,
        loadParcels: parcelLoadOf(Q, r),
        // Giờ dự kiến đến từng đơn và giờ về kho (giây kể từ 0:00, tính từ P.startSeconds)
        arrivalSeconds: s?.arrivals ?? null,
        returnSeconds: s?.end ?? null,
      };
    }),
    unassigned: improved.unassigned.map(u => ({ orderId: Q.orders[u.order].id, reason: u.reason })),
    stats: {
      objective: objectiveOf(Q),
      insertionSeconds: totalSeconds(Q, first.routes),
      finalSeconds: totalSeconds(Q, improved.routes),
      // Giờ xe cuối cùng về kho (giây kể từ 0:00) và makespan (tính từ giờ xuất phát)
      insertionFinishSeconds: finishSeconds(Q, first.routes),
      finishSeconds: finishSeconds(Q, improved.routes),
      makespanSeconds: finishSeconds(Q, improved.routes) - startClock(Q),
      evaluations,
      moves,
      stopReason: improved.stats.stopReason,
      ms: Math.round(ms * 10) / 10,
    },
  };
}

/** Số cặp điểm đổi thứ tự trước/sau giữa hai thứ tự của cùng một tập (khoảng cách Kendall), đo mức xáo trộn cho tài xế. */
export function flippedPairs(before, after) {
  const pos = new Map(after.map((x, i) => [x, i]));
  let n = 0;
  for (let i = 0; i < before.length; i++) {
    for (let j = i + 1; j < before.length; j++) if (pos.get(before[i]) > pos.get(before[j])) n++;
  }
  return n;
}

/**
 * Đánh giá đổi thứ tự các điểm còn lại của một xe đang giao (UC07, mục 3.4.5–3.4.7).
 * Phần tuyến được tính từ vị trí hiện tại, qua điểm kế tiếp đang khóa, các điểm còn lại rồi về kho.
 * Cả thứ tự hiện hành và thứ tự đề xuất được tính trên cùng một dữ liệu mới. Với một xe, về kho sớm nhất
 * cũng là thời lượng phần còn lại ngắn nhất, nên hai mục tiêu trùng nhau.
 *  stops:   [{ id, point, serviceSeconds? }] các điểm chưa xử lý theo thứ tự hiện hành; phần tử đầu là điểm kế tiếp
 *  start:   khóa điểm vị trí xe
 *  profile: cấu hình định tuyến của xe
 *  travelAt, startSeconds: tùy chọn, thời gian phụ thuộc giờ; startSeconds là giờ hiện tại của xe
 *  serviceSeconds, stopSeconds: thời gian giao mỗi đơn và thời gian mỗi lần dừng (0)
 */
export function evaluateReroute({
  depot, travel, travelAt = null, startSeconds = 0, serviceSeconds = 0, stopSeconds = 0, profile, start, stops,
  minSavingSeconds = 60, minSavingRatio = 0.05, maxEvaluations = 10_000, maxMs = 2_000,
}) {
  const P = {
    depot,
    travel,
    travelAt,
    startSeconds,
    serviceSeconds,
    stopSeconds,
    objective: 'total',
    orders: stops.map(s => ({ id: s.id, code: String(s.id), point: s.point, weightKg: 0, parcels: 0, vehicleTypes: ['any'], serviceSeconds: s.serviceSeconds })),
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
    flippedPairs: flippedPairs(current, result.routes[0]),
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
