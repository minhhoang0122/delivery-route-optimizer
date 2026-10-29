// Định dạng số, thời gian và nhãn trạng thái theo cách viết tiếng Việt.

const nf = (n, d = 1) => Number(n).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: d })

export const kg = n => `${nf(n, 1)} kg`
export const parcels = n => `${nf(n ?? 0, 0)} kiện`
export const km = m => (m == null ? '—' : `${nf(m / 1000, 1)} km`)
/** Khoảng cách ngắn ghi theo mét, từ 1 km trở lên ghi theo km. */
export const distance = m => (m == null ? '—' : m < 1000 ? `${Math.round(m)} m` : km(m))
export const percent = r => `${nf(r * 100, 1)}%`

/** Giây → "1 giờ 12 phút" hoặc "48 phút". */
export function duration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} phút`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} giờ ${m % 60} phút` : `${h} giờ`
}

export const time = t => (t ? new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '—')
export const dateTime = t => (t ? new Date(t).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—')
export const longDate = (t = new Date()) => {
  const s = new Date(t).toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** "15 giây trước", "2 phút trước". now là giờ máy chủ để không lệch theo đồng hồ máy người dùng. */
export function ago(t, now = Date.now()) {
  if (!t) return 'chưa có'
  const s = Math.max(0, Math.round((new Date(now) - new Date(t)) / 1000))
  if (s < 60) return `${s} giây trước`
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`
  return dateTime(t)
}

export const initials = name => (name || '?').split(' ').filter(Boolean).slice(-2).map(w => w[0]).join('').toUpperCase()

export const VEHICLE_TYPE = { motorcycle: 'Xe máy', small_truck: 'Xe tải nhỏ' }
export const vehicleTypes = types => {
  if (!types?.length) return '—'
  if (types.length === 1) return types[0] === 'small_truck' ? 'Chỉ xe tải nhỏ' : 'Chỉ xe máy'
  return 'Xe máy, xe tải nhỏ'
}
export const truckOnly = types => types?.length && !types.includes('motorcycle')

// Trang đầu tiên của mỗi vai trò sau khi đăng nhập
export const HOME = { administrator: '/admin/accounts', dispatcher: '/dispatcher', driver: '/driver' }

export const ROLE = { administrator: 'Quản trị viên', dispatcher: 'Điều phối viên', driver: 'Tài xế' }

// [nhãn, màu của Status Badge]
export const ORDER_STATUS = {
  pending: ['Chờ xếp', 'neutral'],
  assigned: ['Đã phân công', 'info'],
  in_delivery: ['Đang giao', 'purple'],
  delivered: ['Đã giao', 'success'],
  needs_action: ['Cần xử lý', 'warning'],
  cancelled: ['Đã hủy', 'neutral'],
  return_to_sender: ['Chuyển hoàn', 'neutral'],
  lost: ['Thất lạc', 'danger'],
}
export const TRIP_STATUS = {
  assigned: ['Chờ xuất phát', 'info'],
  in_progress: ['Đang giao', 'purple'],
  awaiting_reconciliation: ['Chờ đối chiếu', 'warning'],
  closed: ['Đã chốt', 'success'],
  revoked: ['Đã thu hồi', 'neutral'],
}
export const PLAN_STATUS = {
  running: ['Đang tính', 'info'],
  draft: ['Bản nháp', 'warning'],
  failed: ['Thất bại', 'danger'],
  committed: ['Đã phân chuyến', 'success'],
  superseded: ['Hết hiệu lực', 'neutral'],
}

/** Màu tuyến theo xe, như "Xe 1" … "Xe 5" trong thiết kế. */
export const routeColor = vehicleId => `var(--route-${((Number(vehicleId) - 1) % 5 + 5) % 5 + 1})`
export const ROUTE_HEX = ['#1f5fae', '#e8590c', '#2b7a3b', '#6b3fa0', '#b83280']
export const routeHex = vehicleId => ROUTE_HEX[((Number(vehicleId) - 1) % 5 + 5) % 5]

// Lý do tài xế chọn khi chưa giao được; INCIDENT_REASON do điều phối viên ghi khi kết thúc chuyến do sự cố
export const REFUSED_REASON = 'Khách từ chối nhận'
export const DRIVER_FAIL_REASONS = ['Vắng nhà', 'Không liên lạc được', 'Sai địa chỉ', REFUSED_REASON, 'Khác']
export const INCIDENT_REASON = 'Sự cố xe/tài xế'
export const FAIL_REASONS = [...DRIVER_FAIL_REASONS, INCIDENT_REASON]

// Quyết định khi đối chiếu cho đơn chưa giao được
export const DECISION = { requeue: 'Giao lại', return_to_sender: 'Chuyển hoàn', lost: 'Thất lạc' }

/** Tên lần cập nhật tuyến theo số phiên bản: 1 là tuyến ban đầu. */
export const routeUpdate = versionNo => (versionNo > 1 ? `Cập nhật tuyến lần ${versionNo - 1}` : 'Tuyến ban đầu')

/** Mức khớp của kết quả tìm địa chỉ (TomTom): tới số nhà hay chỉ tới tên đường. */
export const geocodeMatch = type => (['Point Address', 'Address Range'].includes(type) ? 'Khớp tới số nhà'
  : ['Street', 'Cross Street'].includes(type) ? 'Chỉ khớp tên đường' : 'Chỉ khớp khu vực')
export const streetLevelOnly = type => !['Point Address', 'Address Range'].includes(type)

/** Thẻ giờ khách hẹn trên điểm dừng, ví dụ "Khách hẹn 17:30". */
export const appointment = t => (t ? `Khách hẹn ${time(t)}` : null)
// Khung giờ giao trong ngày ("08:00", "17:00"); thiếu một đầu thì chỉ ghi đầu còn lại
export const deliveryWindow = (from, to) => (from && to ? `Giao ${from}–${to}` : from ? `Giao sau ${from}` : to ? `Giao trước ${to}` : null)

// Trạng thái đơn hiển thị cho khách trên trang theo dõi đơn
export const CUSTOMER_STATUS = {
  pending: 'Chờ xếp chuyến',
  assigned: 'Đã xếp chuyến',
  in_delivery: 'Đang giao',
  delivered: 'Đã giao',
  needs_action: 'Chưa giao được',
  cancelled: 'Đã hủy',
  return_to_sender: 'Chuyển hoàn',
  lost: 'Đang xử lý',
}
