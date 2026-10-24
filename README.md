# Hệ thống điều hành hoạt động giao hàng chặng cuối trong đô thị

Web App cho ba vai trò: quản trị viên quản lý tài khoản, điều phối viên lập kế hoạch và theo dõi chuyến, tài xế thực hiện chuyến trên điện thoại. Phân công và lập tuyến dùng Insertion Heuristic (Regret-2) kết hợp Relocate và Swap, mục tiêu là giờ xe cuối cùng về kho sớm nhất, trên thời gian di chuyển phụ thuộc giờ lấy từ TomTom. Khách theo dõi đơn qua đường dẫn riêng và tự hẹn lại giờ giao.

| Thư mục | Nội dung |
|---|---|
| `frontend` | Web App ReactJS (Vite, react-router, Leaflet) |
| `backend` | Backend API Node.js + Express, kết nối PostgreSQL, gọi TomTom |
| `optimization-engine` | Thuật toán phân công và lập tuyến, không phụ thuộc dịch vụ bản đồ |
| `database/migrations` | Các file SQL tạo 18 bảng, chạy theo thứ tự 001 → 009 |
| `docs` | Sổ tay cơ sở dữ liệu và sổ tay backend, frontend |
| `test_demo` | Thử nghiệm TomTom và thuật toán ban đầu (không thuộc mã chính) |

## Chạy trên máy

Cần Node.js 22 trở lên và PostgreSQL (cơ sở dữ liệu `lastmile`, role `lastmile_app`, cổng 5433 như trong sổ tay cơ sở dữ liệu).

**1. Cơ sở dữ liệu.** Chạy các migration chưa chạy, mỗi file một lần (mở terminal ở thư mục gốc, gõ `chcp 65001` trước):

```
psql -U lastmile_app -h localhost -p 5433 -d lastmile -1 -v ON_ERROR_STOP=1 -f database/migrations/008_so_kien_va_khung_gio.sql
psql -U lastmile_app -h localhost -p 5433 -d lastmile -1 -v ON_ERROR_STOP=1 -f database/migrations/009_theo_doi_va_di_theo_tai_xe.sql
```

008 thêm số kiện (`vehicles.capacity_parcels`, `orders.parcels`) và khung giờ của đợt ma trận (`matrix_batches.depart_at`, `slot_seconds`); 009 thêm mã theo dõi và giờ khách hẹn của đơn (`orders.tracking_token`, `not_before_at`) cùng các lý do phiên bản tuyến và loại sự kiện mới. Sau 008, 009 chạy lại `npm run seed -- --reset` để nạp bộ dữ liệu 60 đơn.

**2. Backend.** Sao chép `backend/.env.example` thành `backend/.env`, điền mật khẩu PostgreSQL, `JWT_SECRET` và (nếu có) `TOMTOM_API_KEY`. Sau đó:

```
cd backend
npm install
npm run seed
npm run dev
```

`npm run seed` nạp kịch bản 60 đơn trên 30 điểm giao ở trung tâm Đà Nẵng (kho 120 Nguyễn Văn Linh), 4 xe của kịch bản (3 xe máy 60 kg / 20 kiện, 1 xe tải nhỏ 750 kg / 120 kiện) kèm tài xế, người nhận và 4 ma trận TomTom đã ghi lúc 16:00, 16:30, 17:00, 17:30, nên lập kế hoạch theo giờ chạy được không cần khóa TomTom. Mật khẩu các tài khoản mẫu là giá trị `SEED_PASSWORD` trong `.env`. Tài khoản: `admin`, `dispatcher`, `dispatcher2`, `driver1` … `driver5` (`driver5` bị khóa, xe 5 đang bảo trì như thiết kế).

**3. Frontend.** Ở terminal khác:

```
cd frontend
npm install
npm run dev
```

Mở http://localhost:5173. Màn hình tài xế dùng trên điện thoại; khi thử trên máy tính, thu hẹp cửa sổ hoặc dùng chế độ thiết bị di động của trình duyệt.

**Chạy trên điện thoại thật (cùng mạng Wi-Fi với máy tính).** Trình duyệt điện thoại chỉ cho lấy vị trí và giữ màn hình sáng trên trang HTTPS, nên dùng:

```
cd frontend
npm run dev:phone
```

Lệnh này mở Vite cho các máy trong mạng LAN với chứng chỉ HTTPS tự ký (`@vitejs/plugin-basic-ssl`) và in địa chỉ `Network: https://<IP máy tính>:5173`. Trên điện thoại mở địa chỉ đó, chấp nhận cảnh báo chứng chỉ (Nâng cao → Tiếp tục), đăng nhập tài khoản tài xế và cho phép truy cập vị trí. Backend vẫn chạy trên máy tính; Vite chuyển tiếp `/api` về `localhost:3000`, nên điện thoại không cần mở cổng 3000. Nếu điện thoại không vào được, cho phép Node.js qua Windows Firewall (mạng Private). Khi chuyến đang giao, ứng dụng giữ màn hình sáng (Screen Wake Lock); tài xế chuyển sang Google Maps để chỉ đường thì trình duyệt ngừng gửi vị trí, điều phối viên chỉ thấy cảnh báo khi vị trí cũ hơn `POSITION_STALE_SECONDS` (mặc định 3 phút).

## Xử lý ngoại lệ

| Tình huống | Ai làm | Hệ thống làm gì |
|---|---|---|
| Thiếu hàng khi xuất phát | Tài xế báo thiếu; điều phối viên bấm "Bỏ đơn thiếu khỏi chuyến" | Đơn thiếu về chờ xếp, chuyến có tuyến mới không còn đơn đó, tài xế kiểm lại và xuất phát |
| Khách vắng, quay lại sau | Tài xế bấm "Giao sau" | Điểm xuống cuối các điểm còn lại (tuyến mới, không cần điều phối viên duyệt) |
| Bấm nhầm kết quả | Tài xế bấm "Hoàn tác" trong 10 giây | Kết quả bị xóa khỏi hàng đợi trên máy trước khi gửi |
| Xe hỏng, tài xế ốm, mất điện thoại | Điều phối viên bấm "Kết thúc chuyến do sự cố" | Điểm chưa giao thành chưa giao được (lý do "Sự cố xe/tài xế"), chuyến chờ đối chiếu |
| Giao hết, không có hàng mang về | — | Báo về kho thì hệ thống tự chốt chuyến, giải phóng xe và tài xế |
| Tài xế giao khác thứ tự | Tài xế ghi kết quả cho một điểm không phải điểm kế tiếp | Hệ thống nhận kết quả rồi sắp lại mọi điểm còn lại từ điểm vừa giao (không cần ngưỡng tiết kiệm), tuyến mới tự về ứng dụng tài xế |
| Xe lệch tuyến | — | Xe cách đường đi của tuyến quá `OFF_ROUTE_METERS` (300 m) ở ít nhất `OFF_ROUTE_POSITIONS` (2) vị trí liên tiếp kéo dài `OFF_ROUTE_SECONDS` (60 giây): sắp lại các điểm còn lại từ vị trí xe. Cần đường đi của tuyến (có khóa TomTom) |
| Khách không có nhà, hẹn giờ | Khách chọn "giao sau HH:MM" trên trang theo dõi đơn | Hệ thống sắp lại các điểm còn lại, xe đến sớm thì chờ tới giờ hẹn; không kịp trước giờ hết ca thì đơn ra khỏi chuyến, về chờ xếp ca sau |
| Khách hẹn ngày khác | Khách bấm "Hẹn ngày khác" | Đơn ra khỏi chuyến, về chờ xếp; tài xế thấy kiện cần mang về kho |
| Có kiện chưa giao được | Điều phối viên đối chiếu | Kiện đã mang về mặc định "Giao lại" (tối đa `MAX_DELIVERY_ATTEMPTS` lần, mặc định 3); quá số lần thì chọn Giao lại, Chuyển hoàn hoặc Thất lạc. Kiện không có trong báo cáo hàng mang về chỉ chọn được Thất lạc |

Điểm "Giao sau" luôn ghim ở cuối tuyến trong mọi lần sắp lại; đơn khách hẹn giờ không được giao trước giờ hẹn. Mọi lần sắp lại ghi vào nhật ký chuyến (người thực hiện là hệ thống hoặc khách hàng).

Tổng quan ca làm việc liệt kê việc cần xử lý: vị trí xe cũ, chuyến trễ so với kế hoạch (`TRIP_LATE_MINUTES`), chuyến đã phân chưa xuất phát (`ASSIGNED_IDLE_MINUTES`), lần giao chưa thành công vừa xảy ra kèm số điện thoại khách (`FAILED_ALERT_MINUTES`), chuyến chờ đối chiếu, hàng không khớp. Mỗi kết quả giao lưu kèm vị trí xe mới nhất và khoảng cách tới điểm giao; chi tiết chuyến đánh dấu kết quả ghi cách điểm giao quá `POD_MAX_DISTANCE_M` (200 m).

## Công cụ thử nghiệm

| Lệnh (trong `backend`) | Dùng để |
|---|---|
| `npm run simulate -- drive --trip 3` | Cho xe của chuyến 3 chạy theo đường đi của tuyến, mỗi chặng đúng thời gian theo dữ liệu giao thông, ghi vị trí mỗi giây dọc đường đi (nguồn `simulator`); tài xế tự ghi kết quả trên ứng dụng |
| `npm run simulate -- incident --trip 3 --factor 3` | Tạo "sự cố giả định" làm chặng phía trước chậm đi, để thử tự đổi tuyến |
| `npm run simulate -- prepare` | Chuẩn bị một lượt demo mà không xóa dữ liệu: chốt chuyến đã về kho, tạo 12 đơn mới trên các điểm giao của kịch bản, lập kế hoạch (ca bắt đầu bây giờ) và giao chuyến |
| `npm run simulate -- demo --trip active` | Chạy trọn các chuyến: xe chạy theo đường thật, dừng và giao đúng thời gian phục vụ, khoảng 10% điểm chưa giao được (`--fail`), `--defer` khách (mặc định 1) hẹn giao sau trên trang theo dõi đơn, chuyến nhiều điểm nhất gặp ùn tắc (`--no-jam` để bỏ), hệ thống tự đổi tuyến, xe về kho |
| `npm run test:flow` | Kiểm thử nghiệp vụ và phân quyền qua API (120 kiểm tra), chạy sau `npm run seed -- --reset`, chỉ trên cơ sở dữ liệu thử (xem dưới) |
| `npm test` (trong `optimization-engine`) | Kiểm thử thuật toán trên ma trận TomTom đã ghi |
| `npm run experiments` (trong `optimization-engine`) | Thí nghiệm cho Chương 4 (mục 4.4), in bảng kết quả và ghi `experiments/ket_qua.json` |

Công cụ mô phỏng chỉ chạy trong 07:00–21:00 giờ địa phương (thêm `--force` để chạy ngoài giờ đó). `--speed 1` (mặc định) cho giờ trên màn hình khớp với xe, dùng khi chụp màn hình. `--speed N` tua nhanh N lần: xe đi, dừng và chờ nhanh hơn N lần nhưng vị trí và kết quả vẫn ghi theo giờ đồng hồ thật, nên giờ dự kiến trên màn hình (theo giao thông thật) chậm hơn xe N lần.

Nguồn ma trận đặt bằng `MATRIX_SOURCE` trong `.env`: `replay` dùng lại các khung giờ đã ghi và chỉ lấy thêm chặng còn thiếu, `tomtom` lấy mới theo giao thông, `mock` ước lượng theo khoảng cách. Thời gian di chuyển phụ thuộc giờ: mỗi chặng có giá trị ở vài khung giờ (lưu theo `depart_at`, `slot_seconds` của đợt ma trận), giữa hai khung nội suy tuyến tính theo giờ xe rời điểm, ngoài khoảng giữ giá trị khung gần nhất. Với `replay`, các khung là 16:00, 16:30, 17:00, 17:30 đã nạp; lập kế hoạch lúc khác giờ đó dùng giá trị khung gần nhất. Với `tomtom`, mỗi lần lập kế hoạch lấy hai khung: giờ bắt đầu ca và sau đó `MATRIX_SECOND_SLOT_MINUTES` (60) phút (gửi `departAt`), dùng lại chặng của khung gần đó lấy trong `MATRIX_REUSE_MINUTES` phút; đổi tuyến và sắp lại khi đang giao chỉ lấy khung "bây giờ". Hạn mức miễn phí của TomTom là 20.000 yêu cầu Routing mỗi tháng. Các đơn cùng tọa độ dùng chung một điểm, nên kịch bản 60 đơn có 31 điểm (kể cả kho), 930 chặng mỗi cấu hình xe mỗi khung: lập kế hoạch lần đầu với hai cấu hình xe và hai khung tốn khoảng 3.720 yêu cầu (lần lập lại trong `MATRIX_REUSE_MINUTES` phút dùng lại, không tốn thêm).

Lập kế hoạch dùng giờ bắt đầu ca (mặc định bây giờ, làm tròn lên 5 phút) và giờ hết ca (mặc định `SHIFT_END`, 18:00): mọi xe phải về kho trước giờ hết ca. Thời gian phục vụ `STOP_SECONDS` (90 giây mỗi lần dừng) và `SERVICE_SECONDS_PER_ORDER` (90 giây mỗi đơn) dùng chung cho lập kế hoạch, giờ dự kiến và đổi tuyến. Các đơn cùng điểm giao được xếp cùng xe, giao liền nhau trong một lần dừng; chỉ tách khi không có loại xe chung hoặc vượt tải, bản nháp ghi rõ đơn nào phải tách. Giờ dự kiến trên mọi màn hình tính cùng mô hình đó, từ lúc muộn nhất trong (bây giờ, lần ghi kết quả gần nhất), từ vị trí xe nếu vị trí còn mới.

### Trang theo dõi đơn của khách

Mỗi đơn có mã theo dõi ngẫu nhiên 64 ký tự. Điều phối viên sao chép đường dẫn `/theo-doi/<mã>` ở trang chi tiết đơn để gửi cho khách (gửi SMS hoặc Zalo nằm ngoài phạm vi). Trang không cần đăng nhập, chỉ trả dữ liệu của đúng đơn đó: trạng thái, khung giờ dự kiến, số điểm dừng trước điểm của khách, tên gọi của tài xế, vị trí xe khi chỉ còn tối đa 2 điểm dừng, kết quả giao. Không có số điện thoại tài xế hay thông tin khách khác. Trước khi tài xế tới gần (`TRACKING_ARRIVING_M`, 300 m), khách chọn "Tôi không có nhà, giao sau…" hoặc "Hẹn ngày khác". API công khai giới hạn `TRACKING_READS_PER_MINUTE` (30) lần đọc và `TRACKING_WRITES_PER_MINUTE` (5) lần hẹn mỗi phút từ một địa chỉ IP.

Kiểm tra đổi tuyến tự động theo chu kỳ đặt bằng `REROUTE_CHECK_SECONDS` (mặc định 120 giây, 0 là tắt). Mỗi chu kỳ hệ thống so thời gian các chặng nối tiếp theo thứ tự hiện hành (điểm kế tiếp → … → kho, k chặng cho k điểm còn lại) với lúc lập tuyến; chỉ khi tăng ít nhất 10% hoặc 120 giây mới lấy thêm các chặng còn lại giữa các điểm và chặng từ vị trí xe rồi đánh giá thứ tự mới. Thứ tự mới hợp lệ và tiết kiệm đạt ngưỡng thì hệ thống tự áp dụng, không cần điều phối viên duyệt; ứng dụng tài xế tự nhận tuyến mới khi tải chuyến, tài xế không phải bấm xác nhận. Khi thiết bị tài xế chưa nhận tuyến hiện hành, hoặc chưa đủ `REROUTE_COOLDOWN_SECONDS` (mặc định 120 giây) sau lần đổi trước, hệ thống không đổi tuyến thêm. Với `MATRIX_SOURCE=tomtom`, mỗi lần kiểm tra một chuyến còn k điểm tốn khoảng k yêu cầu Routing (khoảng 30·k mỗi giờ với chu kỳ 120 giây), lần phát hiện tăng tốn thêm khoảng k(k+1) yêu cầu.

Đường đi để vẽ bản đồ được lấy khi lập kế hoạch và khi đổi tuyến; TomTom tạm từ chối (429, 5xx, lỗi mạng) thì thử lại sau 2, 4, 8 giây. Vẫn thiếu thì Backend lấy bổ sung mỗi phút (tối đa 2 yêu cầu mỗi lượt) cho tuyến của chuyến chưa kết thúc và bản nháp kế hoạch. Khi chưa có đường đi, bản đồ nối các điểm bằng nét chấm xám "Chưa có đường đi".

`npm run test:flow` nạp `.env` như các lệnh khác, nên không chạy được nếu chưa đặt `FLOW_TEST_ALLOW=1`. Chạy trên một cơ sở dữ liệu thử riêng: tạo cơ sở dữ liệu thử, đặt `PGDATABASE` (và `PGPORT` nếu khác) của nó trong môi trường của terminal (biến trong môi trường được ưu tiên hơn `.env`), chạy `npm run seed -- --reset` và `npm start` với cùng biến đó, rồi ở terminal khác cũng đặt các biến ấy cùng `FLOW_TEST_ALLOW=1` và chạy `npm run test:flow`. Ví dụ trong PowerShell: `$env:PGDATABASE='lastmile_test'; $env:FLOW_TEST_ALLOW='1'; npm run test:flow`. Không đặt `FLOW_TEST_ALLOW` trong `.env`.

### Demo mô phỏng trên bản đồ

Mở ba cửa sổ dòng lệnh:

1. `backend`: `npm run start:demo` (như `npm start` nhưng kiểm tra đổi tuyến mỗi 10 giây, cấu hình ở `demo.env`).
2. `frontend`: `npm run dev:demo` (màn hình theo dõi tải lại mỗi 1,5 giây, cấu hình ở `.env.demo`).
3. `backend`: `npm run simulate -- prepare`, rồi `npm run simulate -- demo --trip active`.

Mở chi tiết chuyến đứng đầu danh sách mà lệnh demo in ra. Xe chạy theo đường đi TomTom, vệt xám là quãng đã đi. Đến điểm có chặng phía sau dài nhất thì chặng đó bị ùn tắc (vẽ đỏ). Kiểm tra định kỳ phát hiện chặng chậm và tự đổi tuyến, công cụ đóng vai thiết bị tài xế tự nhận tuyến mới và xe chạy theo tuyến mới. `--speed` đổi hệ số tua nhanh (mặc định 1). Đơn mới của `prepare` nằm trên các điểm giao đã có, nên không tốn thêm yêu cầu ma trận ở nguồn `replay`.

