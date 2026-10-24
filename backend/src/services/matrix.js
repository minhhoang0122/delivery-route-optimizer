// Lập ma trận thời gian và quãng đường theo cấu hình xe (mục 3.4.2), thời gian phụ thuộc giờ.
// Mỗi đợt lấy dữ liệu là một dòng matrix_batches, kèm giờ xuất phát (depart_at) và khung giờ trong ngày (slot_seconds);
// mỗi chặng có hướng là một dòng matrix_entries. Chặng lỗi hoặc không có tuyến lưu thời gian rỗng, không bao giờ gán 0 giây.
//
// Thời gian một chặng khi xe rời điểm đầu lúc t (giây kể từ 0:00) lấy từ các khung giờ đã có của chặng đó: giữa hai khung
// nội suy tuyến tính, trước khung đầu và sau khung cuối giữ giá trị khung gần nhất (interpolateSlots của Optimization Engine).
// Chặng chỉ có giá trị ước lượng (mock) dùng giá trị đó cho mọi giờ. Đợt "sự cố giả định" của công cụ mô phỏng ghi đè
// mọi khung giờ trong 30 phút.
//  replay: dùng các khung giờ đã ghi (ma trận nạp sẵn lúc 16:00, 16:30, 17:00, 17:30), chỉ lấy thêm chặng chưa có ở khung nào
//  tomtom: lấy theo giao thông tại giờ bắt đầu; khi lập kế hoạch lấy thêm một khung sau đó MATRIX_SECOND_SLOT_MINUTES phút
//          (departAt), dùng lại chặng của khung gần đó lấy trong MATRIX_REUSE_MINUTES phút
//  mock:   ước lượng theo khoảng cách, không đổi theo giờ
import { interpolateSlots } from 'optimization-engine';
import { config } from '../config.js';
import { query } from '../db.js';
import { clockText, isoLocal, secondsOfDay } from './clock.js';
import { batchRoutes, COMMON, hasKey, PROFILES } from './tomtom.js';

/** Khóa điểm gồm loại, mã và tọa độ, để đổi tọa độ thì không dùng nhầm dữ liệu cũ. */
export const pointKey = (prefix, id, lat, lon) => `${prefix}${id}@${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;

/** Khóa điểm giao theo tọa độ: các đơn cùng địa chỉ (cùng tọa độ) dùng chung một điểm và một dòng ma trận. */
export const locationKey = (lat, lon) => pointKey('o', '', lat, lon);

export function haversineM(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Ước lượng khi chạy thử không có khóa TomTom: đường thực dài hơn đường chim bay khoảng 40%
const MOCK_SPEED_KMH = { motorcycle: 25, truck: 20 };
function mockLeg(profile, a, b) {
  const meters = Math.round(haversineM(a, b) * 1.4);
  return { ok: true, seconds: Math.max(30, Math.round(meters / (MOCK_SPEED_KMH[profile] / 3.6))), meters };
}
/** Thời gian ước lượng (giây) khi một chặng hoàn toàn không có dữ liệu, chỉ để hiển thị giờ dự kiến. */
export const estimateSeconds = (profile, a, b) => mockLeg(profile ?? 'motorcycle', a, b).seconds;

const DAY = 86_400;
const timeOfDay = t => ((t % DAY) + DAY) % DAY;

/**
 * Các giá trị đã lưu của từng chặng: theo khung giờ (slots), không theo giờ (fixed, đợt ước lượng) và sự cố giả định
 * (incident, ghi đè). Cùng khung giờ thì giữ giá trị thêm vào trước, nên truy vấn sắp xếp dòng mới nhất lên đầu.
 */
export class LegTable {
  constructor() {
    this.legs = new Map();
    this.slotSet = new Set();
  }

  add(profile, a, b, { slot = null, seconds, meters, status = 'ok', incident = false }) {
    const k = `${profile}|${a}|${b}`;
    let e = this.legs.get(k);
    if (!e) { e = { slots: new Map(), fixed: null, incident: null, fn: null, meters: null }; this.legs.set(k, e); }
    const v = { seconds: status === 'ok' ? seconds : null, meters: status === 'ok' ? meters : null, status };
    if (incident) e.incident ??= v;
    else if (slot == null) e.fixed ??= v;
    else if (!e.slots.has(slot)) { e.slots.set(slot, v); e.fn = null; this.slotSet.add(slot); }
  }

  /** Chặng đã có dữ liệu (kể cả "không có tuyến"), không cần lấy thêm. */
  has(profile, a, b) {
    const e = this.legs.get(`${profile}|${a}|${b}`);
    return Boolean(e && (e.incident || e.fixed || e.slots.size));
  }

  /** Thời gian (field = 'seconds') hoặc quãng đường ('meters') của chặng khi rời điểm a lúc t; null nếu không có. */
  get(profile, a, b, t, field = 'seconds') {
    if (a === b) return 0;
    const e = this.legs.get(`${profile}|${a}|${b}`);
    if (!e) return null;
    if (e.incident) return e.incident[field];
    if (e.slots.size) {
      if (!e.fn) {
        const ok = [...e.slots].filter(([, v]) => v.status === 'ok');
        e.meters = ok.length ? ok[0][1].meters : null;
        e.fn = ok.length ? interpolateSlots(ok.map(([s, v]) => ({ seconds: s, travel: () => v.seconds }))) : () => null;
      }
      return field === 'meters' ? e.meters : e.fn(profile, a, b, timeOfDay(t));
    }
    return e.fixed ? e.fixed[field] : null;
  }

  slotLabels() {
    return [...this.slotSet].sort((x, y) => x - y).map(s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`);
  }
}

async function createBatch(profile, source, departAt) {
  const snapshot = { profile, params: { ...COMMON, ...PROFILES[profile] }, departAt: departAt ? isoLocal(departAt) : null };
  const { rows } = await query(
    `INSERT INTO matrix_batches (profile_snapshot, data_source, status, depart_at, slot_seconds) VALUES ($1, $2, 'running', $3, $4) RETURNING id, started_at`,
    [snapshot, source, departAt, departAt ? Math.floor(secondsOfDay(departAt)) : null]);
  return rows[0];
}

async function saveEntries(batchId, entries) {
  if (!entries.length) return;
  await query(
    `INSERT INTO matrix_entries (batch_id, origin_key, destination_key, travel_seconds, distance_m, status)
     SELECT $1, o, d, t, m, s FROM unnest($2::text[], $3::text[], $4::int[], $5::int[], $6::text[]) AS x(o, d, t, m, s)`,
    [batchId, entries.map(e => e.from), entries.map(e => e.to), entries.map(e => e.seconds),
      entries.map(e => e.meters), entries.map(e => e.status)]);
}

/**
 * Lấy ma trận phụ thuộc giờ cho các điểm và cấu hình xe.
 *  points:        [{ key, lat, lon }]
 *  profiles:      ['motorcycle', 'truck']
 *  pairs:         [[khóa đầu, khóa cuối]] chỉ lấy các chặng có hướng này (mặc định mọi cặp điểm)
 *  departAt:      giờ bắt đầu (mặc định bây giờ); giờ trong quá khứ thì TomTom tính từ bây giờ
 *  slots:         số khung giờ lấy từ TomTom ở nguồn tomtom: 1 (giờ bắt đầu) hoặc 2 (thêm khung sau đó)
 *  maxAgeSeconds: nguồn tomtom chỉ dùng lại chặng lấy trong khoảng này và có giờ xuất phát lệch khung không quá khoảng này
 *  onProgress:    (done, total) khi đang gọi TomTom
 * Trả về travelAt(profile, a, b, giây kể từ 0:00), travel và distance tại giờ bắt đầu, các đợt đã dùng và thống kê.
 */
export async function buildMatrix({ points, profiles, pairs = null, departAt = new Date(), slots = 1, maxAgeSeconds = null, onProgress }) {
  const mode = config.matrixSource;
  const keys = [...new Set(points.map(p => p.key))];
  const byKey = new Map(points.map(p => [p.key, p]));
  const wanted = pairs && new Set(pairs.map(([a, b]) => `${a}|${b}`));
  const needed = (a, b) => a !== b && (!wanted || wanted.has(`${a}|${b}`));
  const table = new LegTable();
  const batchIds = new Set();
  const stats = { reused: 0, fetched: 0, estimated: 0, failed: 0, oldest: null, newest: null };
  const seen = t => {
    if (!stats.oldest || t < stats.oldest) stats.oldest = t;
    if (!stats.newest || t > stats.newest) stats.newest = t;
  };
  const now = new Date();
  const first = new Date(Math.max(now.getTime(), new Date(departAt).getTime()));
  const reuseMs = (maxAgeSeconds ?? config.matrixReuseMinutes * 60) * 1000;
  // Nguồn tomtom: các khung giờ cần lấy (giờ bắt đầu, và thêm một khung khi lập kế hoạch)
  const live = mode === 'tomtom' ? Array.from({ length: Math.max(1, slots) }, (_, i) => new Date(first.getTime() + i * config.secondSlotMinutes * 60_000)) : [];
  const covered = live.map(() => new Set());

  // 1. Dùng lại chặng đã có. Đợt "sự cố giả định" do công cụ mô phỏng tạo (npm run simulate -- incident) được dùng ở mọi
  //    nguồn và luôn được đánh dấu để giao diện ghi rõ.
  const source = mode === 'mock' ? 'mock' : 'tomtom';
  const { rows } = await query(
    `SELECT e.batch_id, e.origin_key, e.destination_key, e.travel_seconds, e.distance_m, e.status, e.fetched_at,
            b.profile_snapshot->>'profile' AS profile, b.profile_snapshot->>'scenario' AS scenario, b.slot_seconds, b.depart_at
       FROM matrix_entries e JOIN matrix_batches b ON b.id = e.batch_id
      WHERE ((b.data_source = $1 AND b.profile_snapshot->>'scenario' IS NULL)
             OR (b.profile_snapshot->>'scenario' = 'incident' AND b.started_at > now() - interval '30 minutes'))
        AND b.profile_snapshot->>'profile' = ANY($2)
        AND e.origin_key = ANY($3) AND e.destination_key = ANY($3)
        AND e.status IN ('ok', 'no_route')
      ORDER BY e.fetched_at DESC`,
    [source, profiles, keys]);
  for (const r of rows) {
    if (!needed(r.origin_key, r.destination_key)) continue;
    const legKey = `${r.profile}|${r.origin_key}|${r.destination_key}`;
    const value = { seconds: r.travel_seconds, meters: r.distance_m, status: r.status };
    if (r.scenario === 'incident') {
      if (table.legs.get(legKey)?.incident) continue;
      table.add(r.profile, r.origin_key, r.destination_key, { ...value, incident: true });
      stats.incident = (stats.incident ?? 0) + 1;
    } else if (mode === 'tomtom') {
      // Dùng lại chặng lấy gần đây cho khung giờ gần với giờ xuất phát của nó
      const k = live.findIndex(T => r.depart_at && Math.abs(new Date(r.depart_at) - T) <= reuseMs);
      if (k < 0 || now - new Date(r.fetched_at) > reuseMs || covered[k].has(legKey)) continue;
      covered[k].add(legKey);
      table.add(r.profile, r.origin_key, r.destination_key, { ...value, slot: r.slot_seconds });
    } else {
      if (table.legs.get(legKey)?.slots.has(r.slot_seconds ?? -1) || (r.slot_seconds == null && table.legs.get(legKey)?.fixed)) continue;
      table.add(r.profile, r.origin_key, r.destination_key, { ...value, slot: r.slot_seconds });
    }
    batchIds.add(r.batch_id);
    seen(r.fetched_at);
    stats.reused++;
  }

  // 2. Các chặng còn thiếu: gọi TomTom nếu có khóa (theo từng khung giờ), nếu không thì ước lượng và ghi rõ nguồn mock
  const useTomTom = mode !== 'mock' && hasKey();
  const rounds = mode === 'tomtom' && useTomTom ? live.map((T, k) => ({ T, k })) : [{ T: useTomTom ? now : null, k: -1 }];
  const total = { legs: 0, done: 0 };
  const plans = [];
  for (const { T, k } of rounds) {
    for (const profile of profiles) {
      const legs = [];
      for (const a of keys) for (const b of keys) {
        if (!needed(a, b)) continue;
        const legKey = `${profile}|${a}|${b}`;
        const missing = k >= 0 ? !covered[k].has(legKey) && !table.legs.get(legKey)?.incident : !table.has(profile, a, b);
        // Không có khóa thì chỉ ước lượng một lần cho chặng chưa có dữ liệu nào
        if (missing && (useTomTom || !table.has(profile, a, b))) legs.push({ profile, from: a, to: b });
      }
      if (legs.length) { plans.push({ T, profile, legs }); total.legs += legs.length; }
    }
  }
  for (const { T, profile, legs } of plans) {
    // departAt chỉ gửi khi khung giờ ở tương lai; khung "bây giờ" để TomTom tính theo giao thông hiện tại
    const future = T && T - now > 60_000;
    const batch = await createBatch(profile, useTomTom ? 'tomtom' : 'mock', useTomTom ? T : null);
    batchIds.add(batch.id);
    const results = useTomTom
      ? await batchRoutes(legs.map(l => ({ from: byKey.get(l.from), to: byKey.get(l.to), profile, departAt: future ? isoLocal(T) : null })), {
        onProgress: done => onProgress?.(total.done + done, total.legs),
      })
      : legs.map(l => mockLeg(profile, byKey.get(l.from), byKey.get(l.to)));
    total.done += legs.length;
    const slot = useTomTom ? Math.floor(secondsOfDay(T)) : null;
    const entries = legs.map((l, i) => {
      const r = results[i];
      const status = r.ok ? 'ok' : r.noRoute ? 'no_route' : 'error';
      if (!r.ok) stats.failed++;
      else if (useTomTom) stats.fetched++;
      else stats.estimated++;
      const e = { from: l.from, to: l.to, seconds: r.ok ? r.seconds : null, meters: r.ok ? r.meters : null, status };
      if (status !== 'error') table.add(profile, l.from, l.to, { ...e, slot });
      return e;
    });
    await saveEntries(batch.id, entries);
    const errors = entries.filter(e => e.status === 'error').length;
    await query(`UPDATE matrix_batches SET completed_at = now(), status = $2 WHERE id = $1`,
      [batch.id, errors === 0 ? 'completed' : errors === entries.length ? 'failed' : 'partial']);
    seen(new Date());
  }

  const t0 = secondsOfDay(first);
  return {
    travelAt: (profile, a, b, t) => table.get(profile, a, b, t),
    travel: (profile, a, b) => table.get(profile, a, b, t0),
    distance: (profile, a, b) => table.get(profile, a, b, t0, 'meters'),
    batchIds: [...batchIds],
    stats: { ...stats, mode, source: sourceOf(mode, stats), usedKey: useTomTom, slots: table.slotLabels(), departAt: clockText(first) },
  };
}

// Nguồn ghi theo dữ liệu thực dùng: chặng ước lượng nhiều bằng hoặc hơn chặng TomTom (lấy mới hoặc dùng lại,
// không kể đợt sự cố giả định) thì ghi là ước lượng; ít hơn thì vẫn là TomTom và giao diện ghi số chặng ước lượng
const sourceOf = (mode, s) => {
  const tomtomLegs = s.fetched + s.reused - (s.incident ?? 0);
  return mode === 'mock' || (s.estimated > 0 && s.estimated >= tomtomLegs) ? 'mock' : 'tomtom';
};

/** Gộp hai ma trận lấy cho hai nhóm chặng khác nhau: chặng nào có dữ liệu ở ma trận a thì dùng a, nếu không thì dùng b. */
export function combineMatrices(a, b) {
  const s = { reused: 0, fetched: 0, estimated: 0, failed: 0 };
  for (const k of Object.keys(s)) s[k] = a.stats[k] + b.stats[k];
  if (a.stats.incident || b.stats.incident) s.incident = (a.stats.incident ?? 0) + (b.stats.incident ?? 0);
  const times = [a.stats.oldest, a.stats.newest, b.stats.oldest, b.stats.newest].filter(Boolean).map(t => new Date(t));
  s.oldest = times.length ? new Date(Math.min(...times)) : null;
  s.newest = times.length ? new Date(Math.max(...times)) : null;
  return {
    travelAt: (p, x, y, t) => a.travelAt(p, x, y, t) ?? b.travelAt(p, x, y, t),
    travel: (p, x, y) => a.travel(p, x, y) ?? b.travel(p, x, y),
    distance: (p, x, y) => a.distance(p, x, y) ?? b.distance(p, x, y),
    batchIds: [...new Set([...a.batchIds, ...b.batchIds])],
    stats: {
      ...s, mode: a.stats.mode, source: sourceOf(a.stats.mode, s), usedKey: a.stats.usedKey || b.stats.usedKey,
      slots: [...new Set([...(a.stats.slots ?? []), ...(b.stats.slots ?? [])])].sort(), departAt: a.stats.departAt,
    },
  };
}

/**
 * Thời gian phụ thuộc giờ đã lưu giữa các điểm (mọi nguồn), chỉ để hiển thị giờ dự kiến và cho công cụ mô phỏng,
 * không gọi TomTom. withIncident = false bỏ qua các đợt "sự cố giả định", để công cụ mô phỏng tạo sự cố từ dữ liệu gốc.
 * Trả về travelAt(profile, a, b, giây kể từ 0:00).
 */
export async function storedTravel(keys, profiles, { withIncident = true } = {}) {
  const table = new LegTable();
  if (keys.length) {
    const { rows } = await query(
      `SELECT e.origin_key, e.destination_key, e.travel_seconds, e.distance_m, e.status, b.slot_seconds,
              b.profile_snapshot->>'profile' AS profile, b.profile_snapshot->>'scenario' AS scenario
         FROM matrix_entries e JOIN matrix_batches b ON b.id = e.batch_id
        WHERE b.profile_snapshot->>'profile' = ANY($1) AND e.status = 'ok'
          AND e.origin_key = ANY($2) AND e.destination_key = ANY($2)
          AND (b.profile_snapshot->>'scenario' IS NULL OR ($3::boolean AND b.started_at > now() - interval '30 minutes'))
        ORDER BY e.fetched_at DESC`, [profiles, keys, withIncident]);
    for (const r of rows) {
      table.add(r.profile, r.origin_key, r.destination_key, {
        seconds: r.travel_seconds, meters: r.distance_m, slot: r.slot_seconds, incident: r.scenario === 'incident',
      });
    }
  }
  return (profile, a, b, t) => table.get(profile, a, b, t);
}

/** Đọc ma trận phụ thuộc giờ của các đợt đã có (để so sánh với đợt mới khi phát hiện tăng thời gian). */
export async function loadBatches(batchIds) {
  const table = new LegTable();
  if (batchIds.length) {
    const { rows } = await query(
      `SELECT e.origin_key, e.destination_key, e.travel_seconds, e.distance_m, e.status, b.slot_seconds,
              b.profile_snapshot->>'profile' AS profile, b.profile_snapshot->>'scenario' AS scenario
         FROM matrix_entries e JOIN matrix_batches b ON b.id = e.batch_id
        WHERE e.batch_id = ANY($1) AND e.status = 'ok' ORDER BY e.fetched_at DESC`, [batchIds]);
    for (const r of rows) {
      table.add(r.profile, r.origin_key, r.destination_key, {
        seconds: r.travel_seconds, meters: r.distance_m, slot: r.slot_seconds, incident: r.scenario === 'incident',
      });
    }
  }
  return (profile, a, b, t) => table.get(profile, a, b, t);
}
