// Công cụ cho thí nghiệm kịch bản 60 đơn (mục 4.4): tìm kiếm mạnh hơn để ước lượng khoảng cách tới lời giải tốt
// (Iterated Local Search có khởi động lại ngẫu nhiên) và mô phỏng thực hiện chuyến theo thời gian để đánh giá đổi tuyến.
// Không dùng trong hệ thống.
import { evaluateReroute, finishSeconds, flippedPairs, insertion, localSearch, routeSeconds, totalSeconds, detectIncrease } from '../src/index.js';

/** Số ngẫu nhiên có hạt giống (LCG) để chạy lại cho cùng kết quả. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Khóa so sánh một kế hoạch: ít đơn chưa xếp hơn, rồi giờ xe cuối về kho, rồi tổng thời lượng. */
export const planKey = (P, sol) => [sol.unassigned.length, finishSeconds(P, sol.routes), totalSeconds(P, sol.routes)];
export const better = (a, b, eps = 1e-6) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] - eps || (a[1] <= b[1] && a[2] < b[2] - eps)));

function routeOk(P, v, r) {
  const veh = P.vehicles[v];
  if (!r.every(o => P.orders[o].vehicleTypes.includes(veh.type))) return false;
  if (r.reduce((s, o) => s + P.orders[o].weightKg, 0) > veh.capacityKg) return false;
  if (r.reduce((s, o) => s + (P.orders[o].parcels ?? 1), 0) > (veh.capacityParcels ?? Infinity)) return false;
  const sec = routeSeconds(P, v, r);
  if (!Number.isFinite(sec) || (P.maxRouteSeconds && sec > P.maxRouteSeconds)) return false;
  return P.shiftEndSeconds == null || (P.startSeconds ?? 0) + sec <= P.shiftEndSeconds + 1e-9;
}

/** Nhiễu: k lần chuyển một đơn ngẫu nhiên sang vị trí ngẫu nhiên (cùng hoặc khác xe), chỉ nhận khi vẫn hợp lệ. */
function perturb(P, routes, k, rand) {
  const R = routes.map(r => r.slice());
  for (let n = 0, tries = 0; n < k && tries < 50 * k; tries++) {
    const used = R.map((r, v) => v).filter(v => R[v].length);
    if (!used.length) break;
    const v1 = used[Math.floor(rand() * used.length)];
    const a = Math.floor(rand() * R[v1].length);
    const o = R[v1][a];
    const v2 = Math.floor(rand() * R.length);
    const rest = R[v1].filter((_, i) => i !== a);
    const base = v1 === v2 ? rest : R[v2];
    const b = Math.floor(rand() * (base.length + 1));
    const moved = base.slice(0, b).concat([o], base.slice(b));
    if (!routeOk(P, v2, moved) || (v1 !== v2 && !routeOk(P, v1, rest))) continue;
    R[v1] = rest;
    R[v2] = moved;
    n++;
  }
  return R;
}

/**
 * Iterated Local Search: Insertion + Local Search, rồi lặp: nhiễu k đơn và Local Search lại, nhận nếu tốt hơn lời giải
 * hiện tại; sau restartAfter lần không cải thiện lời giải tốt nhất thì khởi động lại từ Insertion với thứ tự đơn ngẫu nhiên.
 * Dừng khi tổng số phép đánh giá của các lần Local Search đạt maxEvaluations; trả về số phép đánh giá thực dùng.
 */
export function ils(P, { maxEvaluations = 2_000_000, seed = 1, k = 4, restartAfter = 15, moves = ['relocate', 'swap'] } = {}) {
  const t0 = performance.now();
  const rand = rng(seed);
  let evaluations = 0;
  let iterations = 0;
  let restarts = 0;
  const LS = start => {
    const r = localSearch(P, start, { maxEvaluations: Math.max(1, maxEvaluations - evaluations), maxMs: 1e9, moves });
    evaluations += r.stats.evaluations;
    return r;
  };
  let cur = LS(insertion(P));
  let best = cur;
  let bestAt = evaluations;
  const first = planKey(P, cur);
  let since = 0;
  while (evaluations < maxEvaluations) {
    iterations++;
    let cand;
    if (since >= restartAfter) {
      restarts++;
      const queue = P.orders.map((_, o) => o);
      for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
      cand = LS(insertion(P, { queue, rule: 'greedy' }));
      cur = cand;
      since = 0;
    } else {
      cand = LS({ routes: perturb(P, cur.routes, k, rand), unassigned: cur.unassigned });
      if (better(planKey(P, cand), planKey(P, cur))) cur = cand;
    }
    if (better(planKey(P, cand), planKey(P, best))) { best = cand; bestAt = evaluations; since = 0; } else since++;
  }
  return { best, first, evaluations, bestAt, iterations, restarts, ms: performance.now() - t0 };
}

const distinct = (P, orders) => new Set(orders.map(o => P.orders[o].point)).size;

/**
 * Mô phỏng thực hiện kế hoạch theo thời gian trên giao thông thật (truth, phụ thuộc giờ) và đánh giá đổi tuyến.
 * Mỗi xe đi theo thứ tự hiện hành; sau mỗi lần giao xong một điểm, nếu còn ít nhất 3 điểm chưa giao, hệ thống đánh giá
 * đổi thứ tự phần còn lại bằng dữ liệu có tại thời điểm đó:
 *  - reroute = 'static': ma trận lấy tại giờ hiện tại (như Backend gọi TomTom với giờ khởi hành là lúc đó)
 *  - reroute = 'td':     thời gian phụ thuộc giờ từ giờ hiện tại trở đi
 * Khi đạt ngưỡng max(60 s, 5%), xe chuyển sang thứ tự đề xuất. Tiết kiệm "thực" được tính lại trên giao thông thật.
 * planTravel (tùy chọn) là ma trận dùng khi lập kế hoạch, để thử điều kiện kích hoạt của detectIncrease.
 */
export function simulate(P, truth, routes, { reroute = 'static', planTravel = null } = {}) {
  const H = P.startSeconds;
  const Ptruth = { ...P, travelAt: truth };
  const ptOf = o => P.orders[o].point;
  const events = [];
  const ends = [];
  routes.forEach((r, v) => {
    if (!r.length) return;
    const profile = P.vehicles[v].profile;
    let order = r.slice();
    let clock = H;
    let pos = P.depot;
    for (let k = 0; k < order.length;) {
      // Đi tới điểm kế tiếp và giao mọi đơn liên tiếp ở điểm đó
      const u = ptOf(order[k]);
      clock += pos === u ? 0 : truth(profile, pos, u, clock) + (P.stopSeconds ?? 0);
      pos = u;
      while (k < order.length && ptOf(order[k]) === u) { clock += P.orders[order[k]].serviceSeconds ?? P.serviceSeconds ?? 0; k++; }
      const rest = order.slice(k);
      if (distinct(P, rest) < 3) continue;
      const stops = rest.map(o => ({ id: o, point: ptOf(o) }));
      const data = reroute === 'static' ? { travel: (p, a, b) => truth(p, a, b, clock) } : { travelAt: truth, startSeconds: clock };
      const ev = evaluateReroute({
        depot: P.depot, ...data, serviceSeconds: P.serviceSeconds, stopSeconds: P.stopSeconds, profile, start: pos, stops,
        maxEvaluations: 1e6, maxMs: 1e5,
      });
      const before = routeSeconds(Ptruth, v, rest, pos, clock);
      const after = routeSeconds(Ptruth, v, ev.proposedStopIds, pos, clock);
      const trigger = planTravel
        ? detectIncrease({ points: [...stops.map(s => s.point), P.depot], profile, oldTravel: planTravel, newTravel: (p, a, b) => truth(p, a, b, clock) }).triggered
        : null;
      events.push({
        vehicle: P.vehicles[v].id, clock, remaining: rest.length, points: distinct(P, rest), trigger,
        predictedSaving: ev.savingSeconds, ratio: ev.savingRatio, meets: ev.meetsThreshold, realSaving: before - after, flipped: ev.flippedPairs,
      });
      if (ev.meetsThreshold) order = order.slice(0, k).concat(ev.proposedStopIds);
    }
    ends.push(clock + (pos === P.depot ? 0 : truth(profile, pos, P.depot, clock)));
  });
  return { events, finish: Math.max(H, ...ends) };
}
