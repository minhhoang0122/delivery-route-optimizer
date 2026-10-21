// Đăng nhập, thông tin phiên và đổi mật khẩu. Đăng nhập là điều kiện trước của mọi chức năng có phân quyền.
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { publicUser, requireAuth, signToken } from '../auth.js';
import { query } from '../db.js';
import { badRequest, HttpError } from '../errors.js';
import { text } from '../validate.js';

const router = Router();

router.post('/login', async (req, res) => {
  const username = text(req.body?.username, 'tên đăng nhập', { max: 50 });
  const password = text(req.body?.password, 'mật khẩu', { max: 200 });
  const { rows } = await query(
    `SELECT u.*, d.id AS driver_id FROM users u LEFT JOIN drivers d ON d.user_id = u.id WHERE lower(u.username) = lower($1)`,
    [username]);
  const user = rows[0];
  // Cùng một thông báo cho sai tên và sai mật khẩu để không lộ tài khoản nào tồn tại
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Tên đăng nhập hoặc mật khẩu không đúng');
  }
  if (user.status === 'locked') throw new HttpError(403, 'ACCOUNT_LOCKED', 'Tài khoản đã bị khóa. Liên hệ Administrator.');
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const current = text(req.body?.currentPassword, 'mật khẩu hiện tại', { max: 200 });
  const next = text(req.body?.newPassword, 'mật khẩu mới', { min: 8, max: 200 });
  if (current === next) throw badRequest('Mật khẩu mới phải khác mật khẩu hiện tại');
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(current, rows[0].password_hash))) throw badRequest('Mật khẩu hiện tại không đúng');
  // bcrypt tự sinh salt cho mỗi mật khẩu; cơ sở dữ liệu chỉ lưu chuỗi băm
  const hash = await bcrypt.hash(next, 10);
  await query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [req.user.id, hash]);
  res.json({ user: publicUser({ ...req.user, must_change_password: false }) });
});

export default router;
