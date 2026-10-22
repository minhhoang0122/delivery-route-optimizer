# Hệ thống điều hành hoạt động giao hàng chặng cuối trong đô thị

Web App cho ba vai trò: Administrator quản lý tài khoản, Dispatcher lập kế hoạch và theo dõi chuyến, Driver thực hiện chuyến trên điện thoại. Phân công và lập tuyến dùng Insertion Heuristic kết hợp Relocate và Swap trên ma trận thời gian di chuyển lấy từ TomTom.

| Thư mục | Nội dung |
|---|---|
| `frontend` | Web App ReactJS (Vite, react-router, Leaflet) |
| `backend` | Backend API Node.js + Express, kết nối PostgreSQL, gọi TomTom |
| `optimization-engine` | Thuật toán phân công và lập tuyến, không phụ thuộc dịch vụ bản đồ |
| `database/migrations` | Các file SQL tạo 18 bảng, chạy theo thứ tự 001 → 006 |
| `docs` | Sổ tay cơ sở dữ liệu và sổ tay backend, frontend |
| `test_demo` | Thử nghiệm TomTom và thuật toán ban đầu (không thuộc mã chính) |

## Chạy trên máy

Cần Node.js 22 trở lên và PostgreSQL (cơ sở dữ liệu `lastmile`, role `lastmile_app`, cổng 5433 như trong sổ tay cơ sở dữ liệu).

**1. Cơ sở dữ liệu.** Chạy các migration chưa chạy, mỗi file một lần (mở terminal ở thư mục gốc, gõ `chcp 65001` trước):

```
psql -U lastmile_app -h localhost -p 5433 -d lastmile -1 -v ON_ERROR_STOP=1 -f database/migrations/006_bo_sung_theo_giao_dien.sql
```

**2. Backend.** Sao chép `backend/.env.example` thành `backend/.env`, điền mật khẩu PostgreSQL, `JWT_SECRET` và (nếu có) `TOMTOM_API_KEY`. Sau đó:

```
cd backend
npm install
npm run seed
npm run dev
```

`npm run seed` nạp kho, 5 xe, 5 Driver, 20 đơn ở Đà Nẵng và hai ma trận TomTom đã ghi. Mật khẩu các tài khoản mẫu là giá trị `SEED_PASSWORD` trong `.env`. Tài khoản: `admin`, `dispatcher`, `dispatcher2`, `driver1` … `driver5` (`driver5` bị khóa, xe 5 đang bảo trì như thiết kế).

**3. Frontend.** Ở terminal khác:

```
cd frontend
npm install
npm run dev
```

Mở http://localhost:5173. Màn hình Driver dùng trên điện thoại; khi thử trên máy tính, thu hẹp cửa sổ hoặc dùng chế độ thiết bị di động của trình duyệt.

## Công cụ thử nghiệm

| Lệnh (trong `backend`) | Dùng để |
|---|---|
| `npm run simulate -- drive --trip 3` | Cho xe của chuyến 3 chạy theo đường đi của tuyến, ghi vị trí mỗi giây (nguồn `simulator`); Driver tự ghi kết quả trên ứng dụng |
| `npm run simulate -- incident --trip 3 --factor 3` | Tạo "sự cố giả định" làm chặng phía trước chậm đi, để thử đề xuất đổi tuyến |
| `npm run simulate -- prepare` | Chuẩn bị một lượt demo mà không xóa dữ liệu: chốt chuyến đã về kho, tạo 12 đơn mới trên các địa chỉ mẫu, lập kế hoạch và giao chuyến |
| `npm run simulate -- demo --trip active` | Chạy trọn các chuyến: xe chạy theo đường thật, giao từng điểm, chuyến nhiều điểm nhất gặp ùn tắc, hệ thống đề xuất và đổi tuyến, xe về kho |
| `npm run test:flow` | Kiểm thử nghiệp vụ và phân quyền qua API (59 kiểm tra), chạy sau `npm run seed -- --reset` |
| `npm test` (trong `optimization-engine`) | Kiểm thử thuật toán trên ma trận TomTom đã ghi |
| `npm run experiments` (trong `optimization-engine`) | Thí nghiệm cho Chương 4 (mục 4.4), in bảng kết quả và ghi `experiments/ket_qua.json` |

Nguồn ma trận đặt bằng `MATRIX_SOURCE` trong `.env`: `replay` dùng lại ma trận đã ghi và chỉ lấy thêm chặng còn thiếu, `tomtom` lấy mới theo giao thông hiện tại, `mock` ước lượng theo khoảng cách. Hạn mức miễn phí của TomTom là 20.000 yêu cầu Routing mỗi tháng; một lần lập kế hoạch 20 đơn với hai loại xe tốn khoảng 840 yêu cầu nếu chưa có dữ liệu.

Kiểm tra đổi tuyến tự động theo chu kỳ đặt bằng `REROUTE_CHECK_SECONDS` (mặc định 0 là tắt). Bật thì hệ thống tự đánh giá các chuyến đang giao và chỉ tạo đề xuất khi thời gian các chặng còn lại tăng ít nhất 10% hoặc 120 giây; Dispatcher vẫn phải duyệt.

### Demo mô phỏng trên bản đồ

Mở ba cửa sổ dòng lệnh:

1. `backend`: `npm run start:demo` (như `npm start` nhưng kiểm tra đổi tuyến mỗi 10 giây, cấu hình ở `demo.env`).
2. `frontend`: `npm run dev:demo` (màn hình theo dõi tải lại mỗi 1,5 giây, cấu hình ở `.env.demo`).
3. `backend`: `npm run simulate -- prepare`, rồi `npm run simulate -- demo --trip active`.

Mở chi tiết chuyến đứng đầu danh sách mà lệnh demo in ra. Xe chạy theo đường đi TomTom, vệt xám là quãng đã đi. Đến điểm có chặng phía sau dài nhất thì chặng đó bị ùn tắc (vẽ đỏ). Kiểm tra định kỳ tạo đề xuất, sau 8 giây công cụ duyệt thay Dispatcher, Driver xác nhận và xe chạy theo tuyến mới. `--approve-after 0` để tự bấm "Duyệt tuyến mới"; `--speed` đổi hệ số tua nhanh (mặc định 4). Mỗi lượt `prepare` tốn khoảng 300 yêu cầu Routing cho các đơn mới.

