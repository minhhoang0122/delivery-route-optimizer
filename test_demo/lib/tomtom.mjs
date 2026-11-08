// Gọi TomTom cho bản demo: đọc khóa, Calculate Route, Batch Routing đồng bộ, Geocoding, ô bản đồ.
// Khóa đọc từ biến môi trường TOMTOM_API_KEY hoặc file .env, không bao giờ in ra màn hình.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://api.tomtom.com';

export function docKhoa() {
  if (process.env.TOMTOM_API_KEY) return process.env.TOMTOM_API_KEY.trim();
  const f = join(ROOT, '.env');
  if (!existsSync(f)) return '';
  const m = readFileSync(f, 'utf8').match(/^\s*TOMTOM_API_KEY\s*=\s*(.+?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}

// Tham số chung theo mục 3.4.2 của báo cáo.
export const CHUNG = { routeType: 'fastest', traffic: true, computeBestOrder: false };

// Cấu hình định tuyến theo loại xe. Thông số xe tải nhỏ là giả định (tổng trọng lượng 2,5 t);
// tải trọng hàng hóa của xe không gửi cho TomTom.
export const CAU_HINH = {
  motorcycle: { travelMode: 'motorcycle' },
  truck: {
    travelMode: 'truck', vehicleWeight: 2500, vehicleLength: 4.5,
    vehicleWidth: 1.7, vehicleHeight: 2.0, vehicleCommercial: true,
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Chuỗi điểm "vĩ độ,kinh độ:vĩ độ,kinh độ" theo đúng thứ tự TomTom yêu cầu. */
export const chuoiDiem = pts => pts.map(([lat, lon]) => `${lat.toFixed(6)},${lon.toFixed(6)}`).join(':');

/** Phần đường dẫn Calculate Route (dùng cho cả gọi lẻ và batch). */
export const truyVanTuyen = (pts, params) =>
  `/calculateRoute/${chuoiDiem(pts)}/json?${new URLSearchParams(params)}`;

/** Lấy thông báo lỗi từ phản hồi TomTom, kể cả định dạng của từng mục trong batch. */
export function loiTomTom(data) {
  if (!data) return '';
  if (data.detailedError) return `${data.detailedError.code ?? ''} ${data.detailedError.message ?? ''}`.trim();
  if (data.error) return data.error.description ?? JSON.stringify(data.error);
  if (data.errorText) return data.errorText;
  if (data.networkError) return `lỗi mạng: ${data.networkError}`;
  return data.text ?? '';
}

/** Phân loại lỗi theo mục 2.4.3: lỗi tạm thời được thử lại, không có tuyến thì không. */
export function phanLoai(status) {
  if (status === 200) return { loai: 'OK', thuLai: false };
  if (status === 400) return { loai: 'không có tuyến hoặc tham số sai', thuLai: false };
  if (status === 401 || status === 403) return { loai: 'khóa sai hoặc không có quyền', thuLai: false };
  if (status === 429) return { loai: 'vượt hạn mức số yêu cầu', thuLai: true };
  if ([0, 408, 500, 502, 503, 504].includes(status)) return { loai: 'lỗi tạm thời', thuLai: true };
  return { loai: `lỗi HTTP ${status}`, thuLai: false };
}

export class TomTom {
  constructor(key = docKhoa(), { nghiMs = 220 } = {}) {
    this.key = key;
    this.nghiMs = nghiMs;               // nghỉ giữa hai lần gọi để không vượt QPS của khóa Evaluation
    this.dem = { routing: 0, search: 0, tile: 0 };
    this.thoiGianGoi = [];              // ms của từng lần gọi HTTP (NFR09 ghi riêng thời gian gọi TomTom)
  }

  async gui(path, { method = 'GET', body, key = this.key, nhiPhan = false } = {}) {
    const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
    const t0 = performance.now();
    let status = 0, data;
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(70_000),
      });
      status = res.status;
      if (nhiPhan && res.ok) {
        data = { type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
      } else {
        const text = await res.text();
        try { data = JSON.parse(text); } catch { data = { text: text.slice(0, 300) }; }
      }
    } catch (e) {
      data = { networkError: e.cause?.code ?? e.name ?? 'không rõ' };
    }
    const ms = performance.now() - t0;
    this.thoiGianGoi.push(ms);
    await sleep(this.nghiMs);
    return { status, data, ms };
  }

  /** Calculate Route qua các điểm [[lat, lon], ...] theo đúng thứ tự đã cho. */
  tuyen(pts, params, opts) {
    this.dem.routing += 1;
    return this.gui(`/routing/1${truyVanTuyen(pts, params)}`, opts);
  }

  /**
   * Batch Routing đồng bộ, chia nhóm tối đa 100 mục. Mục lỗi tạm thời được gửi lại tối đa `thuLai` lần.
   * Trả về mảng cùng thứ tự với `queries`: { statusCode, summary } hoặc { statusCode, error }.
   */
  async batch(queries, { nhom = 100, thuLai = 2 } = {}) {
    const out = new Array(queries.length);
    for (let s = 0; s < queries.length; s += nhom) {
      let cho = [];
      for (let i = s; i < Math.min(s + nhom, queries.length); i++) cho.push(i);
      for (let lan = 0; lan <= thuLai && cho.length; lan++) {
        if (lan) await sleep(1500 * lan);
        this.dem.routing += cho.length;
        const { status, data } = await this.gui('/routing/1/batch/sync/json', {
          method: 'POST', body: { batchItems: cho.map(i => ({ query: queries[i] })) },
        });
        if (status !== 200) {
          for (const i of cho) out[i] = { statusCode: status, error: loiTomTom(data) };
          if (!phanLoai(status).thuLai) cho = [];
          continue;
        }
        const conLai = [];
        data.batchItems.forEach((item, k) => {
          const i = cho[k];
          if (item.statusCode === 200) {
            out[i] = { statusCode: 200, summary: item.response.routes[0].summary };
          } else {
            out[i] = { statusCode: item.statusCode, error: loiTomTom(item.response) };
            if (phanLoai(item.statusCode).thuLai) conLai.push(i);
          }
        });
        cho = conLai;
      }
    }
    return out;
  }

  /** TomTom Geocoding, ưu tiên kết quả quanh kho. */
  geocode(diaChi, quanh) {
    this.dem.search += 1;
    const p = new URLSearchParams({ countrySet: 'VN', limit: '1', language: 'vi-VN' });
    if (quanh) { p.set('lat', quanh[0]); p.set('lon', quanh[1]); p.set('radius', '30000'); }
    return this.gui(`/search/2/geocode/${encodeURIComponent(diaChi)}.json?${p}`);
  }

  /** Một ô bản đồ nền raster 256 px (Map Display API). */
  oBanDo(z, x, y) {
    this.dem.tile += 1;
    return this.gui(`/map/1/tile/basic/main/${z}/${x}/${y}.png?tileSize=256`, { nhiPhan: true });
  }
}

// ---- Thời điểm khởi hành (giờ Việt Nam, +07:00) ----

const VN_MS = 7 * 3600e3;
const p2 = n => String(n).padStart(2, '0');

/** Ngày làm việc (thứ Hai đến thứ Sáu) kế tiếp sau hôm nay, theo giờ Việt Nam. */
export function ngayLamViecKeTiep(tu = Date.now()) {
  const d = new Date(tu + VN_MS);
  d.setUTCHours(0, 0, 0, 0);
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

export const departAt = (ngay, gio) => `${ngay}T${gio}:00+07:00`;

/** Nếu thời điểm đã qua thì dời sang cùng thứ, cùng giờ của tuần kế tiếp (TomTom không nhận departAt trong quá khứ). */
export function departAtConHieuLuc(s) {
  if (!s || s === 'now') return 'now';
  let t = Date.parse(s);
  while (t <= Date.now() + 60_000) t += 7 * 864e5;
  const d = new Date(t + VN_MS);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:00+07:00`;
}

const THU = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
export function nhanThoiDiem(s) {
  if (!s || s === 'now') return 'giao thông hiện tại';
  const d = new Date(Date.parse(s) + VN_MS);
  return `${THU[d.getUTCDay()]} ${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

// ---- Tiện ích ----

export function khoangCachM([lat1, lon1], [lat2, lon2]) {
  const r = Math.PI / 180;
  const h = Math.sin((lat2 - lat1) * r / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** Nhãn thời gian theo giờ máy để đặt tên file, ví dụ 20261011_0545. */
export function nhanFile(d = new Date()) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
}

export const phutGiay = s => `${Math.floor(s / 60)} phút ${p2(Math.round(s % 60))} giây`;
export const soVN = (x, so = 1) => x.toLocaleString('vi-VN', { minimumFractionDigits: so, maximumFractionDigits: so });
