// Routing Data Service: gọi TomTom (Calculate Route, Batch Routing, Geocoding, ô bản đồ).
// Kế thừa từ bản thử nghiệm test_demo/lib/tomtom.mjs. Khóa chỉ đọc từ cấu hình, không bao giờ trả về trình duyệt.
import { config } from '../config.js';

const BASE = 'https://api.tomtom.com';

// Tham số chung theo mục 3.4.2: không cho TomTom tự sắp xếp lại điểm dừng
export const COMMON = { routeType: 'fastest', traffic: 'true', computeBestOrder: 'false' };

// Cấu hình định tuyến theo loại xe. Thông số xe tải nhỏ là giả định (tổng trọng lượng 2,5 t);
// tải trọng hàng trên xe là dữ liệu khác và không gửi cho TomTom.
export const PROFILES = {
  motorcycle: { travelMode: 'motorcycle' },
  truck: { travelMode: 'truck', vehicleWeight: '2500', vehicleLength: '4.5', vehicleWidth: '1.7', vehicleHeight: '2', vehicleCommercial: 'true' },
};

export const hasKey = () => Boolean(config.tomtomKey);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** "vĩ độ,kinh độ:vĩ độ,kinh độ" theo đúng thứ tự TomTom yêu cầu (GeoJSON thì ngược lại). */
const pointList = pts => pts.map(p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(':');

export const routeQuery = (pts, profile, extra = {}) =>
  `/calculateRoute/${pointList(pts)}/json?${new URLSearchParams({ ...COMMON, ...PROFILES[profile], ...extra })}`;

function errorText(data) {
  if (!data) return '';
  if (data.detailedError) return `${data.detailedError.code ?? ''} ${data.detailedError.message ?? ''}`.trim();
  if (data.error) return data.error.description ?? JSON.stringify(data.error);
  if (data.errorText) return data.errorText;
  if (data.networkError) return `lỗi mạng: ${data.networkError}`;
  return data.text ?? '';
}

/** Lỗi tạm thời thì thử lại; 400 là không có tuyến hoặc tham số sai nên không thử lại (mục 2.4.3). */
const retryable = status => [0, 408, 429, 500, 502, 503, 504].includes(status);

async function send(path, { method = 'GET', body, binary = false } = {}) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(config.tomtomKey)}`;
  let status = 0;
  let data;
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(70_000),
    });
    status = res.status;
    if (binary && res.ok) data = Buffer.from(await res.arrayBuffer());
    else {
      const t = await res.text();
      try { data = JSON.parse(t); } catch { data = { text: t.slice(0, 300) }; }
    }
  } catch (e) {
    data = { networkError: e.cause?.code ?? e.name ?? 'không rõ' };
  }
  return { status, data };
}

/**
 * Batch Routing đồng bộ, chia nhóm tối đa 100 mục. Mục lỗi tạm thời được gửi lại tối đa 2 lần.
 * queries: [{ from: {lat, lon}, to: {lat, lon}, profile, departAt? }] — departAt (giờ địa phương có độ lệch, ví dụ
 * 2026-10-26T17:00:00+07:00) để lấy thời gian theo giao thông dự báo lúc đó; bỏ trống là xuất phát ngay
 * Trả về cùng thứ tự: { ok: true, seconds, meters } | { ok: false, noRoute, error }
 */
export async function batchRoutes(queries, { onProgress } = {}) {
  const out = new Array(queries.length);
  let done = 0;
  for (let s = 0; s < queries.length; s += 100) {
    let pending = [];
    for (let i = s; i < Math.min(s + 100, queries.length); i++) pending.push(i);
    for (let attempt = 0; attempt <= 2 && pending.length; attempt++) {
      if (attempt) await sleep(1500 * attempt);
      const { status, data } = await send('/routing/1/batch/sync/json', {
        method: 'POST',
        body: {
          batchItems: pending.map(i => ({
            query: routeQuery([queries[i].from, queries[i].to], queries[i].profile, queries[i].departAt ? { departAt: queries[i].departAt } : {}),
          })),
        },
      });
      if (status !== 200) {
        for (const i of pending) out[i] = { ok: false, noRoute: false, error: `HTTP ${status} ${errorText(data)}`.trim() };
        if (!retryable(status)) pending = [];
        continue;
      }
      // Trả 200 nhưng nội dung không đúng dạng (ví dụ bị cắt giữa chừng) thì coi là lỗi tạm thời và gửi lại
      if (!Array.isArray(data?.batchItems) || data.batchItems.length !== pending.length) {
        for (const i of pending) out[i] = { ok: false, noRoute: false, error: `Phản hồi Batch Routing không hợp lệ ${errorText(data)}`.trim() };
        continue;
      }
      const again = [];
      data.batchItems.forEach((item, k) => {
        const i = pending[k];
        if (item.statusCode === 200) {
          const sum = item.response.routes[0].summary;
          out[i] = { ok: true, seconds: sum.travelTimeInSeconds, meters: sum.lengthInMeters };
        } else {
          out[i] = { ok: false, noRoute: item.statusCode === 400, error: errorText(item.response) };
          if (retryable(item.statusCode)) again.push(i);
        }
      });
      pending = again;
    }
    done = Math.min(s + 100, queries.length);
    onProgress?.(done, queries.length);
  }
  return out;
}

/** Đường đi qua các điểm theo đúng thứ tự đã chọn, trả về GeoJSON LineString (kinh độ, vĩ độ). */
export async function routeGeometry(points, profile) {
  // Hai điểm liền nhau trùng chỗ (xe đang đứng tại điểm kế tiếp) làm TomTom từ chối cả yêu cầu, nên bỏ điểm trùng
  points = points.filter((p, i) => i === 0 || Math.abs(p.lat - points[i - 1].lat) + Math.abs(p.lon - points[i - 1].lon) > 1e-4);
  if (!hasKey() || points.length < 2) return null;
  const path = `/routing/1${routeQuery(points, profile, { routeRepresentation: 'polyline' })}`;
  let { status, data } = await send(path);
  // Ngay sau một loạt yêu cầu ma trận, TomTom có thể từ chối vì gọi quá nhanh (429), hoặc lỗi tạm thời (5xx, mạng):
  // chờ 2, 4, 8 giây rồi thử lại. Vẫn không được thì trả null, việc lấy bổ sung theo chu kỳ (geometry.js) sẽ thử lại sau
  for (let i = 0; i < 3 && retryable(status); i++) {
    await sleep(2000 * 2 ** i);
    ({ status, data } = await send(path));
  }
  if (status !== 200) console.error(`Không lấy được đường đi: HTTP ${status} ${errorText(data)}`.trim());
  if (status !== 200 || !data.routes?.length) return null;
  const coords = [];
  for (const legPart of data.routes[0].legs) {
    for (const p of legPart.points) coords.push([p.longitude, p.latitude]);
  }
  const s = data.routes[0].summary;
  return { type: 'LineString', coordinates: coords, properties: { seconds: s.travelTimeInSeconds, meters: s.lengthInMeters } };
}

/** Tìm tọa độ từ địa chỉ, ưu tiên kết quả quanh kho. */
export async function geocode(address, near) {
  const p = new URLSearchParams({ countrySet: 'VN', limit: '5', language: 'vi-VN' });
  if (near) { p.set('lat', String(near.lat)); p.set('lon', String(near.lon)); p.set('radius', '30000'); }
  const { status, data } = await send(`/search/2/geocode/${encodeURIComponent(address)}.json?${p}`);
  if (status !== 200) return [];
  return (data.results || []).map(r => ({
    address: r.address?.freeformAddress ?? '',
    lat: r.position.lat,
    lon: r.position.lon,
    score: r.score,
    type: r.type,
  }));
}

/** Một ô bản đồ nền raster 256 px. */
export async function mapTile(z, x, y) {
  const { status, data } = await send(`/map/1/tile/basic/main/${z}/${x}/${y}.png?tileSize=256`, { binary: true });
  return status === 200 ? data : null;
}
