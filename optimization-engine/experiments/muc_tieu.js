// Biến thể dùng cho thí nghiệm so sánh mục tiêu (mục 4.4.2): cùng Insertion Heuristic và Local Search với Relocate,
// Swap như engine, chỉ khác hàm chi phí của một tuyến. Không dùng trong hệ thống.
//  - travelCost:  tổng thời gian chạy của tuyến, kể cả chặng về kho (mục tiêu của đề tài)
//  - waitingCost: tổng thời điểm hàng đến tay từng khách, tính từ lúc xe rời kho (tổng thời gian khách chờ)

const legOf = (P, v, a, b) => (a === b ? 0 : P.travel(P.vehicles[v].profile, a, b));

/** Thời điểm đến từng điểm và thời lượng cả tuyến (chạy và phục vụ); null nếu có chặng thiếu dữ liệu. */
export function timeline(P, v, route) {
  const arrivals = [];
  let clock = 0;
  let prev = P.depot;
  for (const o of route) {
    const t = legOf(P, v, prev, P.orders[o].point);
    if (t == null) return null;
    clock += t;
    arrivals.push(clock);
    clock += P.orders[o].serviceSeconds ?? P.serviceSeconds ?? 0;   // thời gian phục vụ, mặc định 0
    prev = P.orders[o].point;
  }
  const back = legOf(P, v, prev, P.depot);
  return back == null ? null : { arrivals, total: clock + back };
}

const feasible = (P, v, route) => route.every(o => P.orders[o].vehicleTypes.includes(P.vehicles[v].type))
  && route.reduce((s, o) => s + P.orders[o].weightKg, 0) <= P.vehicles[v].capacityKg;

export const travelCost = (P, v, route) => {
  const tl = timeline(P, v, route);
  if (!tl || !feasible(P, v, route)) return Infinity;
  return P.maxRouteSeconds && tl.total > P.maxRouteSeconds ? Infinity : tl.total;
};
export const waitingCost = (P, v, route) => {
  const tl = timeline(P, v, route);
  if (!tl || !feasible(P, v, route)) return Infinity;
  if (P.maxRouteSeconds && tl.total > P.maxRouteSeconds) return Infinity;
  return tl.arrivals.reduce((s, a) => s + a, 0);
};

/** Insertion Heuristic rồi Local Search (Relocate, Swap, Best Improvement) với hàm chi phí cho trước. */
export function solve(P, cost, { maxEvaluations = 10_000 } = {}) {
  const V = P.vehicles.length;
  const routes = P.vehicles.map(() => []);
  const unassigned = [];
  const queue = P.orders.map((_, o) => o)
    .sort((a, b) => P.orders[b].weightKg - P.orders[a].weightKg || P.orders[a].code.localeCompare(P.orders[b].code));
  for (const o of queue) {
    let best = null;
    for (let v = 0; v < V; v++) {
      const base = cost(P, v, routes[v]);
      for (let p = 0; p <= routes[v].length; p++) {
        const r = routes[v].slice(0, p).concat([o], routes[v].slice(p));
        const delta = cost(P, v, r) - base;
        if (Number.isFinite(delta) && (!best || delta < best.delta)) best = { v, r, delta };
      }
    }
    if (best) routes[best.v] = best.r; else unassigned.push(o);
  }
  let evaluations = 0;
  const costs = routes.map((r, v) => cost(P, v, r));
  while (evaluations < maxEvaluations) {
    let best = null;
    const consider = changes => {
      evaluations++;
      const before = changes.reduce((s, [v]) => s + costs[v], 0);
      const after = changes.reduce((s, [v, r]) => s + cost(P, v, r), 0);
      if (after < before - 1e-9 && (!best || before - after > best.gain)) best = { gain: before - after, changes };
    };
    for (let v1 = 0; v1 < V && evaluations < maxEvaluations; v1++) {
      for (let a = 0; a < routes[v1].length; a++) {
        const o = routes[v1][a];
        const removed = routes[v1].filter((_, i) => i !== a);
        for (let v2 = 0; v2 < V; v2++) {
          const base = v2 === v1 ? removed : routes[v2];
          for (let b = 0; b <= base.length; b++) {
            if (v2 === v1 && b === a) continue;
            const moved = base.slice(0, b).concat([o], base.slice(b));
            consider(v2 === v1 ? [[v1, moved]] : [[v1, removed], [v2, moved]]);
          }
        }
        for (let v2 = v1; v2 < V; v2++) {
          for (let b = v2 === v1 ? a + 1 : 0; b < routes[v2].length; b++) {
            if (v2 === v1) {
              const r = routes[v1].slice(); [r[a], r[b]] = [r[b], r[a]];
              consider([[v1, r]]);
            } else {
              const r1 = routes[v1].slice(); const r2 = routes[v2].slice();
              [r1[a], r2[b]] = [r2[b], r1[a]];
              consider([[v1, r1], [v2, r2]]);
            }
          }
        }
      }
    }
    if (!best) break;
    for (const [v, r] of best.changes) { routes[v] = r; costs[v] = cost(P, v, r); }
  }
  return { routes, unassigned, evaluations };
}

/** Chỉ số để so sánh: số xe, tổng thời gian chạy, chuyến dài nhất, thời gian khách chờ trung bình và lâu nhất. */
export function metrics(P, routes, unassigned = []) {
  let total = 0, longest = 0, waitSum = 0, waitMax = 0, served = 0, used = 0;
  routes.forEach((r, v) => {
    if (!r.length) return;
    const tl = timeline(P, v, r);
    used++;
    total += tl.total;
    longest = Math.max(longest, tl.total);
    for (const a of tl.arrivals) { waitSum += a; waitMax = Math.max(waitMax, a); served++; }
  });
  return { vehicles: used, total, longest, waitAvg: served ? waitSum / served : 0, waitMax, unassigned: unassigned.length };
}
