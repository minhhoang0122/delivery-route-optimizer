// Khởi động Backend API: kiểm tra cấu hình, kết nối cơ sở dữ liệu rồi mở cổng.
import { createApp } from './app.js';
import { checkConfig, config } from './config.js';
import { pool } from './db.js';
import { failInterruptedRuns } from './services/planning.js';
import { periodicRerouteCheck } from './services/trips.js';

const problems = checkConfig();
if (problems.length) {
  console.error('Cấu hình chưa đúng (xem file .env.example):\n- ' + problems.join('\n- '));
  process.exit(1);
}

try {
  await pool.query('SELECT 1');
} catch (err) {
  console.error('Không kết nối được PostgreSQL. Kiểm tra PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD trong .env.');
  console.error(err.message);
  process.exit(1);
}
await failInterruptedRuns();

createApp().listen(config.port, () => {
  console.log(`Backend chạy tại http://localhost:${config.port}`);
  console.log(`Nguồn ma trận: ${config.matrixSource}${config.tomtomKey ? ' (có khóa TomTom)' : ' (không có khóa TomTom, chặng thiếu sẽ được ước lượng)'}`);
  if (config.reroute.checkIntervalSeconds > 0) {
    setInterval(periodicRerouteCheck, config.reroute.checkIntervalSeconds * 1000);
    console.log(`Kiểm tra đổi tuyến tự động mỗi ${config.reroute.checkIntervalSeconds} giây`);
  }
});
