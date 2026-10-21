// Lỗi nghiệp vụ trả về cho Web App dưới dạng { error: { code, message, details } }.

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Chưa đăng nhập hoặc phiên đã hết hạn') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Không có quyền thực hiện thao tác này') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Không tìm thấy dữ liệu') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message, details) => new HttpError(409, 'CONFLICT', message, details);

/** Middleware cuối cùng của Express: đổi lỗi thành JSON. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // Vi phạm ràng buộc của PostgreSQL: báo xung đột thay vì lỗi máy chủ
  if (err.code === '23505') {
    return res.status(409).json({ error: { code: 'CONFLICT', message: 'Dữ liệu bị trùng hoặc nguồn lực đang được dùng', details: err.constraint } });
  }
  if (err.code === '23503' || err.code === '23514') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Dữ liệu không thỏa ràng buộc của cơ sở dữ liệu', details: err.constraint } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Nội dung gửi lên không phải JSON hợp lệ' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Lỗi máy chủ' } });
}
