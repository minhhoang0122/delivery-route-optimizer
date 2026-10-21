-- 004: Nhóm chuyến giao và kết quả giao hàng

-- Chuyến giao: một Driver, một xe, xuất phát từ một kho (UC05, UC11, UC14, UC09, UC16)
CREATE TABLE trips (
    id                       SERIAL PRIMARY KEY,
    depot_id                 INTEGER     NOT NULL REFERENCES depots(id),
    driver_id                INTEGER     NOT NULL REFERENCES drivers(id),
    vehicle_id               INTEGER     NOT NULL REFERENCES vehicles(id),
    planning_run_id          INTEGER     REFERENCES planning_runs(id),
    status                   VARCHAR(30) NOT NULL DEFAULT 'assigned'
                             CHECK (status IN ('assigned', 'in_progress', 'awaiting_reconciliation', 'closed', 'revoked')),
    state_version            INTEGER     NOT NULL DEFAULT 1,
    profile_snapshot         JSONB       NOT NULL,
    current_route_version    INTEGER,
    driver_ack_route_version INTEGER,
    started_at               TIMESTAMPTZ,
    closed_at                TIMESTAMPTZ
);

-- Mỗi Driver và mỗi xe chỉ được ở trong một chuyến chưa kết thúc
CREATE UNIQUE INDEX trips_one_active_per_driver ON trips (driver_id)
    WHERE status IN ('assigned', 'in_progress', 'awaiting_reconciliation');

CREATE UNIQUE INDEX trips_one_active_per_vehicle ON trips (vehicle_id)
    WHERE status IN ('assigned', 'in_progress', 'awaiting_reconciliation');

-- Điểm dừng: một lần phục vụ một đơn trong một chuyến
CREATE TABLE trip_stops (
    id       SERIAL PRIMARY KEY,
    trip_id  INTEGER     NOT NULL REFERENCES trips(id),
    order_id INTEGER     NOT NULL REFERENCES orders(id),
    status   VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    UNIQUE (trip_id, order_id),
    UNIQUE (id, trip_id, order_id)
);

-- Đơn nào đang được giao trong chuyến nào (mỗi đơn chỉ một phân công còn hiệu lực)
CREATE TABLE active_assignments (
    order_id INTEGER PRIMARY KEY,
    trip_id  INTEGER NOT NULL,
    stop_id  INTEGER NOT NULL UNIQUE,
    -- Bộ ba (điểm dừng, chuyến, đơn) phải khớp đúng một dòng trong trip_stops
    FOREIGN KEY (stop_id, trip_id, order_id) REFERENCES trip_stops (id, trip_id, order_id)
);

-- Kết quả giao tại một điểm dừng (UC13)
CREATE TABLE delivery_attempts (
    id                  SERIAL PRIMARY KEY,
    stop_id             INTEGER      NOT NULL UNIQUE REFERENCES trip_stops(id),
    client_event_id     UUID         NOT NULL UNIQUE,
    request_fingerprint VARCHAR(64),
    result              VARCHAR(20)  NOT NULL CHECK (result IN ('delivered', 'failed')),
    reason              VARCHAR(255),
    occurred_at         TIMESTAMPTZ  NOT NULL,
    received_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Chưa giao được thì bắt buộc ghi lý do
    CHECK (result = 'delivered' OR reason IS NOT NULL)
);

-- Phiên bản tuyến: thứ tự giao của một chuyến tại một thời điểm (UC05, UC07)
CREATE TABLE route_versions (
    id                SERIAL PRIMARY KEY,
    trip_id           INTEGER     NOT NULL REFERENCES trips(id),
    matrix_batch_id   INTEGER     REFERENCES matrix_batches(id),
    version_no        INTEGER     NOT NULL CHECK (version_no > 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    objective_seconds INTEGER     NOT NULL CHECK (objective_seconds >= 0),
    distance_m        INTEGER     CHECK (distance_m >= 0),
    reason            VARCHAR(20) NOT NULL CHECK (reason IN ('initial', 'replan')),
    UNIQUE (trip_id, version_no)
);

-- Thứ tự các điểm dừng trong một phiên bản tuyến
CREATE TABLE route_stops (
    route_version_id INTEGER NOT NULL REFERENCES route_versions(id) ON DELETE CASCADE,
    stop_id          INTEGER NOT NULL REFERENCES trip_stops(id),
    sequence_no      INTEGER NOT NULL CHECK (sequence_no > 0),
    PRIMARY KEY (route_version_id, stop_id),
    UNIQUE (route_version_id, sequence_no)
);

-- trips và route_versions trỏ qua lại nhau, nên khóa ngoại của trips thêm sau cùng
ALTER TABLE trips
    ADD FOREIGN KEY (current_route_version) REFERENCES route_versions(id),
    ADD FOREIGN KEY (driver_ack_route_version) REFERENCES route_versions(id);
