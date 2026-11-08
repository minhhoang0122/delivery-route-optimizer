// So sánh các biến thể thuật toán trên ma trận TomTom đã ghi (không gọi TomTom).
//   node 03_so_sanh_thuat_toan.mjs                                   dùng hai đợt ma trận đầu tiên trong du_lieu/
//   node 03_so_sanh_thuat_toan.mjs --ke-hoach ma_tran_A.json --doi ma_tran_B.json
//   node 03_so_sanh_thuat_toan.mjs --gioi-han-phut 45                thử thêm giới hạn thời lượng chuyến
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, soVN } from './lib/tomtom.mjs';
import { taoBaiToan, tomTat, BIEN_THE, danhGiaDoiTuyen } from './lib/thuat_toan.mjs';

const thamSo = process.argv.slice(2);
const lay = ten => { const i = thamSo.indexOf(ten); return i >= 0 ? thamSo[i + 1] : null; };
const docJson = f => JSON.parse(readFileSync(join(ROOT, 'du_lieu', f), 'utf8'));
const dsMaTran = readdirSync(join(ROOT, 'du_lieu')).filter(f => /^ma_tran_.*\.json$/.test(f)).sort();
if (!dsMaTran.length) { console.log('Chưa có ma trận: chạy node 02_ghi_ma_tran.mjs trước.'); process.exit(1); }
const fileKH = lay('--ke-hoach') ?? dsMaTran[0];
const fileDoi = lay('--doi') ?? dsMaTran.find(f => f !== fileKH);
const kb = docJson('kich_ban.json');
const mtKH = docJson(fileKH);
const P = taoBaiToan(kb, mtKH);
const phut = s => soVN(s / 60);
const bang = (cot, dong) => {
  const rong = cot.map((c, i) => Math.max(c.length, ...dong.map(d => String(d[i]).length)));
  const in1 = d => d.map((x, i) => (i ? String(x).padStart(rong[i]) : String(x).padEnd(rong[i]))).join('  ');
  console.log(in1(cot)); console.log(rong.map(r => '─'.repeat(r)).join('  ')); dong.forEach(d => console.log(in1(d)));
};
const tuyenChu = (P, kq) => kq.tuyen.map((r, v) => (r.length ? `  ${P.xe[v].ma} (${P.xe[v].loai === 'xe_may' ? 'xe máy' : 'xe tải'}): KHO → ${r.map(o => P.don[o].ma).join(' → ')} → KHO` : null)).filter(Boolean).join('\n');

console.log(`Ma trận lập kế hoạch: ${fileKH} (${mtKH.nhan}), ${P.don.length} đơn, ${P.xe.length} xe\n`);

// 1. So sánh các biến thể lập kế hoạch.
const ketQua = [];
for (const bt of BIEN_THE) {
  const kq = bt.chay(P);
  ketQua.push({ bt, kq, tt: tomTat(P, kq) });
}
const totNhat = Math.min(...ketQua.map(k => k.tt.T));
console.log('1. LẬP KẾ HOẠCH TRƯỚC XUẤT PHÁT');
bang(['Biến thể', 'T (phút)', 'Hơn tốt nhất', 'Chuyến dài nhất', 'Số xe', 'Chưa xếp', 'Phép đánh giá', 'ms', 'Dừng vì'],
  ketQua.map(({ bt, kq, tt }) => [bt.ten, phut(tt.T), `${soVN((tt.T / totNhat - 1) * 100)}%`, phut(tt.chuyenDaiNhat),
    tt.soXe, tt.chuaXep, kq.thongKe.danhGia.toLocaleString('vi-VN'), Math.round(kq.thongKe.ms), kq.thongKe.dung ?? '']));
const deTai = ketQua.find(k => k.bt.ma === 'de_tai');
console.log(`\nTuyến của phương án đề tài:\n${tuyenChu(P, deTai.kq)}`);
for (const x of deTai.kq.chuaXep) console.log(`  Chưa xếp ${P.don[x.don].ma}: ${x.lyDo}`);

// 2. Thử giới hạn thời lượng chuyến (đề tài chưa có ràng buộc này).
const gh = Number(lay('--gioi-han-phut') ?? 45);
const Pgh = taoBaiToan(kb, mtKH, { gioiHanChuyenGiay: gh * 60 });
console.log(`\n2. THỬ GIỚI HẠN MỖI CHUYẾN ≤ ${gh} PHÚT DI CHUYỂN`);
const ketQuaGh = BIEN_THE.filter(b => ['de_tai', 'regret', 'kmedoids', 'ils'].includes(b.ma)).map(bt => {
  const kq = bt.chay(Pgh); return { bt, kq, tt: tomTat(Pgh, kq) };
});
bang(['Biến thể', 'T (phút)', 'Chuyến dài nhất', 'Số xe', 'Chưa xếp'],
  ketQuaGh.map(({ bt, tt }) => [bt.ten, phut(tt.T), phut(tt.chuyenDaiNhat), tt.soXe, tt.chuaXep]));

// 3. Điều chỉnh tuyến khi giao thông thay đổi (mục 3.4.5–3.4.7).
let doiTuyen = [];
if (fileDoi) {
  const mtDoi = docJson(fileDoi);
  const Pdoi = taoBaiToan(kb, mtDoi);
  console.log(`\n3. GIAO THÔNG THAY ĐỔI: kế hoạch theo ${mtKH.nhan}, đánh giá lại theo ${mtDoi.nhan}`);
  console.log('   Mỗi xe đã giao khoảng 1/3 số điểm, đang đứng tại điểm vừa giao; điểm kế tiếp bị khóa.');
  // Lập kế hoạch có giới hạn thời lượng để có nhiều chuyến hơn, giống thực tế điều phối.
  const keHoach = ketQuaGh.find(k => k.bt.ma === 'de_tai').kq;
  keHoach.tuyen.forEach((r, v) => {
    if (r.length < 3) return;
    const daGiao = Math.max(1, Math.floor(r.length / 3));
    const viTri = P.don[r[daGiao - 1]].diem;
    const conLai = r.slice(daGiao);
    const kq = danhGiaDoiTuyen(P, Pdoi, v, viTri, conLai);
    doiTuyen.push({ xe: P.xe[v].ma, daGiao, conLai: conLai.length, ...kq, tuyenCu: conLai.map(o => P.don[o].ma), tuyenMoiMa: kq.tuyenMoi?.map(o => P.don[o].ma) });
  });
  bang(['Xe', 'Đã giao', 'Còn lại', 'Chặng chung: trước → sau', 'Kích hoạt', 'T (phút)', "T' (phút)", 'G (giây)', 'G ≥ max(60, 5%T)'],
    doiTuyen.map(d => [d.xe, d.daGiao, d.conLai, `${d.cu} → ${d.moi} s (${d.tang >= 0 ? '+' : ''}${soVN(d.cu ? d.tang / d.cu * 100 : 0)}%)`,
      d.kichHoat ? 'có' : 'không', d.ngoaiLe ? '–' : phut(d.T), d.ngoaiLe ? '–' : phut(d.T2), d.ngoaiLe ?? d.G, d.ngoaiLe ? '–' : (d.datNguong ? 'đạt' : 'không')]));
  for (const d of doiTuyen.filter(d => d.G > 0))
    console.log(`  ${d.xe}: ${d.tuyenCu.join(' → ')}\n   ⇒  ${d.tuyenMoiMa.join(' → ')}`);
}

mkdirSync(join(ROOT, 'ket_qua'), { recursive: true });
const ten = `so_sanh_${fileKH.replace(/^ma_tran_|\.json$/g, '')}.json`;
writeFileSync(join(ROOT, 'ket_qua', ten), JSON.stringify({
  ma_tran: fileKH, ma_tran_doi: fileDoi,
  lap_ke_hoach: ketQua.map(({ bt, kq, tt }) => ({ bien_the: bt.ten, ...tt, thong_ke: kq.thongKe, tuyen: kq.tuyen.map(r => r.map(o => P.don[o].ma)) })),
  gioi_han_chuyen_phut: gh,
  co_gioi_han: ketQuaGh.map(({ bt, tt }) => ({ bien_the: bt.ten, T: tt.T, chuyenDaiNhat: tt.chuyenDaiNhat, soXe: tt.soXe, chuaXep: tt.chuaXep })),
  doi_tuyen: doiTuyen,
}, null, 2));
console.log(`\nĐã lưu ket_qua/${ten}`);
