-- 003: Nhóm kế hoạch và ma trận thời gian

-- Mỗi lần Dispatcher bấm "Tính phương án" là một lần lập kế hoạch
CREATE TABLE planning_runs (
                               id                  SERIAL PRIMARY KEY,
                               created_by          INTEGER     NOT NULL REFERENCES users(id),
                               input_snapshot      JSONB       NOT NULL,
                               result              JSONB,
                               status              VARCHAR(20) NOT NULL DEFAULT 'running'
                                   CHECK (status IN ('running', 'draft', 'failed', 'committed', 'superseded')),
                               created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                               client_event_id     UUID        UNIQUE,
                               request_fingerprint VARCHAR(64)
);

-- Một đợt lấy dữ liệu thời gian di chuyển từ TomTom
CREATE TABLE matrix_batches (
                                id               SERIAL PRIMARY KEY,
                                profile_snapshot JSONB       NOT NULL,
                                started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
                                completed_at     TIMESTAMPTZ,
                                data_source      VARCHAR(20) NOT NULL CHECK (data_source IN ('tomtom', 'mock')),
                                status           VARCHAR(20) NOT NULL DEFAULT 'running'
                                    CHECK (status IN ('running', 'completed', 'partial', 'failed'))
);

-- Thời gian và quãng đường của từng chặng (từ điểm A đến điểm B) trong một đợt
CREATE TABLE matrix_entries (
                                batch_id        INTEGER     NOT NULL REFERENCES matrix_batches(id) ON DELETE CASCADE,
                                origin_key      VARCHAR(50) NOT NULL,
                                destination_key VARCHAR(50) NOT NULL,
                                travel_seconds  INTEGER     CHECK (travel_seconds >= 0),
                                distance_m      INTEGER     CHECK (distance_m >= 0),
                                status          VARCHAR(20) NOT NULL CHECK (status IN ('ok', 'no_route', 'error')),
                                fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
                                PRIMARY KEY (batch_id, origin_key, destination_key),
    -- Chặng lấy được thì phải có thời gian, chặng lỗi thì để trống (không gán 0)
                                CHECK ((status = 'ok' AND travel_seconds IS NOT NULL) OR (status <> 'ok' AND travel_seconds IS NULL)),
    -- Chỉ chặng từ một điểm về chính nó mới có thời gian bằng 0
                                CHECK (origin_key <> destination_key OR travel_seconds = 0)
);

-- Lần lập kế hoạch nào đã dùng những đợt ma trận nào
CREATE TABLE planning_run_matrices (
                                       planning_run_id INTEGER NOT NULL REFERENCES planning_runs(id) ON DELETE CASCADE,
                                       matrix_batch_id INTEGER NOT NULL REFERENCES matrix_batches(id),
                                       PRIMARY KEY (planning_run_id, matrix_batch_id)
);