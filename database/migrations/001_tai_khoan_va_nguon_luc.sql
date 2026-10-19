-- 001: Nhóm tài khoản và nguồn lực

-- Bảng người dùng
CREATE TABLE users (
                       id            SERIAL PRIMARY KEY,
                       username      VARCHAR(50)  NOT NULL UNIQUE,
                       password_hash VARCHAR(255) NOT NULL,
                       role          VARCHAR(20)  NOT NULL CHECK (role IN ('administrator', 'dispatcher', 'driver')),
                       status        VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked'))
);

-- Bảng tài xế
CREATE TABLE drivers (
                         id        SERIAL PRIMARY KEY,
                         user_id   INTEGER      NOT NULL UNIQUE REFERENCES users(id),
                         full_name VARCHAR(100) NOT NULL,
                         phone     VARCHAR(20),
                         status    VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

-- Bảng phương tiện
CREATE TABLE vehicles (
                          id              SERIAL PRIMARY KEY,
                          plate           VARCHAR(20)   NOT NULL UNIQUE,
                          vehicle_type    VARCHAR(20)   NOT NULL CHECK (vehicle_type IN ('motorcycle', 'small_truck')),
                          capacity_kg     NUMERIC(8, 2) NOT NULL CHECK (capacity_kg > 0),
                          routing_profile VARCHAR(20)   NOT NULL CHECK (routing_profile IN ('motorcycle', 'truck')),
                          status          VARCHAR(20)   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

-- Bảng kho xuất phát
CREATE TABLE depots (
                        id        SERIAL PRIMARY KEY,
                        name      VARCHAR(100)  NOT NULL,
                        address   VARCHAR(255)  NOT NULL,
                        latitude  NUMERIC(9, 6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
                        longitude NUMERIC(9, 6) NOT NULL CHECK (longitude BETWEEN -180 AND 180)
);