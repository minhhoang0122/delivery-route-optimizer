// Lập ma trận thời gian và quãng đường theo cấu hình xe (mục 3.4.2).
// Mỗi đợt lấy dữ liệu là một dòng matrix_batches; mỗi chặng có hướng là một dòng matrix_entries.
// Chặng lỗi hoặc không có tuyến lưu thời gian rỗng, không bao giờ gán 0 giây.
import { config } from '../config.js';
import { query } from '../db.js';
import { batchRoutes, COMMON, hasKey, PROFILES } from './tomtom.js';

/** Khóa điểm gồm loại, mã và tọa độ, để đổi tọa độ thì không dùng nhầm dữ liệu cũ. */
export const pointKey = (prefix, id, lat, lon) => `${prefix}${id}@${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;

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

async function createBatch(profile, source) {
  const snapshot = { profile, params: { ...COMMON, ...PROFILES[profile] }, departAt: 'now' };
  const { rows } = await query(
    `INSERT INTO matrix_batches (profile_snapshot, data_source, status) VALUES ($1, $2, 'running') RETURNING id, started_at`,
    [snapshot, source]);
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
 * Lấy ma trận cho các điểm và cấu hình xe.
 *  points:        [{ key, lat, lon }]
 *  profiles:      ['motorcycle', 'truck']
 *  maxAgeSeconds: chỉ dùng lại chặng mới hơn mức này (null là dùng lại mọi chặng đã ghi)
 *  pairs:         [[khóa đầu, khóa cuối]] chỉ lấy các chặng có hướng này (mặc định mọi cặp điểm)
 *  onProgress:    (done, total) khi đang gọi TomTom
 */
export async function buildMatrix({ points, profiles, maxAgeSeconds = defaultMaxAge(), pairs = null, onProgress }) {
  const mode = config.matrixSource;
  const keys = [...new Set(points.map(p => p.key))];
  const byKey = new Map(points.map(p => [p.key, p]));
  const known = new Map();
  const id = (profile, a, b) => `${profile}|${a}|${b}`;
  const wanted = pairs && new Set(pairs.map(([a, b]) => `${a}|${b}`));
  const needed = (a, b) => a !== b && (!wanted || wanted.has(`${a}|${b}`));
  const batchIds = new Set();
  const stats = { reused: 0, fetched: 0, estimated: 0, failed: 0, oldest: null, newest: null };
  const seen = t => {
    if (!stats.oldest || t < stats.oldest) stats.oldest = t;
    if (!stats.newest || t > stats.newest) stats.newest = t;
  };

  // 1. Dùng lại chặng đã có (ma trận đã ghi hoặc lần lấy gần đây). Đợt "sự cố giả định" do công cụ mô phỏng
  //    tạo (npm run simulate -- incident) được dùng ở mọi nguồn và luôn được đánh dấu để giao diện ghi rõ.
  const source = mode === 'mock' ? 'mock' : 'tomtom';
  const { rows } = await query(
    `SELECT e.batch_id, e.origin_key, e.destination_key, e.travel_seconds, e.distance_m, e.status, e.fetched_at,
            b.profile_snapshot->>'profile' AS profile, b.profile_snapshot->>'scenario' AS scenario
       FROM matrix_entries e JOIN matrix_batches b ON b.id = e.batch_id
      WHERE (b.data_source = $1 OR (b.profile_snapshot->>'scenario' = 'incident' AND b.started_at > now() - interval '30 minutes'))
        AND b.profile_snapshot->>'profile' = ANY($2)
        AND e.origin_key = ANY($3) AND e.destination_key = ANY($3)
        AND e.status IN ('ok', 'no_route')
        AND ($4::int IS NULL OR e.fetched_at > now() - make_interval(secs => $4))
      ORDER BY e.fetched_at DESC`,
    [source, profiles, keys, maxAgeSeconds]);
  for (const r of rows) {
    const k = id(r.profile, r.origin_key, r.destination_key);
    if (known.has(k) || !needed(r.origin_key, r.destination_key)) continue;
    known.set(k, { seconds: r.travel_seconds, meters: r.distance_m, status: r.status });
    batchIds.add(r.batch_id);
    seen(r.fetched_at);
    stats.reused++;
    if (r.scenario === 'incident') stats.incident = (stats.incident ?? 0) + 1;
  }

  // 2. Các chặng còn thiếu: gọi TomTom nếu có khóa, nếu không thì ước lượng và ghi rõ nguồn mock
  const missing = [];
  for (const profile of profiles) {
    for (const a of keys) for (const b of keys) {
      if (needed(a, b) && !known.has(id(profile, a, b))) missing.push({ profile, from: a, to: b });
    }
  }
  const useTomTom = mode !== 'mock' && hasKey();
  for (const profile of profiles) {
    const legs = missing.filter(m => m.profile === profile);
    if (!legs.length) continue;
    const batch = await createBatch(profile, useTomTom ? 'tomtom' : 'mock');
    batchIds.add(batch.id);
    const results = useTomTom
      ? await batchRoutes(legs.map(l => ({ from: byKey.get(l.from), to: byKey.get(l.to), profile })), {
        onProgress: (done, total) => onProgress?.(stats.fetched + done, missing.length, total),
      })
      : legs.map(l => mockLeg(profile, byKey.get(l.from), byKey.get(l.to)));
    const entries = legs.map((l, i) => {
      const r = results[i];
      const status = r.ok ? 'ok' : r.noRoute ? 'no_route' : 'error';
      if (!r.ok) stats.failed++;
      else if (useTomTom) stats.fetched++;
      else stats.estimated++;
      const e = { from: l.from, to: l.to, seconds: r.ok ? r.seconds : null, meters: r.ok ? r.meters : null, status };
      known.set(id(profile, l.from, l.to), e);
      return e;
    });
    await saveEntries(batch.id, entries);
    const errors = entries.filter(e => e.status === 'error').length;
    await query(`UPDATE matrix_batches SET completed_at = now(), status = $2 WHERE id = $1`,
      [batch.id, errors === 0 ? 'completed' : errors === entries.length ? 'failed' : 'partial']);
    seen(new Date());
  }

  const lookup = (profile, a, b, field) => {
    if (a === b) return 0;
    const e = known.get(id(profile, a, b));
    return e && e.status === 'ok' ? e[field] : null;
  };
  return {
    travel: (profile, a, b) => lookup(profile, a, b, 'seconds'),
    distance: (profile, a, b) => lookup(profile, a, b, 'meters'),
    batchIds: [...batchIds],
    stats: { ...stats, mode, source: sourceOf(mode, stats), usedKey: useTomTom },
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
  const pick = field => (profile, x, y) => a[field](profile, x, y) ?? b[field](profile, x, y);
  const s = { reused: 0, fetched: 0, estimated: 0, failed: 0 };
  for (const k of Object.keys(s)) s[k] = a.stats[k] + b.stats[k];
  if (a.stats.incident || b.stats.incident) s.incident = (a.stats.incident ?? 0) + (b.stats.incident ?? 0);
  const times = [a.stats.oldest, a.stats.newest, b.stats.oldest, b.stats.newest].filter(Boolean).map(t => new Date(t));
  s.oldest = times.length ? new Date(Math.min(...times)) : null;
  s.newest = times.length ? new Date(Math.max(...times)) : null;
  return {
    travel: pick('travel'),
    distance: pick('distance'),
    batchIds: [...new Set([...a.batchIds, ...b.batchIds])],
    stats: { ...s, mode: a.stats.mode, source: sourceOf(a.stats.mode, s), usedKey: a.stats.usedKey || b.stats.usedKey },
  };
}

function defaultMaxAge() {
  if (config.matrixSource === 'tomtom') return config.matrixReuseMinutes * 60;
  return null;
}

/**
 * Thời gian đã lưu gần nhất giữa các điểm (mọi nguồn), chỉ dùng để hiển thị giờ dự kiến, không gọi TomTom.
 * withIncident = false bỏ qua các đợt "sự cố giả định", để công cụ mô phỏng tạo sự cố từ dữ liệu gốc.
 */
export async function cachedTravel(keys, profile, { withIncident = true } = {}) {
  const known = new Map();
  if (keys.length) {
    const { rows } = await query(
      `SELECT DISTINCT ON (e.origin_key, e.destination_key) e.origin_key, e.destination_key, e.travel_seconds
         FROM matrix_entries e JOIN matrix_batches b ON b.id = e.batch_id
        WHERE b.profile_snapshot->>'profile' = $1 AND e.status = 'ok'
          AND e.origin_key = ANY($2) AND e.destination_key = ANY($2)
          AND ($3::boolean OR b.profile_snapshot->>'scenario' IS DISTINCT FROM 'incident')
        ORDER BY e.origin_key, e.destination_key, e.fetched_at DESC`, [profile, keys, withIncident]);
    for (const r of rows) known.set(`${r.origin_key}|${r.destination_key}`, r.travel_seconds);
  }
  return (a, b) => (a === b ? 0 : known.get(`${a}|${b}`) ?? null);
}

/** Đọc ma trận của các đợt đã có (để so sánh với đợt mới khi phát hiện tăng thời gian). */
export async function loadBatches(batchIds) {
  const known = new Map();
  if (!batchIds.length) return (_p, a, b) => (a === b ? 0 : null);
  const { rows } = await query(
    `SELECT e.origin_key, e.destination_key, e.travel_seconds, e.status, b.profile_snapshot->>'profile' AS profile
       FROM matrix_entries e JOIN matrix_batches b ON b.id = e.batch_id
      WHERE e.batch_id = ANY($1) ORDER BY e.fetched_at DESC`, [batchIds]);
  for (const r of rows) {
    const k = `${r.profile}|${r.origin_key}|${r.destination_key}`;
    if (!known.has(k) && r.status === 'ok') known.set(k, r.travel_seconds);
  }
  return (profile, a, b) => (a === b ? 0 : known.get(`${profile}|${a}|${b}`) ?? null);
}
