-- 007: Xử lý ngoại lệ trong chuyến: kết thúc chuyến do sự cố, giao sau, bỏ đơn thiếu khỏi chuyến,
-- chuyển hoàn, thất lạc, và vị trí xe lúc ghi kết quả giao

-- Đơn: thêm chuyển hoàn (trả lại người gửi) và thất lạc
ALTER TABLE orders
    DROP CONSTRAINT orders_status_check,
    ADD CONSTRAINT orders_status_check
        CHECK (status IN ('pending', 'assigned', 'in_delivery', 'delivered', 'needs_action', 'cancelled',
                          'return_to_sender', 'lost'));

-- Điểm dừng bị bỏ khỏi chuyến trước khi xuất phát (thiếu hàng tại kho). Giữ dòng vì phiên bản tuyến cũ còn trỏ tới
ALTER TABLE trip_stops
    DROP CONSTRAINT trip_stops_status_check,
    ADD CONSTRAINT trip_stops_status_check CHECK (status IN ('pending', 'delivered', 'failed', 'removed'));

-- Lý do tạo phiên bản tuyến: thêm giao sau (Driver dời điểm xuống cuối) và bỏ đơn thiếu khỏi chuyến
ALTER TABLE route_versions
    DROP CONSTRAINT route_versions_reason_check,
    ADD CONSTRAINT route_versions_reason_check CHECK (reason IN ('initial', 'replan', 'deferred', 'orders_removed'));

-- Vị trí xe mới nhất lúc ghi kết quả và khoảng cách tới điểm giao (bằng chứng giao hàng tối thiểu)
ALTER TABLE delivery_attempts
    ADD COLUMN position_lat         NUMERIC(9, 6) CHECK (position_lat BETWEEN -90 AND 90),
    ADD COLUMN position_lon         NUMERIC(9, 6) CHECK (position_lon BETWEEN -180 AND 180),
    ADD COLUMN position_observed_at TIMESTAMPTZ,
    ADD COLUMN distance_m           INTEGER CHECK (distance_m >= 0);

-- Thêm loại sự kiện: kết thúc chuyến do sự cố, giao sau, bỏ đơn thiếu khỏi chuyến
ALTER TABLE trip_events
    DROP CONSTRAINT trip_events_event_type_check,
    ADD CONSTRAINT trip_events_event_type_check
        CHECK (event_type IN ('trip_assigned', 'trip_started', 'route_replanned', 'route_acknowledged',
                              'attempt_recorded', 'trip_returned', 'trip_closed', 'trip_revoked',
                              'loading_mismatch', 'reroute_evaluated', 'reroute_dismissed',
                              'trip_aborted', 'stop_deferred', 'orders_removed'));
