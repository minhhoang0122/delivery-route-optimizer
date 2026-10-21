// Xác thực bằng JWT và kiểm tra quyền theo vai trò.
// Mỗi yêu cầu đọc lại tài khoản từ cơ sở dữ liệu, nên tài khoản vừa bị khóa hoặc đổi vai trò
// không dùng tiếp được token cũ (FR01). Việc ẩn nút trên giao diện không thay cho kiểm tra này (NFR02).
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { query } from './db.js';
import { forbidden, HttpError, unauthorized } from './errors.js';

export const signToken = user => jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

export async function loadUser(id) {
  const { rows } = await query(
    `SELECT u.id, u.username, u.full_name, u.role, u.status, u.must_change_password, d.id AS driver_id
       FROM users u LEFT JOIN drivers d ON d.user_id = u.id
      WHERE u.id = $1`, [id]);
  return rows[0] || null;
}

export const publicUser = u => ({
  id: u.id,
  username: u.username,
  fullName: u.full_name,
  role: u.role,
  status: u.status,
  mustChangePassword: u.must_change_password,
  driverId: u.driver_id ?? null,
});

/** Bắt buộc đăng nhập. Gắn req.user nếu hợp lệ. */
export async function requireAuth(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw unauthorized();
    }
    const user = await loadUser(payload.sub);
    if (!user) throw unauthorized();
    if (user.status === 'locked') throw new HttpError(403, 'ACCOUNT_LOCKED', 'Tài khoản đã bị khóa');
    // Tài khoản mới cấp phải đổi mật khẩu trước khi dùng các chức năng khác
    const allowed = ['/api/auth/me', '/api/auth/change-password'];
    if (user.must_change_password && !allowed.includes(req.originalUrl.split('?')[0])) {
      throw new HttpError(403, 'MUST_CHANGE_PASSWORD', 'Cần đổi mật khẩu trước khi tiếp tục');
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Chỉ cho phép các vai trò được liệt kê. */
export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
  next();
};
