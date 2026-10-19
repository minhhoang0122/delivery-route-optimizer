-- 002: Nhóm đơn hàng

-- Bảng đơn hàng
CREATE TABLE orders (
                        id             SERIAL PRIMARY KEY,
                        code           VARCHAR(20)   NOT NULL UNIQUE,
                        recipient_name VARCHAR(100)  NOT NULL,
                        phone          VARCHAR(20)   NOT NULL,
                        address        VARCHAR(255)  NOT NULL,
                        latitude       NUMERIC(9, 6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
                        longitude      NUMERIC(9, 6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
                        weight_kg      NUMERIC(8, 2) NOT NULL CHECK (weight_kg > 0),
                        status         VARCHAR(20)   NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'assigned', 'in_delivery', 'delivered', 'needs_action', 'cancelled')),
                        version        INTEGER       NOT NULL DEFAULT 1
);

-- Loại xe được phép chở từng đơn (một đơn có thể cho phép nhiều loại xe)
CREATE TABLE order_vehicle_types (
                                     order_id     INTEGER     NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                                     vehicle_type VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('motorcycle', 'small_truck')),
                                     PRIMARY KEY (order_id, vehicle_type)
);