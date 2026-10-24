// Ghi thêm ma trận thời gian TomTom cho các khung giờ trung gian (16:30, 17:00) trên đúng 21 điểm của
// test/fixtures/ma_tran_1600.json, để engine nội suy thời gian chặng theo giờ xe thực sự rời điểm.
// Định dạng yêu cầu giống test_demo/02_ghi_ma_tran.mjs và backend (Batch Routing đồng bộ, tối đa 100 mục/lần).
// Lịch sử giao thông của TomTom tính theo thứ trong tuần và giờ, departAt phải ở tương lai, nên ghi vào
// Thứ Hai kế tiếp rồi so một mẫu nhỏ lúc 16:00 với bản ghi Thứ Hai 12/10/2026 để kiểm tra tính nhất quán.
//   node experiments/ghi_ma_tran.js --mau                 40 chặng lúc 16:00, so với ma_tran_1600.json
//   node experiments/ghi_ma_tran.js --gio 16:30,17:00     ghi đủ 840 chặng mỗi khung giờ
// Khóa đọc từ backend/.env (TOMTOM_API_KEY) lúc chạy, không in, không ghi ra file.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = 'https://api.tomtom.com';
const GIOI_HAN_REQUEST = 1800;          // tổng số request Routing tối đa cho mọi lần chạy của script
const args = process.argv.slice(2);
const lay = ten => { const i = args.indexOf(ten); return i >= 0 ? args[i + 1] : null; };
const fixture = name => new URL(`../test/fixtures/${name}`, import.meta.url);

function docKhoa() {
  const f = new URL('../../backend/.env', import.meta.url);
  if (!existsSync(f)) return '';
  const m = readFileSync(f, 'utf8').match(/^\s*TOMTOM_API_KEY\s*=\s*(.+?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}
const KEY = docKhoa();
if (!KEY) { console.log('Không có TOMTOM_API_KEY trong backend/.env'); process.exit(1); }

const goc = JSON.parse(readFileSync(fixture('ma_tran_1600.json'), 'utf8'));
const diem = goc.diem;
const N = diem.length;
const CAU_HINH = goc.cau_hinh;          // giữ đúng tham số đã dùng cho bản ghi 12/10
const cfgs = Object.keys(CAU_HINH);

// Thứ Hai kế tiếp theo giờ Việt Nam (+07:00, không có giờ mùa hè)
const VN_MS = 7 * 3600e3;
const p2 = n => String(n).padStart(2, '0');
function thuHaiKeTiep() {
  const d = new Date(Date.now() + VN_MS);
  d.setUTCHours(0, 0, 0, 0);
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== 1);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}
const NGAY = lay('--ngay') ?? thuHaiKeTiep();
const departAt = gio => `${NGAY}T${gio}:00+07:00`;
const nhan = gio => `Thứ Hai ${NGAY.slice(8, 10)}/${NGAY.slice(5, 7)}/${NGAY.slice(0, 4)} ${gio}`;

// Đếm request đã dùng qua các lần chạy (không chứa khóa)
const FILE_DEM = new URL('./.dem_request_tomtom.json', import.meta.url);
let daDung = existsSync(FILE_DEM) ? JSON.parse(readFileSync(FILE_DEM, 'utf8')).routing : 0;
const ghiDem = () => writeFileSync(FILE_DEM, JSON.stringify({ routing: daDung }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const truyVan = (i, j, c, dep) => `/calculateRoute/${[diem[i], diem[j]].map(p => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(':')}/json?` +
  new URLSearchParams({ ...CAU_HINH[c], departAt: dep, routeRepresentation: 'summaryOnly' });
const loiText = d => d?.detailedError?.message ?? d?.error?.description ?? d?.errorText ?? (d?.networkError ? `lỗi mạng: ${d.networkError}` : '');
const thuLai = s => [0, 408, 429, 500, 502, 503, 504].includes(s);

async function gui(body) {
  try {
    const res = await fetch(`${BASE}/routing/1/batch/sync/json?key=${encodeURIComponent(KEY)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { text: text.slice(0, 200) }; }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { networkError: e.cause?.code ?? e.name ?? 'không rõ' } };
  }
}

/** Batch Routing, nhóm 100 mục, thử lại mục lỗi tạm thời tối đa 2 lần, dừng hẳn nếu sắp vượt hạn mức. */
async function batch(queries) {
  const out = new Array(queries.length);
  for (let s = 0; s < queries.length; s += 100) {
    let cho = [];
    for (let i = s; i < Math.min(s + 100, queries.length); i++) cho.push(i);
    for (let lan = 0; lan <= 2 && cho.length; lan++) {
      if (daDung + cho.length > GIOI_HAN_REQUEST) throw new Error(`Dừng: sẽ vượt ${GIOI_HAN_REQUEST} request (đã dùng ${daDung})`);
      if (lan) await sleep(1500 * lan);
      daDung += cho.length; ghiDem();
      const { status, data } = await gui({ batchItems: cho.map(i => ({ query: queries[i] })) });
      if (status === 401 || status === 403) throw new Error(`Khóa TomTom bị từ chối (HTTP ${status})`);
      if (status !== 200 || !Array.isArray(data?.batchItems) || data.batchItems.length !== cho.length) {
        for (const i of cho) out[i] = { statusCode: status, error: loiText(data) };
        if (!thuLai(status) && status !== 200) cho = [];
        continue;
      }
      const conLai = [];
      data.batchItems.forEach((item, k) => {
        const i = cho[k];
        if (item.statusCode === 200) out[i] = { statusCode: 200, summary: item.response.routes[0].summary };
        else { out[i] = { statusCode: item.statusCode, error: loiText(item.response) }; if (thuLai(item.statusCode)) conLai.push(i); }
      });
      cho = conLai;
    }
    process.stdout.write(`    ${Math.min(s + 100, queries.length)}/${queries.length}\r`);
  }
  return out;
}

const capDiem = [];
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) capDiem.push([i, j]);

if (args.includes('--mau')) {
  // 20 chặng mỗi cấu hình, cách đều nhau trong danh sách 420 cặp (cố định để chạy lại được)
  const mau = cfgs.flatMap(c => capDiem.filter((_, k) => k % 21 === 0).map(([i, j]) => ({ c, i, j })));
  const dep = departAt('16:00');
  console.log(`Mẫu ${mau.length} chặng, departAt ${dep}`);
  const kq = await batch(mau.map(m => truyVan(m.i, m.j, m.c, dep)));
  const dong = mau.map((m, k) => ({
    cau_hinh: m.c, tu: diem[m.i].ma, den: diem[m.j].ma,
    cu: goc.thoi_gian[m.c][m.i][m.j], moi: kq[k].statusCode === 200 ? kq[k].summary.travelTimeInSeconds : null,
  }));
  const hop = dong.filter(d => d.cu != null && d.moi != null);
  const lech = hop.map(d => Math.abs(d.moi - d.cu) / d.cu);
  const tongCu = hop.reduce((s, d) => s + d.cu, 0), tongMoi = hop.reduce((s, d) => s + d.moi, 0);
  const tk = {
    so_chang: dong.length, hop_le: hop.length, trung_khop: hop.filter(d => d.moi === d.cu).length,
    lech_tuong_doi_tb: lech.reduce((s, x) => s + x, 0) / lech.length, lech_tuong_doi_max: Math.max(...lech),
    lech_tuyet_doi_max_giay: Math.max(...hop.map(d => Math.abs(d.moi - d.cu))),
    trong_5pt: lech.filter(x => x <= 0.05).length, tong_cu: tongCu, tong_moi: tongMoi,
  };
  writeFileSync(fixture('mau_kiem_tra_1600.json'), JSON.stringify({
    departAt: dep, so_voi: goc.departAt, ghi_luc: new Date().toISOString(), thong_ke: tk, chang: dong,
  }, null, 1));
  console.log(tk);
} else {
  for (const gio of (lay('--gio') ?? '16:30,17:00').split(',').map(s => s.trim())) {
    const dep = departAt(gio);
    const out = { departAt: dep, nhan: nhan(gio), bat_dau: new Date().toISOString(), diem, cau_hinh: CAU_HINH, thoi_gian: {}, quang_duong: {}, loi: [] };
    for (const c of cfgs) {
      const kq = await batch(capDiem.map(([i, j]) => truyVan(i, j, c, dep)));
      // Chặng lỗi để null, không gán 0 (mục 2.4.3)
      const T = diem.map(() => Array(N).fill(null)), D = diem.map(() => Array(N).fill(null));
      for (let i = 0; i < N; i++) { T[i][i] = 0; D[i][i] = 0; }
      capDiem.forEach(([i, j], k) => {
        if (kq[k].statusCode === 200) { T[i][j] = kq[k].summary.travelTimeInSeconds; D[i][j] = kq[k].summary.lengthInMeters; }
        else out.loi.push({ cau_hinh: c, tu: diem[i].ma, den: diem[j].ma, statusCode: kq[k].statusCode, thong_bao: kq[k].error });
      });
      out.thoi_gian[c] = T; out.quang_duong[c] = D;
      console.log(`  ${out.nhan} · ${c}: ${capDiem.length - out.loi.filter(l => l.cau_hinh === c).length}/${capDiem.length} chặng hợp lệ`);
    }
    out.ket_thuc = new Date().toISOString();
    const ten = `ma_tran_${gio.replace(':', '')}.json`;
    writeFileSync(fixture(ten), JSON.stringify(out));
    console.log(`  → test/fixtures/${ten}`);
  }
}
console.log(`Tổng request Routing đã dùng (mọi lần chạy): ${daDung}`);
