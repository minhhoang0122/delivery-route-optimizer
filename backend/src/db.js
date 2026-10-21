// Kết nối PostgreSQL và hàm chạy transaction.
import pg from 'pg';

// NUMERIC trả về chuỗi để không mất chính xác; ở đây khối lượng và tọa độ đủ nhỏ để đổi sang số.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, v => (v === null ? null : Number(v)));
// BIGINT (id của vehicle_positions, trip_events) cũng đổi sang số
pg.types.setTypeParser(pg.types.builtins.INT8, v => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ max: 10 });

export const query = (text, params) => pool.query(text, params);

/**
 * Chạy fn trong một transaction. Lỗi ở bất kỳ bước nào thì ROLLBACK toàn bộ (NFR01),
 * nên không có chuyến hay phân công nào được lưu dở dang.
 */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
