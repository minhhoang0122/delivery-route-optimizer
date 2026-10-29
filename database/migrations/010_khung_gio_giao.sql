-- 010: Khung giờ giao của đơn (giờ trong ngày, ví dụ văn phòng 08:00–17:00, nhà riêng sau giờ làm 17:00–21:00).
-- Khác not_before_at (009) là giờ hẹn một lần khách chọn trên trang theo dõi, khung giờ do Dispatcher nhập khi tạo đơn
-- và áp dụng cho mọi ngày lập kế hoạch. Thiếu một đầu nghĩa là không giới hạn đầu đó.
ALTER TABLE orders
    ADD COLUMN window_start TIME,
    ADD COLUMN window_end   TIME,
    ADD CONSTRAINT orders_window_order CHECK (window_start IS NULL OR window_end IS NULL OR window_start < window_end);
