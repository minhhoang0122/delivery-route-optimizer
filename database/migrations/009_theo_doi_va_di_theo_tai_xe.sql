-- 009: Khách theo dõi đơn và tự hẹn lại; hệ thống sắp lại tuyến theo tài xế (giao khác thứ tự, lệch tuyến)

-- Mã theo dõi của đơn: 64 ký tự hex ghép từ hai UUID ngẫu nhiên, không suy ra được từ mã đơn.
-- Giờ hẹn sớm nhất do khách chọn ("giao sau HH:MM"); xe đến sớm hơn thì chờ
ALTER TABLE orders
    ADD COLUMN tracking_token VARCHAR(64) NOT NULL UNIQUE
        DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
    ADD COLUMN not_before_at  TIMESTAMPTZ;

-- Lý do tạo phiên bản tuyến: thêm giao khác thứ tự, lệch tuyến (hệ thống sắp lại theo tài xế) và khách hẹn lại
ALTER TABLE route_versions
    DROP CONSTRAINT route_versions_reason_check,
    ADD CONSTRAINT route_versions_reason_check
        CHECK (reason IN ('initial', 'replan', 'deferred', 'orders_removed', 'out_of_order', 'off_route', 'customer'));

-- Thêm loại sự kiện: hệ thống sắp lại tuyến theo tài xế, khách hẹn giờ giao, khách hẹn ngày khác
ALTER TABLE trip_events
    DROP CONSTRAINT trip_events_event_type_check,
    ADD CONSTRAINT trip_events_event_type_check
        CHECK (event_type IN ('trip_assigned', 'trip_started', 'route_replanned', 'route_acknowledged',
                              'attempt_recorded', 'trip_returned', 'trip_closed', 'trip_revoked',
                              'loading_mismatch', 'reroute_evaluated', 'reroute_dismissed',
                              'trip_aborted', 'stop_deferred', 'orders_removed',
                              'route_resequenced', 'customer_deferred', 'customer_rescheduled'));
