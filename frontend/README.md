# Frontend: Web App ReactJS

Giao diện cho quản trị viên, điều phối viên (máy tính) và tài xế (điện thoại), dựng theo file Figma "Điều hành giao hàng – UI".

```
npm install
npm run dev        # http://localhost:5173, /api chuyển tiếp tới Backend ở cổng 3000
npm run dev:phone  # mở cho điện thoại cùng mạng LAN qua HTTPS tự ký: https://<IP máy tính>:5173 (xem README gốc)
npm run lint
npm run build
```

| Thư mục | Nội dung |
|---|---|
| `src/pages/admin` | A02 Tài khoản người dùng, A03 Cấp tài khoản |
| `src/pages/dispatcher` | D01–D12: tổng quan, đơn hàng, nguồn lực, lập kế hoạch, theo dõi, đối chiếu |
| `src/pages/driver` | R01–R07: chuyến hiện tại, kiểm hàng, ghi kết quả, báo về kho, lịch sử |
| `src/layouts` | Khung máy tính (thanh điều hướng trái) và khung điện thoại của Driver |
| `src/components` | Thành phần dùng chung (nút, nhãn, bảng, hộp thoại) và bản đồ Leaflet |
| `src/offline.js` | Hàng đợi thao tác của Driver trong IndexedDB khi mất mạng |
