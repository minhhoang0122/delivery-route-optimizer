// Tạo test/fixtures/kich_ban_60.json: kho 120 Nguyễn Văn Linh, 30 điểm giao thật ở trung tâm Đà Nẵng, 60 đơn, 4 tài xế
// (3 xe máy, 1 xe tải nhỏ), ca chiều 16:00–18:00. Tọa độ lấy bằng TomTom Search (Geocode), mỗi điểm một request.
// Chỉ nhận kết quả mức số nhà (Point Address), đúng số nhà và tên đường đã hỏi, độ khớp ≥ 0,9, nằm trong Đà Nẵng;
// địa chỉ không đạt thì dừng để thay địa chỉ khác, không đoán tọa độ.
//   node experiments/tao_kich_ban_60.js
// Khóa đọc từ backend/.env (TOMTOM_API_KEY) lúc chạy, không in, không ghi ra file.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function docKhoa() {
  const f = new URL('../../backend/.env', import.meta.url);
  if (!existsSync(f)) return '';
  const m = readFileSync(f, 'utf8').match(/^\s*TOMTOM_API_KEY\s*=\s*(.+?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}
const KEY = docKhoa();
if (!KEY) { console.log('Không có TOMTOM_API_KEY trong backend/.env'); process.exit(1); }

// Kho và 30 điểm giao: [mã, số nhà, đường, loại điểm, tên tòa nhà/chợ nếu có]
const KHO = ['KHO', '120', 'Nguyễn Văn Linh', 'kho', 'Kho trung tâm'];
const DIEM = [
  ['D01', '119', 'Trần Phú', 'cho', 'Chợ Hàn'],
  ['D02', '290', 'Hùng Vương', 'cho', 'Chợ Cồn'],
  ['D03', '255', 'Hùng Vương', 'chung_cu', 'Vĩnh Trung Plaza'],
  ['D04', '74', 'Bạch Đằng', 'van_phong', 'Indochina Riverside Towers'],
  ['D05', '2', 'Quang Trung', 'van_phong', 'Công viên phần mềm Đà Nẵng'],
  ['D06', '910A', 'Ngô Quyền', 'trung_tam_thuong_mai', 'Vincom Plaza'],
  ['D07', '45', 'Lê Duẩn', 'cua_hang'],
  ['D08', '322', 'Lê Duẩn', 'nha_rieng'],
  ['D09', '178', 'Trần Phú', 'cua_hang'],
  ['D10', '150', 'Lê Lợi', 'nha_rieng'],
  ['D11', '100', 'Ông Ích Khiêm', 'nha_rieng'],
  ['D12', '98', 'Hàm Nghi', 'nha_rieng'],
  ['D13', '172', 'Điện Biên Phủ', 'nha_rieng'],
  ['D14', '45', 'Nguyễn Tri Phương', 'nha_rieng'],
  ['D15', '60', 'Phan Châu Trinh', 'cua_hang'],
  ['D16', '120', 'Hoàng Diệu', 'nha_rieng'],
  ['D17', '270', 'Núi Thành', 'cua_hang'],
  ['D18', '32', 'Hà Bổng', 'nha_rieng'],
  ['D19', '88', 'Lý Thái Tổ', 'nha_rieng'],
  ['D20', '15', 'Thái Phiên', 'nha_rieng'],
  ['D21', '50', 'Hải Phòng', 'nha_rieng'],
  ['D22', '131', 'Nguyễn Hoàng', 'nha_rieng'],
  ['D23', '234', 'Nguyễn Văn Linh', 'van_phong'],
  ['D24', '42', 'Lê Đình Dương', 'nha_rieng'],
  ['D25', '36', 'Trần Cao Vân', 'nha_rieng'],
  ['D26', '200', 'Hải Phòng', 'nha_rieng'],
  ['D27', '103', 'Lê Thanh Nghị', 'nha_rieng'],
  ['D28', '68', 'Hoàng Hoa Thám', 'nha_rieng'],
  ['D29', '12', 'Kiệt 211 Nguyễn Văn Thoại', 'kiet'],
  ['D30', '8', 'Kiệt 11 Đống Đa', 'kiet'],
];

// 60 đơn: [điểm, mô tả, khối lượng kg, số kiện, lý do chỉ đi xe tải (nếu có)]
const DON = [
  ['D01', 'Vải may mặc', 8.5, 2], ['D01', 'Phụ kiện thời trang', 1.2, 1], ['D01', 'Nấm, mộc nhĩ khô', 4.0, 1], ['D01', 'Bao bì nhựa', 3.5, 2],
  ['D02', 'Hàng khô (4 bao gạo nếp, đậu)', 120, 4, 'Quá nặng cho xe máy'], ['D02', 'Gia vị đóng gói', 2.8, 1], ['D02', 'Đồ nhựa gia dụng', 4.5, 2], ['D02', 'Dép', 1.6, 1],
  ['D03', 'Mỹ phẩm', 0.6, 1], ['D03', 'Quần áo', 0.8, 1], ['D03', 'Nồi chiên không dầu', 6.2, 1], ['D03', 'Sách', 1.1, 1],
  ['D04', 'Tủ lạnh mini 90 L', 45, 1, 'Cồng kềnh'], ['D04', 'Tài liệu hợp đồng', 0.3, 1], ['D04', 'Tai nghe', 0.4, 1], ['D04', 'Thùng sữa tươi', 12, 1],
  ['D05', 'Máy in laser', 8.0, 1], ['D05', 'Thùng giấy A4 (5 ram)', 12.5, 1], ['D05', 'Bàn phím, chuột', 1.3, 1], ['D05', 'Màn hình 24 inch', 5.8, 1], ['D05', 'Ổ cứng, cáp', 0.5, 1],
  ['D06', 'Hàng trưng bày', 3.2, 2], ['D06', 'Giày', 1.4, 1], ['D06', 'Túi xách', 0.9, 1],
  ['D07', 'Điện thoại', 0.5, 1], ['D07', 'Ốp lưng, sạc', 0.3, 1],
  ['D08', 'Quạt đứng', 7.0, 1], ['D08', 'Bóng đèn LED', 1.0, 1],
  ['D09', 'Trà, cà phê', 2.4, 1], ['D09', 'Hộp quà tặng', 1.8, 1],
  ['D10', 'Sách giáo khoa', 3.6, 1], ['D10', 'Văn phòng phẩm', 1.5, 1],
  ['D11', 'Bình nước 19 L', 19.5, 1], ['D11', 'Nước giặt', 3.8, 1],
  ['D12', 'Đồ chơi trẻ em', 2.2, 1], ['D12', 'Bỉm, tã', 4.8, 2],
  ['D13', 'Máy giặt 8 kg', 62, 1, 'Cồng kềnh'], ['D13', 'Ổ cắm điện', 0.4, 1],
  ['D14', 'Thực phẩm chức năng', 0.7, 1], ['D14', 'Quần áo', 1.0, 1],
  ['D15', 'Máy lọc không khí', 9.0, 1], ['D15', 'Mỹ phẩm', 0.5, 1],
  ['D16', 'Sữa bột', 3.2, 1], ['D16', 'Đồ dùng nhà bếp', 2.6, 1],
  ['D17', 'Phụ tùng xe máy', 4.2, 1], ['D17', 'Dầu nhớt (thùng)', 9.6, 1],
  ['D18', 'Đồ bơi', 0.6, 1], ['D18', 'Kem chống nắng', 0.4, 1],
  ['D19', 'Linh kiện máy tính', 1.7, 1],
  ['D20', 'Giày thể thao', 1.3, 1],
  ['D21', 'Dụng cụ y tế', 0.9, 1],
  ['D22', 'Nồi cơm điện', 3.4, 1],
  ['D23', 'Ghế văn phòng', 14.0, 1],
  ['D24', 'Sách', 0.8, 1],
  ['D25', 'Hạt giống, phân bón', 5.5, 1],
  ['D26', 'Áo dài', 0.5, 1],
  ['D27', 'Kệ sắt lắp ráp (dài 1,8 m)', 32, 1, 'Cồng kềnh'],
  ['D28', 'Bánh kẹo', 2.0, 1],
  ['D29', 'Kính bơi, đồ lặn', 1.1, 1],
  ['D30', 'Gạo (túi 10 kg)', 10.0, 1],
];

// Người nhận: 20 tên và số điện thoại của dữ liệu mẫu backend (chỉ đọc), thêm 40 tên mới
const MAU = JSON.parse(readFileSync(new URL('../../backend/scripts/seed-data/nguoi_nhan.json', import.meta.url), 'utf8'));
const TEN_MOI = [
  'Nguyễn Văn Hùng', 'Trần Thị Mai', 'Lê Hoàng Nam', 'Phạm Thị Thu Trang', 'Võ Minh Tuấn', 'Huỳnh Thị Ngọc Ánh', 'Đặng Quốc Bảo', 'Bùi Thị Hạnh',
  'Đỗ Văn Phúc', 'Hồ Thị Kim Oanh', 'Ngô Đức Thắng', 'Dương Thị Bích Ngọc', 'Lý Văn Tài', 'Mai Thị Thanh Thủy', 'Trương Công Danh', 'Phan Thị Diễm',
  'Lương Văn Hiếu', 'Tô Thị Nhung', 'Nguyễn Hữu Phước', 'Trần Quang Hải', 'Lê Thị Mỹ Duyên', 'Hoàng Văn Thành', 'Võ Thị Thanh Tâm', 'Phạm Đình Khôi',
  'Nguyễn Thị Hồng Nhung', 'Đinh Văn Long', 'Cao Thị Yến Nhi', 'Lê Văn Sang', 'Trần Thị Kiều Oanh', 'Nguyễn Minh Nhật', 'Hà Thị Lệ Thu', 'Phùng Văn Lực',
  'Nguyễn Thị Thảo', 'Đoàn Minh Quân', 'Lê Thị Bảo Trâm', 'Trần Đức Anh', 'Vũ Thị Phương', 'Nguyễn Tấn Lộc', 'Phan Văn Toàn', 'Huỳnh Ngọc Hân',
];
// Số điện thoại 09xx/03xx sinh cố định (LCG) để chạy lại cho cùng kết quả
let hat = 20261026;
const ngauNhien = () => (hat = (hat * 1103515245 + 12345) % 2147483648) / 2147483648;
const DAU_SO = ['0905', '0935', '0914', '0983', '0901', '0916', '0934', '0389', '0376', '0352', '0335', '0368'];
const soDienThoai = () => {
  const s = String(Math.floor(ngauNhien() * 1e6)).padStart(6, '0');
  return `${DAU_SO[Math.floor(ngauNhien() * DAU_SO.length)]} ${s.slice(0, 3)} ${s.slice(3)}`;
};
const nguoiNhan = [
  ...Object.values(MAU).map(x => ({ ten: x.ten, sdt: x.sdt })),
  ...TEN_MOI.map(ten => ({ ten, sdt: soDienThoai() })),
];

const VUNG = { lat: [15.90, 16.20], lon: [107.95, 108.40] };
// "Kiệt 211 Đường Nguyễn Văn Thoại" và "Kiệt 211 Nguyễn Văn Thoại" là một: bỏ chữ "đường"/"phố" ở mọi vị trí
const chuan = s => s.normalize('NFC').toLowerCase().replace(/(^|\s)(đường|phố)\s+/g, '$1').trim();
let soRequest = 0;

async function geocode([ma, so, duong]) {
  const truyVan = `${so} ${duong}, Đà Nẵng`;
  const p = new URLSearchParams({ countrySet: 'VN', limit: '1', language: 'vi-VN', lat: '16.06', lon: '108.21', radius: '30000' });
  soRequest++;
  const res = await fetch(`https://api.tomtom.com/search/2/geocode/${encodeURIComponent(truyVan)}.json?${p}&key=${encodeURIComponent(KEY)}`);
  if (res.status === 401 || res.status === 403) throw new Error(`Khóa TomTom bị từ chối (HTTP ${res.status})`);
  const g = (await res.json())?.results?.[0];
  if (!g) return { ma, truyVan, lyDo: [`không có kết quả (HTTP ${res.status})`] };
  const { lat, lon } = g.position;
  const diemKhop = g.matchConfidence?.score ?? 0;
  const lyDo = [
    g.type !== 'Point Address' && `chỉ khớp mức ${g.type}`,
    g.address.streetNumber !== so && `khớp sang số nhà ${g.address.streetNumber ?? '(không có)'}`,
    !chuan(g.address.streetName ?? '').includes(chuan(duong)) && `khớp sang đường "${g.address.streetName}"`,
    diemKhop < 0.9 && `độ khớp ${diemKhop.toFixed(3)} < 0,9`,
    (lat < VUNG.lat[0] || lat > VUNG.lat[1] || lon < VUNG.lon[0] || lon > VUNG.lon[1]) && 'nằm ngoài Đà Nẵng',
  ].filter(Boolean);
  return {
    ma, truyVan, lat, lon, lyDo,
    nguon: `TomTom Geocoding: ${g.address.freeformAddress} (${g.type}, độ khớp ${diemKhop.toFixed(3)})`,
    phuongTomTom: g.address.municipalitySubdivision ?? null,
    capTrenTomTom: g.address.municipality ?? null,
  };
}

const kq = [];
for (const d of [KHO, ...DIEM]) {
  const r = await geocode(d);
  console.log(`  ${r.ma} ${r.truyVan} → ${r.lyDo.length ? `LOẠI: ${r.lyDo.join(', ')}` : `${r.lat}, ${r.lon}`}`);
  kq.push(r);
  await new Promise(ok => setTimeout(ok, 250));
}
console.log(`${soRequest} request Search`);
const loai = kq.filter(r => r.lyDo.length);
if (loai.length) { console.log(`${loai.length} địa chỉ không đạt, cần thay địa chỉ khác. Không ghi file.`); process.exit(1); }

const diaChi = (so, duong) => `${so} ${duong}, Đà Nẵng`;
const [kho, ...diem] = kq;
const tap = k => [...new Set(kq.map(r => r[k]).filter(x => x && x !== 'Đà Nẵng'))].sort((a, b) => a.localeCompare(b, 'vi'));
const tenPhuong = tap('phuongTomTom');
const capTren = tap('capTrenTomTom');
const out = {
  ghi_chu: 'Kịch bản 60 đơn trên 30 điểm giao thật ở trung tâm Đà Nẵng, 4 tài xế (3 xe máy, 1 xe tải nhỏ), ca chiều 16:00–18:00. ' +
    'Tọa độ kho và điểm giao lấy bằng TomTom Geocoding, chỉ nhận kết quả mức số nhà, đúng số nhà và tên đường, độ khớp ≥ 0,9 (experiments/tao_kich_ban_60.js). ' +
    'Địa chỉ ghi dạng "số nhà, đường, Đà Nẵng", không ghi tên phường: Việt Nam bỏ cấp quận và sáp nhập phường từ 1/7/2025, ' +
    `trong khi tên phường TomTom trả về (municipalitySubdivision) vẫn theo địa giới cũ (${tenPhuong.join(', ')}). ` +
    `Trường municipality cho ${capTren.join(', ')}: có tên trùng phường mới (An Hải, Hòa Cường) nhưng Hải Châu, Thanh Khê không phân biệt được ` +
    'với tên quận cũ, nên không dùng làm tên phường mới. ' +
    'Hai điểm D29, D30 là nhà trong kiệt, TomTom có số nhà trong kiệt. Người nhận 1–20 lấy từ backend/scripts/seed-data/nguoi_nhan.json, ' +
    '21–60 là tên mới, số điện thoại sinh cố định. Đơn có ly_do_xe_tai chỉ đi xe tải.',
  kho: { ma: 'KHO', ten: KHO[4], dia_chi: diaChi(KHO[1], KHO[2]), lat: kho.lat, lon: kho.lon, nguon_toa_do: kho.nguon },
  ca: { bat_dau: '16:00', ket_thuc: '18:00' },
  // Thời gian phục vụ: mỗi lần dừng ở một điểm 90 giây (đỗ xe, tìm cửa, gọi khách), mỗi đơn thêm 90 giây (giao, ký nhận).
  // Một đơn riêng lẻ mất 3 phút; nhiều đơn liên tiếp ở cùng điểm chỉ tính một lần dừng.
  phuc_vu: { moi_diem_giay: 90, moi_don_giay: 90 },
  xe: [
    { ma: 'XE1', bien_so: '43B1-234.56', tai_xe: 'Nguyễn Văn An', loai: 'xe_may', cau_hinh: 'motorcycle', tai_trong_kg: 60, so_kien_toi_da: 20 },
    { ma: 'XE2', bien_so: '43C1-118.20', tai_xe: 'Trần Văn Bình', loai: 'xe_may', cau_hinh: 'motorcycle', tai_trong_kg: 60, so_kien_toi_da: 20 },
    { ma: 'XE3', bien_so: '43D1-772.05', tai_xe: 'Lê Minh Cường', loai: 'xe_may', cau_hinh: 'motorcycle', tai_trong_kg: 60, so_kien_toi_da: 20 },
    { ma: 'XE4', bien_so: '43C-125.88', tai_xe: 'Phạm Quốc Dũng', loai: 'xe_tai', cau_hinh: 'truck', tai_trong_kg: 750, so_kien_toi_da: 120 },
  ],
  diem: DIEM.map(([ma, so, duong, loaiDiem, ten], i) => ({
    ma, dia_chi: diaChi(so, duong), loai: loaiDiem, ...(ten ? { ten } : {}), lat: diem[i].lat, lon: diem[i].lon, nguon_toa_do: diem[i].nguon,
  })),
  don: DON.map(([d, moTa, kg, kien, lyDo], i) => ({
    ma: `DH-${2001 + i}`, diem: d, nguoi_nhan: nguoiNhan[i].ten, sdt: nguoiNhan[i].sdt, mo_ta: moTa, khoi_luong_kg: kg, so_kien: kien,
    loai_xe: lyDo ? ['xe_tai'] : ['xe_may', 'xe_tai'], ...(lyDo ? { ly_do_xe_tai: lyDo } : {}),
  })),
};
const dong = o => '    ' + JSON.stringify(o);
writeFileSync(new URL('../test/fixtures/kich_ban_60.json', import.meta.url),
  `{\n  "ghi_chu": ${JSON.stringify(out.ghi_chu)},\n  "kho": ${JSON.stringify(out.kho)},\n  "ca": ${JSON.stringify(out.ca)},\n` +
  `  "phuc_vu": ${JSON.stringify(out.phuc_vu)},\n  "xe": [\n${out.xe.map(dong).join(',\n')}\n  ],\n` +
  `  "diem": [\n${out.diem.map(dong).join(',\n')}\n  ],\n  "don": [\n${out.don.map(dong).join(',\n')}\n  ]\n}\n`);
const kg = out.don.reduce((s, o) => s + o.khoi_luong_kg, 0);
console.log(`→ test/fixtures/kich_ban_60.json: ${out.diem.length} điểm, ${out.don.length} đơn, ${kg.toFixed(1)} kg, ${out.don.reduce((s, o) => s + o.so_kien, 0)} kiện`);
