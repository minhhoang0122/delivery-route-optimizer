-- 005: Vị trí xe và nhật ký thao tác trên chuyến

-- Vị trí xe gửi lên trong chuyến (UC12)
CREATE TABLE vehicle_positions (
    id              BIGSERIAL PRIMARY KEY,
    trip_id         INTEGER       NOT NULL REFERENCES trips(id),
    latitude        NUMERIC(9, 6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude       NUMERIC(9, 6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    observed_at     TIMESTAMPTZ   NOT NULL,
    received_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    accuracy_m      NUMERIC(7, 2) CHECK (accuracy_m >= 0),
    source          VARCHAR(20)   NOT NULL CHECK (source IN ('device', 'simulator')),
    client_event_id UUID          UNIQUE
);

-- Lấy nhanh vị trí mới nhất của một chuyến
CREATE INDEX vehicle_positions_trip_time ON vehicle_positions (trip_id, observed_at DESC);

-- Nhật ký các thao tác trên chuyến: ai làm, lúc nào, làm gì (NFR08)
CREATE TABLE trip_events (
    id                  BIGSERIAL PRIMARY KEY,
    trip_id             INTEGER     NOT NULL REFERENCES trips(id),
    actor_id            INTEGER     REFERENCES users(id),
    event_type          VARCHAR(40) NOT NULL
                        CHECK (event_type IN ('trip_assigned', 'trip_started', 'route_replanned', 'route_acknowledged',
                                              'attempt_recorded', 'trip_returned', 'trip_closed', 'trip_revoked')),
    payload             JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    client_event_id     UUID,
    request_fingerprint VARCHAR(64),
    UNIQUE (trip_id, event_type, client_event_id)
);
