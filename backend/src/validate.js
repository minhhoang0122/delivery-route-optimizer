// Kiểm tra dữ liệu gửi lên. Dữ liệu từ trình duyệt luôn được kiểm tra lại ở Backend.
import { badRequest } from './errors.js';

export function text(value, label, { required = true, max = 255, min = 0 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`Thiếu ${label}`);
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`${label} phải là chuỗi`);
  const v = value.trim();
  if (required && !v) throw badRequest(`Thiếu ${label}`);
  if (v.length < min) throw badRequest(`${label} phải có ít nhất ${min} ký tự`);
  if (v.length > max) throw badRequest(`${label} dài tối đa ${max} ký tự`);
  return v || null;
}

export function number(value, label, { required = true, min = -Infinity, max = Infinity, gt } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`Thiếu ${label}`);
    return null;
  }
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) throw badRequest(`${label} phải là số`);
  if (gt !== undefined && !(n > gt)) throw badRequest(`${label} phải lớn hơn ${gt}`);
  if (n < min || n > max) throw badRequest(`${label} phải trong khoảng ${min} đến ${max}`);
  return n;
}

export function integer(value, label, opts) {
  const n = number(value, label, opts);
  if (n !== null && !Number.isInteger(n)) throw badRequest(`${label} phải là số nguyên`);
  return n;
}

export function oneOf(value, label, allowed, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`Thiếu ${label}`);
    return null;
  }
  if (!allowed.includes(value)) throw badRequest(`${label} không hợp lệ`);
  return value;
}

export function idList(value, label, { min = 1 } = {}) {
  if (!Array.isArray(value)) throw badRequest(`${label} phải là danh sách`);
  const ids = [...new Set(value.map(v => Number(v)))];
  if (ids.some(v => !Number.isInteger(v) || v <= 0)) throw badRequest(`${label} chứa mã không hợp lệ`);
  if (ids.length < min) throw badRequest(`Cần chọn ít nhất ${min} ${label}`);
  return ids;
}

export function timestamp(value, label, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`Thiếu ${label}`);
    return null;
  }
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) throw badRequest(`${label} không phải thời điểm hợp lệ`);
  return t;
}

/** Mã trong đường dẫn, ví dụ /trips/:id */
export function paramId(req, name = 'id') {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Mã không hợp lệ');
  return n;
}
