# test_demo: thử TomTom API và thuật toán điều phối

Thư mục thử nghiệm, tách khỏi mã chính. Chỉ cần Node.js 18 trở lên, không phải cài thêm gói nào.

## Cài khóa

Tạo file `.env` (file này đã nằm trong `.gitignore`, không đưa lên git):

```
TOMTOM_API_KEY=khóa_của_bạn
```

## Các bước

| Lệnh | Làm gì | Tốn bao nhiêu request |
|---|---|---|
| `node 01_kiem_tra_api.mjs` | 15 bài kiểm tra TomTom, mỗi bài ghi mục tương ứng trong báo cáo | ~75 Routing, 1 Search, 1 ô bản đồ |
| `node 02_ghi_ma_tran.mjs` | Geocode địa chỉ đơn, ghi ma trận cho 2 cấu hình xe lúc 16:00 và 17:30 ngày làm việc kế tiếp | 20 đơn: 840 Routing mỗi đợt |
| `node 03_so_sanh_thuat_toan.mjs` | So sánh các biến thể thuật toán trên ma trận đã ghi, thử đổi tuyến khi giao thông thay đổi | 0 (chạy offline) |
| `node server.mjs` rồi mở http://localhost:8787 | Bản đồ demo: chạy thuật toán, vẽ đường TomTom theo thứ tự đã chọn | 1 Routing mỗi chuyến chưa có trong bộ đệm |

Tùy chọn của bước 2: `--gio 07:30,09:00`, `--ngay 2026-10-14`, `--bay-gio` (giao thông trực tiếp), `--thu` (chỉ geocode và in số request).
Tùy chọn của bước 3: `--ke-hoach <file>`, `--doi <file>`, `--gioi-han-phut 45`.

Hạn mức miễn phí hiện tại: Routing 20.000 request mỗi tháng. Ma trận được ghi một lần rồi dùng lại, không gọi TomTom mỗi lần chạy thuật toán.

## Cấu trúc

```
lib/tomtom.mjs        gọi TomTom: khóa, Calculate Route, Batch Routing, Geocoding, ô bản đồ, phân loại lỗi
lib/thuat_toan.mjs    Insertion, Relocate, Swap, Local Search (mục 3.4) và các biến thể so sánh;
                      chạy được cả trong Node và trình duyệt
du_lieu/kich_ban.json kho, 5 xe, 20 đơn (theo dữ liệu mẫu của thiết kế giao diện)
du_lieu/ma_tran_*.json ma trận đã ghi; du_lieu/cache/ là đường đi đã tải cho bản đồ
ket_qua/              kết quả kiểm tra API và so sánh thuật toán
web/                  trang bản đồ (Leaflet + ô bản đồ TomTom qua server.mjs)
```

Thông số xe tải nhỏ gửi cho TomTom (tổng trọng lượng 2,5 t, dài 4,5 m, rộng 1,7 m, cao 2,0 m) là giả định, sửa trong `lib/tomtom.mjs`.
