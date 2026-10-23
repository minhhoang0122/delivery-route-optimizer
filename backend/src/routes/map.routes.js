// Bản đồ nền và tìm tọa độ. Ô bản đồ đi qua Backend để khóa TomTom không lộ ra trình duyệt;
// không có khóa thì chuyển sang ô bản đồ OpenStreetMap.
import { Router } from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth, requireRole } from '../auth.js';
import { loadDepot } from '../services/planning.js';
import { geocode, hasKey, mapTile } from '../services/tomtom.js';
import { badRequest } from '../errors.js';
import { text } from '../validate.js';

const router = Router();
const CACHE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'tiles');

// Đường dẫn ô bản đồ không cần đăng nhập, nên chỉ lấy ô TomTom quanh Đà Nẵng để người ngoài không dùng hết hạn mức.
// Từ mức thu phóng 11 trở lên, ô nằm ngoài khung này chuyển sang OpenStreetMap.
const AREA = { south: 15.85, north: 16.25, west: 107.85, east: 108.40 };
const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
const inArea = (z, x, y) => z < 11 || (x >= tileX(AREA.west, z) && x <= tileX(AREA.east, z)
  && y >= tileY(AREA.north, z) && y <= tileY(AREA.south, z));

router.get('/tiles/:z/:x/:y.png', async (req, res) => {
  const [z, x, y] = ['z', 'x', 'y'].map(k => Number(req.params[k]));
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw badRequest('Ô bản đồ không hợp lệ');
  // Ô TomTom chỉ lấy ở mức 0–18; mức 19 (bản đồ cho phép phóng tới) dùng OpenStreetMap
  if (!hasKey() || z > 18 || !inArea(z, x, y)) return res.redirect(302, `https://tile.openstreetmap.org/${z}/${x}/${y}.png`);
  const file = join(CACHE, String(z), String(x), `${y}.png`);
  let png = await readFile(file).catch(() => null);
  if (!png) {
    png = await mapTile(z, x, y);
    if (!png) return res.redirect(302, `https://tile.openstreetmap.org/${z}/${x}/${y}.png`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, png);
  }
  res.set('Cache-Control', 'public, max-age=604800').type('png').send(png);
});

router.get('/source', (_req, res) => {
  res.json({ tiles: hasKey() ? 'tomtom' : 'openstreetmap' });
});

router.get('/geocode', requireAuth, requireRole('dispatcher'), async (req, res) => {
  const q = text(req.query.q, 'địa chỉ', { min: 3, max: 200 });
  if (!hasKey()) return res.json({ results: [], message: 'Chưa cấu hình khóa TomTom, hãy chọn vị trí trên bản đồ' });
  const depot = await loadDepot();
  const results = await geocode(`${q}, Đà Nẵng`, depot && { lat: depot.latitude, lon: depot.longitude });
  res.json({ results });
});

export default router;
