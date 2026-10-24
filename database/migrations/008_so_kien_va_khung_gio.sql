-- 008: Số kiện (sức chứa thùng xe, số kiện của đơn) và khung giờ của đợt ma trận (thời gian di chuyển phụ thuộc giờ)

-- Số kiện thùng xe chứa được; để trống là không giới hạn
ALTER TABLE vehicles
    ADD COLUMN capacity_parcels INTEGER CHECK (capacity_parcels > 0);

-- Số kiện của đơn, mặc định 1
ALTER TABLE orders
    ADD COLUMN parcels INTEGER NOT NULL DEFAULT 1 CHECK (parcels > 0);

-- Giờ xuất phát dùng khi lấy ma trận (departAt gửi TomTom) và khung giờ trong ngày (giây kể từ 0:00 giờ Việt Nam).
-- Đợt ước lượng (mock) và đợt sự cố giả định không có khung giờ: thời gian không đổi theo giờ
ALTER TABLE matrix_batches
    ADD COLUMN depart_at    TIMESTAMPTZ,
    ADD COLUMN slot_seconds INTEGER CHECK (slot_seconds BETWEEN 0 AND 86399);

-- Đợt TomTom đã có: ma trận ghi sẵn có departAt trong profile_snapshot, đợt lấy theo giao thông hiện tại xuất phát lúc lấy
UPDATE matrix_batches
   SET depart_at = CASE WHEN profile_snapshot->>'departAt' ~ '^\d{4}-\d{2}-\d{2}T'
                        THEN (profile_snapshot->>'departAt')::timestamptz ELSE started_at END
 WHERE data_source = 'tomtom';

UPDATE matrix_batches
   SET slot_seconds = extract(epoch FROM (depart_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::time)::int
 WHERE depart_at IS NOT NULL;
