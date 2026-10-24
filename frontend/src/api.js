// Gọi Backend API. Vite chuyển tiếp /api về Backend (vite.config.js), nên trình duyệt không cần biết cổng.

const TOKEN_KEY = 'lastmile.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = t => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Gọi khi máy chủ báo phiên hết hạn, để AuthProvider đưa người dùng về trang đăng nhập
let onUnauthorized = () => {};
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Không tới được máy chủ: mất mạng hoặc Backend chưa chạy
    throw new ApiError(0, 'NETWORK', 'Không kết nối được máy chủ');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error || {};
    // Phiên hết hạn hoặc tài khoản vừa bị khóa: đưa về trang đăng nhập
    if ((res.status === 401 || (res.status === 403 && e.code === 'ACCOUNT_LOCKED')) && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `Lỗi ${res.status}`, e.details);
  }
  return data;
}

/**
 * Mã thao tác cho yêu cầu cần chống gửi lặp (clientEventId), dạng UUID phiên bản 4.
 * crypto.randomUUID chỉ có trong ngữ cảnh an toàn (HTTPS hoặc localhost); mở qua http://<IP máy>:5173 trên điện thoại
 * thì tự tạo từ crypto.getRandomValues (có ở mọi ngữ cảnh).
 */
export function newEventId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
