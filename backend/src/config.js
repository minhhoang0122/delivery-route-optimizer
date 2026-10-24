// Cấu hình đọc từ biến môi trường (file .env, xem .env.example).
// Thông tin kết nối PostgreSQL dùng các biến chuẩn PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
// mà thư viện pg tự đọc, nên không cần khai báo lại ở đây.

const num = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
};

export const config = {
  port: num('PORT', 3000),
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  // Khóa TomTom chỉ nằm ở Backend, trình duyệt không bao giờ thấy (mục 3.3.1)
  tomtomKey: (process.env.TOMTOM_API_KEY || '').trim(),
  // replay: dùng lại ma trận đã ghi, chỉ lấy chặng còn thiếu; tomtom: lấy mới theo giao thông hiện tại;
  // mock: ước lượng từ khoảng cách đường chim bay, chỉ để chạy thử khi không có khóa
  matrixSource: process.env.MATRIX_SOURCE || 'replay',
  // Với nguồn tomtom, chặng lấy trong khoảng này được dùng lại thay vì gọi lại TomTom
  matrixReuseMinutes: num('MATRIX_REUSE_MINUTES', 30),

  // Giới hạn thời lượng mỗi chuyến mặc định khi lập kế hoạch (phút, 0 là không giới hạn)
  defaultMaxRouteMinutes: num('DEFAULT_MAX_ROUTE_MINUTES', 60),

  // Giới hạn tính toán của Local Search (NFR09)
  maxEvaluations: num('LS_MAX_EVALUATIONS', 10_000),
  maxSearchMs: num('LS_MAX_MS', 2_000),

  // Điều kiện điều chỉnh tuyến (mục 3.4.6–3.4.7)
  reroute: {
    minSavingSeconds: num('REROUTE_MIN_SAVING_SECONDS', 60),
    minSavingRatio: num('REROUTE_MIN_SAVING_RATIO', 0.05),
    maxPositionAgeSeconds: num('POSITION_MAX_AGE_SECONDS', 30),
    maxEvaluationAgeSeconds: num('EVALUATION_MAX_AGE_SECONDS', 120),
    maxDisplacementM: num('MAX_DISPLACEMENT_M', 100),
    cooldownSeconds: num('REROUTE_COOLDOWN_SECONDS', 120),
    // Chu kỳ kiểm tra tự động (giây), mặc định 120, 0 là tắt. Mỗi lần chỉ lấy các chặng nối tiếp của thứ tự hiện hành;
    // các chặng còn lại và chặng từ vị trí xe chỉ được lấy khi phát hiện tăng thời gian
    checkIntervalSeconds: num('REROUTE_CHECK_SECONDS', 120),
  },

  // Việc cần xử lý trên màn hình Tổng quan của Dispatcher
  monitor: {
    // Vị trí xe cũ hơn ngần này thì báo; Driver mở ứng dụng chỉ đường làm vị trí tạm dừng nên không báo ngay
    stalePositionSeconds: num('POSITION_STALE_SECONDS', 180),
    // Chuyến đã phân nhưng chưa xuất phát quá ngần này phút
    assignedIdleMinutes: num('ASSIGNED_IDLE_MINUTES', 30),
    // Giờ về kho dự kiến trễ hơn kế hoạch quá ngần này phút
    lateMinutes: num('TRIP_LATE_MINUTES', 10),
    // Lần giao chưa thành công trong ngần này phút gần nhất, để gọi khách khi Driver còn ở gần
    failedAlertMinutes: num('FAILED_ALERT_MINUTES', 30),
  },

  // Số lần giao chưa thành công tối đa của một đơn được tự xếp lại; quá số này Dispatcher phải quyết định
  maxDeliveryAttempts: num('MAX_DELIVERY_ATTEMPTS', 3),
  // Vị trí có sai số lớn hơn ngần này mét thì bỏ, không lưu
  positionMaxAccuracyM: num('POSITION_MAX_ACCURACY_M', 100),
  // Kết quả ghi khi xe cách điểm giao xa hơn ngần này mét thì đánh dấu trên chi tiết chuyến
  podMaxDistanceM: num('POD_MAX_DISTANCE_M', 200),
};

export function checkConfig() {
  const problems = [];
  if (!config.jwtSecret || config.jwtSecret.length < 16) problems.push('JWT_SECRET phải dài ít nhất 16 ký tự');
  if (!['replay', 'tomtom', 'mock'].includes(config.matrixSource)) problems.push('MATRIX_SOURCE chỉ nhận replay, tomtom hoặc mock');
  return problems;
}
