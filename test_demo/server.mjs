// Máy chủ của bản demo bản đồ. Trình duyệt không giữ khóa TomTom: mọi yêu cầu TomTom đi qua đây,
// giống cách Backend gọi TomTom trong mục 2.5.4. Chạy: node server.mjs rồi mở http://localhost:8787
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { TomTom, ROOT, CHUNG, CAU_HINH, departAtConHieuLuc, loiTomTom } from './lib/tomtom.mjs';

const CONG = Number(process.env.PORT ?? 8787);
const api = new TomTom(undefined, { nghiMs: 0 });
const LOAI = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
// Chỉ phục vụ các file này; .env và mã máy chủ không bao giờ được gửi ra.
const CHO_PHEP = [/^\/web\/[\w.-]+$/, /^\/lib\/thuat_toan\.mjs$/, /^\/du_lieu\/[\w.-]+\.json$/];
const CACHE = join(ROOT, 'du_lieu', 'cache');
const oBanDo = new Map();

/** Hàng đợi giới hạn số lời gọi TomTom chạy cùng lúc (khóa Evaluation có giới hạn QPS). */
function hangDoi(toiDa) {
  let dang = 0;
  const cho = [];
  const tiep = () => {
    if (dang >= toiDa || !cho.length) return;
    dang++;
    const { fn, ok, ko } = cho.shift();
    fn().then(ok, ko).finally(() => { dang--; tiep(); });
  };
  return fn => new Promise((ok, ko) => { cho.push({ fn, ok, ko }); tiep(); });
}
const hangTuyen = hangDoi(1);
const hangO = hangDoi(6);

/** Gặp 429 thì chờ 1, 2, 4 giây rồi thử lại. */
async function thuLaiKhiQuaTai(goi) {
  for (let lan = 0; ; lan++) {
    const r = await goi();
    if (r.status !== 429 || lan >= 3) return r;
    await new Promise(ok => setTimeout(ok, 1000 * 2 ** lan));
  }
}

const guiJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': LOAI['.json'] });
  res.end(JSON.stringify(body));
};

async function docBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 100_000) throw new Error('quá lớn'); }
  return JSON.parse(s);
}

/** Đường đi qua các điểm theo đúng thứ tự (computeBestOrder=false), lưu đệm trên đĩa để không gọi lại. */
async function tuyen({ cauHinh, departAt, diem }) {
  if (!CAU_HINH[cauHinh] || !Array.isArray(diem) || diem.length < 2 || diem.length > 150) return [400, { loi: 'tham số không hợp lệ' }];
  const khoa = createHash('sha1').update(JSON.stringify({ cauHinh, departAt, diem })).digest('hex').slice(0, 16);
  const file = join(CACHE, `tuyen_${khoa}.json`);
  if (existsSync(file)) return [200, JSON.parse(await readFile(file, 'utf8'))];
  const dep = departAtConHieuLuc(departAt);
  const { status, data } = await hangTuyen(() => thuLaiKhiQuaTai(
    () => api.tuyen(diem, { ...CHUNG, ...CAU_HINH[cauHinh], departAt: dep })));
  if (status !== 200) return [status || 502, { loi: loiTomTom(data) }];
  const r = data.routes[0];
  const body = {
    departAt: dep,
    summary: r.summary,
    chang: r.legs.map(l => l.summary.travelTimeInSeconds),
    duong: r.legs.flatMap(l => l.points.map(p => [+p.latitude.toFixed(5), +p.longitude.toFixed(5)])),
  };
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(body));
  return [200, body];
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (p === '/') return res.writeHead(302, { Location: '/web/index.html' }).end();

    if (p === '/api/ma-tran') {
      const ds = (await readdir(join(ROOT, 'du_lieu'))).filter(f => /^ma_tran_.*\.json$/.test(f)).sort();
      const out = [];
      for (const f of ds) {
        const m = JSON.parse(await readFile(join(ROOT, 'du_lieu', f), 'utf8'));
        out.push({ file: f, nhan: m.nhan, departAt: m.departAt });
      }
      return guiJson(res, 200, out);
    }

    if (p === '/api/tuyen' && req.method === 'POST') {
      const [status, body] = await tuyen(await docBody(req));
      return guiJson(res, status, body);
    }

    const o = p.match(/^\/api\/o\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (o) {
      let anh = oBanDo.get(p);
      if (!anh) {
        const { status, data } = await hangO(() => thuLaiKhiQuaTai(() => api.oBanDo(o[1], o[2], o[3])));
        if (status !== 200) return res.writeHead(status || 502).end();
        anh = data.bytes;
        if (oBanDo.size > 3000) oBanDo.clear();
        oBanDo.set(p, anh);
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(anh);
    }

    if (CHO_PHEP.some(r => r.test(p)) && !p.includes('..')) {
      const f = join(ROOT, p);
      if (existsSync(f)) {
        res.writeHead(200, { 'Content-Type': LOAI[extname(f)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return res.end(await readFile(f));
      }
    }
    res.writeHead(404).end('Không tìm thấy');
  } catch (e) {
    guiJson(res, 500, { loi: e.message });
  }
}).listen(CONG, '127.0.0.1', () => {
  console.log(`Demo bản đồ: http://localhost:${CONG}`);
  if (!api.key) console.log('Chưa có TOMTOM_API_KEY trong .env: bản đồ nền và đường đi TomTom sẽ không tải được.');
});
