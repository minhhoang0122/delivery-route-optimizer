// Gắn khung giờ giao vào kịch bản 60 đơn (chạy một lần, ghi lại cả bản trong backend và bản fixture của kiểm thử).
//   node experiments/them_khung_gio.js
// Quy tắc theo loại địa chỉ, giống cách khách chọn khi đặt hàng:
//   - văn phòng: giờ hành chính 08:00–17:00 (sau 17:00 không còn người nhận ở văn phòng);
//   - 5 nhà riêng người nhận đi làm về: 17:00–21:00;
//   - 2 nhà riêng hẹn khung giờ cụ thể 16:30–17:15.
// Các điểm còn lại (chợ, chung cư, trung tâm thương mại, cửa hàng, nhà trong kiệt) nhận hàng cả ca nên không có khung giờ.
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = [
  new URL('../../backend/scripts/seed-data/kich_ban_60.json', import.meta.url),
  new URL('../test/fixtures/kich_ban_60.json', import.meta.url),
];
const SAU_GIO_LAM = ['D10', 'D13', 'D18', 'D24', 'D27'];
const HEN_CU_THE = ['D12', 'D21'];
const NOTE = ' Khung giờ giao (experiments/them_khung_gio.js): văn phòng 08:00–17:00, 5 nhà riêng (D10, D13, D18, D24, D27) 17:00–21:00, 2 nhà riêng (D12, D21) 16:30–17:15, các điểm khác không có khung giờ.';

for (const file of FILES) {
  const kb = JSON.parse(readFileSync(file, 'utf8'));
  const loai = new Map(kb.diem.map(d => [d.ma, d.loai]));
  for (const d of kb.don) {
    delete d.khung_gio;
    if (loai.get(d.diem) === 'van_phong') d.khung_gio = { tu: '08:00', den: '17:00' };
    else if (SAU_GIO_LAM.includes(d.diem)) d.khung_gio = { tu: '17:00', den: '21:00' };
    else if (HEN_CU_THE.includes(d.diem)) d.khung_gio = { tu: '16:30', den: '17:15' };
  }
  if (!kb.ghi_chu.includes('Khung giờ giao')) kb.ghi_chu += NOTE;
  // Cùng định dạng với tao_kich_ban_60.js: mỗi xe, điểm, đơn một dòng
  const dong = o => '    ' + JSON.stringify(o);
  writeFileSync(file,
    `{\n  "ghi_chu": ${JSON.stringify(kb.ghi_chu)},\n  "kho": ${JSON.stringify(kb.kho)},\n  "ca": ${JSON.stringify(kb.ca)},\n` +
    `  "phuc_vu": ${JSON.stringify(kb.phuc_vu)},\n  "xe": [\n${kb.xe.map(dong).join(',\n')}\n  ],\n` +
    `  "diem": [\n${kb.diem.map(dong).join(',\n')}\n  ],\n  "don": [\n${kb.don.map(dong).join(',\n')}\n  ]\n}\n`);
  console.log(file.pathname, kb.don.filter(d => d.khung_gio).length, 'đơn có khung giờ');
}
