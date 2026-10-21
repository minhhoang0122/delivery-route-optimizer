// Nhận biết yêu cầu gửi lặp (NFR03).
// Mỗi thao tác quan trọng mang một client_event_id (UUID do thiết bị sinh). Backend lưu kèm request_fingerprint
// là SHA-256 của nội dung đã chuẩn hóa. Cùng mã và cùng nội dung thì trả lại kết quả cũ; cùng mã nhưng khác
// nội dung thì báo xung đột. Fingerprint chỉ nhận biết gửi lặp, không thay cho kiểm tra quyền và trạng thái.
import { createHash } from 'node:crypto';
import { badRequest } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON với khóa sắp xếp, để cùng nội dung luôn cho cùng một chuỗi. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const fingerprint = payload => createHash('sha256').update(canonical(payload)).digest('hex');

export function requireEventId(body) {
  const id = body?.clientEventId;
  if (typeof id !== 'string' || !UUID.test(id)) throw badRequest('Thiếu mã thao tác clientEventId (UUID)');
  return id.toLowerCase();
}

/** Nội dung dùng để tính fingerprint: toàn bộ body trừ chính mã thao tác. */
export function eventPayload(body) {
  const { clientEventId: _ignored, ...rest } = body || {};
  return rest;
}
