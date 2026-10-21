// Ứng dụng Express: gắn các module nghiệp vụ theo kiến trúc ở Hình 3.6.
import express from 'express';
import { requireAuth } from './auth.js';
import { errorHandler, notFound } from './errors.js';
import authRoutes from './routes/auth.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import driverRoutes from './routes/driver.routes.js';
import mapRoutes from './routes/map.routes.js';
import orderRoutes from './routes/orders.routes.js';
import planningRoutes from './routes/planning.routes.js';
import resourceRoutes from './routes/resources.routes.js';
import tripRoutes from './routes/trips.routes.js';
import userRoutes from './routes/users.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date() }));
  app.use('/api/auth', authRoutes);
  app.use('/api/map', mapRoutes);

  // Từ đây trở xuống đều phải đăng nhập; mỗi router tự kiểm tra vai trò
  app.use('/api', requireAuth);
  app.use('/api/users', userRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api', resourceRoutes);
  app.use('/api/planning', planningRoutes);
  app.use('/api/trips', tripRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/driver', driverRoutes);

  app.use('/api', (_req, _res, next) => next(notFound('Không có API này')));
  app.use(errorHandler);
  return app;
}
