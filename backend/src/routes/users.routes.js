// UC01 Quản lý tài khoản: cấp tài khoản, đổi vai trò, khóa và mở lại (Administrator).
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { requireRole } from '../auth.js';
import { query } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { oneOf, paramId, text } from '../validate.js';
import { ACTIVE_STATUSES, tripCode } from '../services/trips.js';

const router = Router();
router.use(requireRole('administrator'));

const ROLES = ['administrator', 'dispatcher', 'driver'];

const toAccount = r => ({
  id: r.id,
  username: r.username,
  fullName: r.full_name,
  role: r.role,
  status: r.status,
  lastLoginAt: r.last_login_at,
  createdAt: r.created_at,
  mustChangePassword: r.must_change_password,
  hasDriverProfile: r.driver_id != null,
  activeTrip: r.active_trip_id ? { id: r.active_trip_id, code: tripCode(r.active_trip_id), status: r.active_trip_status } : null,
});

const SELECT = `
  SELECT u.*, d.id AS driver_id, t.id AS active_trip_id, t.status AS active_trip_status
    FROM users u
    LEFT JOIN drivers d ON d.user_id = u.id
    LEFT JOIN trips t ON t.driver_id = d.id AND t.status = ANY($1)`;

router.get('/', async (_req, res) => {
  const { rows } = await query(`${SELECT} ORDER BY u.role, u.username`, [ACTIVE_STATUSES]);
  res.json({ users: rows.map(toAccount) });
});

router.post('/', async (req, res) => {
  const username = text(req.body?.username, 'tên đăng nhập', { min: 3, max: 50 });
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw badRequest('Tên đăng nhập chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang');
  const fullName = text(req.body?.fullName, 'họ tên', { max: 100 });
  const role = oneOf(req.body?.role, 'vai trò', ROLES);
  const password = text(req.body?.password, 'mật khẩu ban đầu', { min: 8, max: 200 });
  const exists = await query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
  if (exists.rows.length) throw conflict('Tên đăng nhập đã tồn tại');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, role, full_name, must_change_password) VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [username, hash, role, fullName]);
  const created = await query(`${SELECT} WHERE u.id = $2`, [ACTIVE_STATUSES, rows[0].id]);
  res.status(201).json({ user: toAccount(created.rows[0]) });
});

async function loadAccount(id) {
  const { rows } = await query(`${SELECT} WHERE u.id = $2`, [ACTIVE_STATUSES, id]);
  if (!rows[0]) throw notFound('Không tìm thấy tài khoản');
  return rows[0];
}

router.patch('/:id/role', async (req, res) => {
  const id = paramId(req);
  const role = oneOf(req.body?.role, 'vai trò', ROLES);
  if (id === req.user.id) throw badRequest('Không tự đổi vai trò của chính mình');
  const u = await loadAccount(id);
  // Đổi vai trò không được làm mất điều kiện của chuyến đang hoạt động (mục 3.1.4)
  if (u.role === 'driver' && role !== 'driver' && u.active_trip_id) {
    throw conflict(`Tài xế đang giữ chuyến ${tripCode(u.active_trip_id)}, chưa thể đổi vai trò`);
  }
  if (u.role === 'driver' && role !== 'driver' && u.driver_id) {
    throw conflict('Tài khoản đã có hồ sơ tài xế. Điều phối viên cần ngừng hồ sơ này trước khi đổi vai trò.');
  }
  await query('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
  res.json({ user: toAccount(await loadAccount(id)) });
});

router.patch('/:id/status', async (req, res) => {
  const id = paramId(req);
  const status = oneOf(req.body?.status, 'trạng thái', ['active', 'locked']);
  if (id === req.user.id) throw badRequest('Không tự khóa tài khoản của chính mình');
  await loadAccount(id);
  // Khóa tài khoản không tự giải phóng hàng hay nguồn lực mà chuyến đang giữ
  await query('UPDATE users SET status = $2 WHERE id = $1', [id, status]);
  res.json({ user: toAccount(await loadAccount(id)) });
});

export default router;
