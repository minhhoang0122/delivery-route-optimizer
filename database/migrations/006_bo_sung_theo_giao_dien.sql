-- 006: Bổ sung các cột mà giao diện cần nhưng 001–005 chưa có

-- Tài khoản: họ tên hiển thị, buộc đổi mật khẩu lần đầu (A03), lần đăng nhập gần nhất (A02)
ALTER TABLE users
    ADD COLUMN full_name            VARCHAR(100),
    ADD COLUMN must_change_password BOOLEAN     NOT NULL DEFAULT false,
    ADD COLUMN last_login_at        TIMESTAMPTZ,
    ADD COLUMN created_at           TIMESTAMPTZ NOT NULL DEFAULT now();

-- Mỗi xe đi cùng một Driver thường dùng (D05, D08)
ALTER TABLE drivers
    ADD COLUMN default_vehicle_id INTEGER UNIQUE REFERENCES vehicles(id);

-- Giờ mở cửa của kho (D07)
ALTER TABLE depots
    ADD COLUMN opening_hours VARCHAR(50);

-- Ghi chú của người nhận (R03) và thời điểm tạo đơn
ALTER TABLE orders
    ADD COLUMN note       VARCHAR(255),
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Thời điểm giao chuyến và thời điểm Driver báo về kho (R06, D12)
ALTER TABLE trips
    ADD COLUMN created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN returned_at TIMESTAMPTZ;

-- Đường đi để vẽ bản đồ, dạng GeoJSON LineString (kinh độ, vĩ độ)
ALTER TABLE route_versions
    ADD COLUMN geometry JSONB;

-- Ghi chú khi chưa giao được (R04) và người ghi kết quả (UC13)
ALTER TABLE delivery_attempts
    ADD COLUMN note        VARCHAR(255),
    ADD COLUMN recorded_by INTEGER REFERENCES users(id);

-- Thêm loại sự kiện: hàng không khớp khi xuất phát, đánh giá đổi tuyến và bỏ qua đề xuất
ALTER TABLE trip_events
    DROP CONSTRAINT trip_events_event_type_check,
    ADD CONSTRAINT trip_events_event_type_check
        CHECK (event_type IN ('trip_assigned', 'trip_started', 'route_replanned', 'route_acknowledged',
                              'attempt_recorded', 'trip_returned', 'trip_closed', 'trip_revoked',
                              'loading_mismatch', 'reroute_evaluated', 'reroute_dismissed'));
