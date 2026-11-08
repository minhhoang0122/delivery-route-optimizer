// Ghi ma trận thời gian từ TomTom để các bước sau chạy lại offline (ghi một lần, dùng nhiều lần).
//   node 02_ghi_ma_tran.mjs                      ngày làm việc kế tiếp, lúc 16:00 và 17:30
//   node 02_ghi_ma_tran.mjs --gio 07:30,09:00    giờ khác
//   node 02_ghi_ma_tran.mjs --ngay 2026-10-14    ngày khác
//   node 02_ghi_ma_tran.mjs --bay-gio            giao thông trực tiếp tại thời điểm chạy
//   node 02_ghi_ma_tran.mjs --thu                chỉ geocode và in số request sẽ dùng
// Số request = số đợt × 2 cấu hình × N × (N − 1), N gồm cả kho. 20 đơn: 840 request mỗi đợt.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  TomTom, ROOT, CHUNG, CAU_HINH, truyVanTuyen, ngayLamViecKeTiep, departAt, nhanThoiDiem, nhanFile, loiTomTom,
} from './lib/tomtom.mjs';

const thamSo = process.argv.slice(2);
const lay = ten => { const i = thamSo.indexOf(ten); return i >= 0 ? thamSo[i + 1] : null; };
const FILE_KB = join(ROOT, 'du_lieu', 'kich_ban.json');
const VUNG = { lat: [15.90, 16.20], lon: [107.95, 108.40] };   // Đà Nẵng phần đất liền

const api = new TomTom();
if (!api.key) { console.log('Chưa có khóa: đặt TOMTOM_API_KEY trong file .env'); process.exit(1); }
const kb = JSON.parse(readFileSync(FILE_KB, 'utf8'));

// 1. Geocode các đơn chưa có tọa độ. Kết quả chỉ được nhận khi đúng tên đường, độ khớp ≥ 0,8, có số nhà
//    hoặc ít nhất là đoạn đường, và nằm trong Đà Nẵng. Đơn bị loại cần sửa địa chỉ (thêm tên phường thường giúp khớp đúng).
const chuan = s => s.normalize('NFC').toLowerCase().replace(/^(đường|phố)\s+/, '').trim();
const tenDuong = diaChi => chuan(diaChi.split(',')[0].replace(/^[\w/-]*\d[\w/-]*\s+/, ''));
async function geocodeKiemTra(d, truyVan) {
  const { status, data } = await api.geocode(truyVan, [kb.kho.lat, kb.kho.lon]);
  const g = data?.results?.[0];
  if (status !== 200 || !g) return { lyDo: [`không geocode được (${status} ${loiTomTom(data)})`] };
  const { lat, lon } = g.position;
  const diem = g.matchConfidence?.score ?? 0;
  const lyDo = [
    !chuan(g.address.streetName ?? '').includes(tenDuong(d.dia_chi)) && `khớp sang "${g.address.streetName ?? g.address.freeformAddress}"`,
    diem < 0.8 && `độ khớp ${diem.toFixed(3)} < 0,8`,
    !['Point Address', 'Address Range', 'Street'].includes(g.type) && `chỉ tìm được mức ${g.type}`,
    (lat < VUNG.lat[0] || lat > VUNG.lat[1] || lon < VUNG.lon[0] || lon > VUNG.lon[1]) && 'nằm ngoài Đà Nẵng',
  ].filter(Boolean);
  return { g, lyDo };
}

let daSua = false, biLoai = 0;
for (const d of kb.don.filter(d => d.lat == null)) {
  // TomTom đã bỏ cấp quận (sắp xếp hành chính 2025) nên tên quận cũ có thể làm giảm độ khớp: thử lại không kèm quận.
  const phan = d.dia_chi.split(',').map(s => s.trim());
  let { g, lyDo } = await geocodeKiemTra(d, `${d.dia_chi}, Đà Nẵng`);
  if (lyDo.length && phan.length >= 3) ({ g, lyDo } = await geocodeKiemTra(d, `${phan.slice(0, -1).join(', ')}, Đà Nẵng`));
  if (lyDo.length) { console.log(`  ${d.ma} ${d.dia_chi}: CẦN SỬA ĐỊA CHỈ – ${lyDo.join(', ')}`); biLoai++; continue; }
  const { lat, lon } = g.position;
  Object.assign(d, { lat, lon, nguon_toa_do: `TomTom Geocoding: ${g.address.freeformAddress} (${g.type}, độ khớp ${g.matchConfidence?.score?.toFixed(2)})` });
  console.log(`  ${d.ma} ${d.dia_chi} → ${lat}, ${lon} (${g.type})`);
  daSua = true;
}
if (daSua) {
  const dong = o => '    ' + JSON.stringify(o).replace(/","/g, '", "').replace(/":/g, '": ').replace(/,"/g, ', "');
  const { ghi_chu, kho, xe, don } = kb;
  writeFileSync(FILE_KB, `{\n  "ghi_chu": ${JSON.stringify(ghi_chu)},\n  "kho": ${JSON.stringify(kho, null, 2).replace(/\n/g, '\n  ')},\n` +
    `  "xe": [\n${xe.map(dong).join(',\n')}\n  ],\n  "don": [\n${don.map(dong).join(',\n')}\n  ]\n}\n`);
  console.log(`Đã ghi tọa độ vào du_lieu/kich_ban.json (${api.dem.search} request Search)\n`);
}
if (biLoai) console.log(`${biLoai} đơn chưa có tọa độ hợp lệ, không đưa vào ma trận cho đến khi sửa địa chỉ.\n`);

// 2. Danh sách điểm: kho rồi các đơn có tọa độ.
const diem = [{ ma: kb.kho.ma, lat: kb.kho.lat, lon: kb.kho.lon }, ...kb.don.filter(d => d.lat != null).map(d => ({ ma: d.ma, lat: d.lat, lon: d.lon }))];
const N = diem.length;
const dsDepart = thamSo.includes('--bay-gio') ? ['now']
  : (lay('--gio') ?? '16:00,17:30').split(',').map(g => departAt(lay('--ngay') ?? ngayLamViecKeTiep(), g.trim()));
const cfgs = Object.keys(CAU_HINH);
const tong = dsDepart.length * cfgs.length * N * (N - 1);
console.log(`${N} điểm (kho + ${N - 1} đơn), ${cfgs.length} cấu hình, ${dsDepart.length} đợt → ${tong} request Routing`);
if (thamSo.includes('--thu')) process.exit(0);

// 3. Ghi từng đợt.
mkdirSync(join(ROOT, 'du_lieu'), { recursive: true });
for (const dep of dsDepart) {
  const batDau = new Date();
  const out = {
    departAt: dep, nhan: nhanThoiDiem(dep), bat_dau: batDau.toISOString(), diem,
    cau_hinh: Object.fromEntries(cfgs.map(c => [c, { ...CHUNG, ...CAU_HINH[c] }])),
    thoi_gian: {}, quang_duong: {}, loi: [],
  };
  for (const c of cfgs) {
    const cap = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) cap.push([i, j]);
    const kq = await api.batch(cap.map(([i, j]) => truyVanTuyen(
      [[diem[i].lat, diem[i].lon], [diem[j].lat, diem[j].lon]],
      { ...CHUNG, ...CAU_HINH[c], departAt: dep, routeRepresentation: 'summaryOnly' },
    )));
    // Chặng lỗi để null, không gán 0 (mục 2.4.3).
    const T = diem.map(() => Array(N).fill(null)), D = diem.map(() => Array(N).fill(null));
    for (let i = 0; i < N; i++) { T[i][i] = 0; D[i][i] = 0; }
    cap.forEach(([i, j], k) => {
      if (kq[k].statusCode === 200) { T[i][j] = kq[k].summary.travelTimeInSeconds; D[i][j] = kq[k].summary.lengthInMeters; }
      else out.loi.push({ cau_hinh: c, tu: diem[i].ma, den: diem[j].ma, statusCode: kq[k].statusCode, thong_bao: kq[k].error });
    });
    out.thoi_gian[c] = T;
    out.quang_duong[c] = D;
    console.log(`  ${out.nhan} · ${c}: ${cap.length - out.loi.filter(l => l.cau_hinh === c).length}/${cap.length} chặng hợp lệ`);
  }
  out.ket_thuc = new Date().toISOString();
  const ten = `ma_tran_${dep === 'now' ? `bay_gio_${nhanFile(batDau)}` : dep.slice(0, 16).replace(/[-:]/g, '').replace('T', '_')}.json`;
  writeFileSync(join(ROOT, 'du_lieu', ten), JSON.stringify(out));
  console.log(`  → du_lieu/${ten}${out.loi.length ? ` (${out.loi.length} chặng lỗi, xem trường "loi")` : ''}`);
}
console.log(`\nĐã dùng ${api.dem.routing} request Routing, ${api.dem.search} request Search`);
