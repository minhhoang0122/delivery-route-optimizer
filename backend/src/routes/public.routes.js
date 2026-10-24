// Trang theo dõi đơn của khách (không đăng nhập): xem trạng thái, khung giờ dự kiến và tự hẹn lại trước khi tài xế đến.
// Mã theo dõi trong đường dẫn là chuỗi ngẫu nhiên 64 ký tự; mỗi địa chỉ IP bị giới hạn số yêu cầu mỗi phút.
import { Router } from 'express';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { customerDefer, customerReschedule, trackingView } from '../services/customer.js';
import { text } from '../validate.js';

const router = Router();

/** Giới hạn số yêu cầu mỗi phút theo địa chỉ IP (cửa sổ cố định một phút, lưu trong bộ nhớ). */
function rateLimit(perMinute) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const h = hits.get(key);
    if (!h || now - h.start >= 60_000) hits.set(key, { start: now, count: 1 });
    else if (++h.count > perMinute()) {
      res.set('Retry-After', String(Math.ceil((h.start + 60_000 - now) / 1000)));
      return next(new HttpError(429, 'RATE_LIMITED', 'Bạn thao tác quá nhanh, thử lại sau ít phút'));
    }
    // Dọn các địa chỉ đã hết cửa sổ để bảng không lớn dần
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start >= 60_000) hits.delete(k);
    next();
  };
}
const reads = rateLimit(() => config.tracking.readsPerMinute);
const writes = rateLimit(() => config.tracking.writesPerMinute);

// Trang công khai không được lưu đệm ở trình duyệt hay máy chủ trung gian
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/tracking/:token', reads, async (req, res) => {
  res.json({ tracking: await trackingView(req.params.token) });
});

router.post('/tracking/:token/defer', writes, async (req, res) => {
  const time = text(req.body?.time, 'giờ hẹn', { max: 5 });
  res.json({ tracking: await customerDefer(req.params.token, time) });
});

router.post('/tracking/:token/reschedule', writes, async (req, res) => {
  res.json({ tracking: await customerReschedule(req.params.token) });
});

export default router;
