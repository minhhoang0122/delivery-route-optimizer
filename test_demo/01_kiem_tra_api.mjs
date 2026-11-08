// Kiểm tra TomTom API theo các yêu cầu trong báo cáo. Chạy: node 01_kiem_tra_api.mjs
// Một lần chạy dùng khoảng 75 request Routing, 1 request Search và 1 ô bản đồ.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TomTom, ROOT, CHUNG, CAU_HINH, loiTomTom, phanLoai, truyVanTuyen, khoangCachM,
  phutGiay, soVN, ngayLamViecKeTiep, departAt, nhanFile,
} from './lib/tomtom.mjs';

// Kho theo dữ liệu mẫu D07; các điểm còn lại là địa danh có tọa độ gần đúng ở bốn khu vực giao hàng.
const P = {
  KHO: { ten: 'Kho Hải Châu', vt: [16.0544, 108.2022] },
  A: { ten: 'Chợ Hàn (Hải Châu)', vt: [16.0681, 108.2244] },
  B: { ten: 'Biển Phạm Văn Đồng (Sơn Trà)', vt: [16.0722, 108.2465] },
  C: { ten: 'Ngũ Hành Sơn', vt: [16.0036, 108.2635] },
  D: { ten: 'ĐH Bách khoa (Liên Chiểu)', vt: [16.0738, 108.1500] },
};
const BIEN = [16.2000, 108.6000]; // giữa biển, không có đường

const api = new TomTom();
const kq = [];
const raw = {};
const ghi = (ma, ten, muc, ket, chiTiet) => {
  kq.push({ ma, ten, muc, ket, chiTiet });
  console.log(`[${ket.padEnd(9)}] ${ma} ${ten} (${muc})\n            ${chiTiet}`);
};
const loi = ({ status, data }) => `HTTP ${status} – ${phanLoai(status).loai}: ${loiTomTom(data)}`;
const tomTat = s => `${soVN(s.lengthInMeters / 1000)} km · ${phutGiay(s.travelTimeInSeconds)}`;
const diemCuaTuyen = r => r.legs.flatMap(l => l.points.map(p => [p.latitude, p.longitude]));

/** Tổng chiều dài các đoạn mà TomTom báo travelMode "other" (chế độ xe không áp dụng được). */
function doDaiOther(r) {
  const pts = diemCuaTuyen(r);
  let m = 0;
  for (const s of r.sections ?? []) {
    if (s.sectionType !== 'TRAVEL_MODE' || s.travelMode !== 'other') continue;
    for (let i = s.startPointIndex; i < s.endPointIndex; i++) m += khoangCachM(pts[i], pts[i + 1]);
  }
  return m;
}

async function main() {
  console.log(`KIỂM TRA TOMTOM API – ${new Date().toLocaleString('vi-VN')}\n`);

  // T10 chạy trước: không cần khóa đúng, chỉ cần mạng tới api.tomtom.com.
  const sai = await api.tuyen([P.KHO.vt, P.A.vt], { ...CHUNG, travelMode: 'car' }, { key: 'khoa-sai-de-kiem-tra' });
  api.dem.routing -= 1;
  if (sai.status === 403 || sai.status === 401) ghi('T10', 'Khóa sai bị từ chối', '2.4.3', 'ĐẠT', `HTTP ${sai.status}, phân loại "${phanLoai(sai.status).loai}" nên không thử lại`);
  else ghi('T10', 'Khóa sai bị từ chối', '2.4.3', sai.status === 0 ? 'LỖI' : 'CẦN XEM', loi(sai));
  if (sai.status === 0) return console.log('\nKhông kết nối được tới api.tomtom.com, dừng kiểm tra.');
  if (!api.key) return console.log('\nChưa có khóa: đặt TOMTOM_API_KEY trong file .env rồi chạy lại.');

  // T01 + T02: khóa, kết nối, dữ liệu giao thông.
  const r1 = await api.tuyen([P.KHO.vt, P.A.vt], { ...CHUNG, travelMode: 'car', computeTravelTimeFor: 'all' });
  if (r1.status !== 200) {
    ghi('T01', 'Khóa API và kết nối', '2.4.1', 'LỖI', loi(r1));
    return;
  }
  const route1 = r1.data.routes[0];
  const s1 = route1.summary;
  raw.T01 = s1;
  const pts1 = diemCuaTuyen(route1);
  const lech = Math.max(khoangCachM(P.KHO.vt, pts1[0]), khoangCachM(P.A.vt, pts1.at(-1)));
  ghi('T01', 'Khóa API và kết nối (Kho → Chợ Hàn, car)', '2.4.1', lech <= 200 ? 'ĐẠT' : 'CẦN XEM',
    `${tomTat(s1)} · phản hồi ${Math.round(r1.ms)} ms · điểm bám đường lệch tối đa ${Math.round(lech)} m`);
  const coLive = s1.liveTrafficIncidentsTravelTimeInSeconds != null;
  ghi('T02', 'Dữ liệu giao thông tại Đà Nẵng', '2.4.3', coLive ? 'ĐẠT' : 'CẦN XEM',
    `không kẹt xe ${s1.noTrafficTravelTimeInSeconds} s · lịch sử ${s1.historicTrafficTravelTimeInSeconds} s · ` +
    `trực tiếp ${s1.liveTrafficIncidentsTravelTimeInSeconds} s · trễ do giao thông ${s1.trafficDelayInSeconds} s ` +
    `(${new Date().toLocaleTimeString('vi-VN')}, trễ 0 s có thể chỉ do đường đang thông thoáng)`);

  // T03: đảo thứ tự tọa độ.
  const r3 = await api.tuyen([[P.KHO.vt[1], P.KHO.vt[0]], [P.A.vt[1], P.A.vt[0]]], { ...CHUNG, travelMode: 'car' });
  ghi('T03', 'Gửi nhầm thứ tự kinh độ, vĩ độ', '2.1.1', r3.status === 400 ? 'ĐẠT' : 'CẦN XEM',
    r3.status === 400 ? `bị từ chối ngay (vĩ độ 108 không hợp lệ): ${loiTomTom(r3.data)}` : loi(r3));

  // T04, T05: xe máy (beta) và xe tải nhỏ so với ô tô trên chặng qua sông Hàn.
  const kb = [P.KHO.vt, P.B.vt];
  const car = await api.tuyen(kb, { ...CHUNG, travelMode: 'car' });
  const sCar = car.status === 200 ? car.data.routes[0].summary : null;
  for (const [ma, ten, cfg] of [['T04', 'Xe máy – motorcycle (beta)', 'motorcycle'], ['T05', 'Xe tải nhỏ – truck', 'truck']]) {
    const r = await api.tuyen(kb, { ...CHUNG, ...CAU_HINH[cfg], sectionType: 'travelMode' });
    if (r.status !== 200) { ghi(ma, `${ten}, Kho → Sơn Trà`, '2.4.1', 'LỖI', loi(r)); continue; }
    const route = r.data.routes[0];
    raw[ma] = route.summary;
    const other = doDaiOther(route);
    const tile = other / route.summary.lengthInMeters;
    const soSanh = sCar ? ` · ô tô ${tomTat(sCar)}` : '';
    ghi(ma, `${ten}, Kho → Sơn Trà`, '2.4.1', tile < 0.01 ? 'ĐẠT' : 'CẦN XEM',
      `${tomTat(route.summary)}${soSanh} · đoạn chế độ "other" ${Math.round(other)} m (${soVN(tile * 100)}%)`);
  }

  // T06: giữ nguyên thứ tự điểm khi computeBestOrder=false.
  const thuTu = [P.KHO, P.A, P.B, P.C, P.KHO];
  const r6 = await api.tuyen(thuTu.map(p => p.vt), { ...CHUNG, ...CAU_HINH.motorcycle });
  if (r6.status !== 200) ghi('T06', 'Giữ thứ tự điểm Kho → A → B → C → Kho', '3.4.2', 'LỖI', loi(r6));
  else {
    const legs = r6.data.routes[0].legs;
    const sai6 = legs.map((l, i) => khoangCachM(l.points.at(-1) ? [l.points.at(-1).latitude, l.points.at(-1).longitude] : [0, 0], thuTu[i + 1].vt));
    const dung = legs.length === 4 && sai6.every(m => m <= 300) && !r6.data.optimizedWaypoints;
    ghi('T06', 'Giữ thứ tự điểm Kho → A → B → C → Kho', '3.4.2', dung ? 'ĐẠT' : 'CẦN XEM',
      `${legs.length} chặng, điểm cuối mỗi chặng lệch tối đa ${Math.round(Math.max(...sai6))} m, ` +
      `${r6.data.optimizedWaypoints ? 'CÓ' : 'không có'} optimizedWaypoints · ${tomTat(r6.data.routes[0].summary)}`);
  }

  // T07, T08: Batch Routing 5 điểm × 3 cấu hình (car để đối chiếu xe máy) + 1 mục lỗi cố ý.
  const ma = ['KHO', 'A', 'B', 'C', 'D'];
  const cfgs = { car: { travelMode: 'car' }, ...CAU_HINH };
  const muc = [];
  for (const cfg of Object.keys(cfgs))
    for (const i of ma) for (const j of ma)
      if (i !== j) muc.push({ cfg, i, j, q: truyVanTuyen([P[i].vt, P[j].vt], { ...CHUNG, ...cfgs[cfg], routeRepresentation: 'summaryOnly' }) });
  muc.push({ cfg: 'motorcycle', i: 'KHO', j: 'BIỂN', q: truyVanTuyen([P.KHO.vt, BIEN], { ...CHUNG, ...CAU_HINH.motorcycle, routeRepresentation: 'summaryOnly' }) });
  const t0 = performance.now();
  const ketBatch = await api.batch(muc.map(m => m.q), { thuLai: 0 });
  const msBatch = performance.now() - t0;
  const okTot = ketBatch.slice(0, -1).filter(x => x.statusCode === 200).length;
  const cuoi = ketBatch.at(-1);
  const mt = { car: {}, motorcycle: {}, truck: {} };
  const md = { car: {}, motorcycle: {}, truck: {} };
  muc.forEach((m, k) => {
    if (ketBatch[k].statusCode !== 200) return;
    mt[m.cfg][`${m.i}>${m.j}`] = ketBatch[k].summary.travelTimeInSeconds;
    md[m.cfg][`${m.i}>${m.j}`] = ketBatch[k].summary.lengthInMeters;
  });
  raw.T07 = { thoi_gian: mt, quang_duong: md };

  // T04b: xe máy có khác ô tô ở khu vực thử nghiệm hay không.
  const cap = Object.keys(mt.motorcycle);
  // Khác đáng kể: lệch thời gian > max(5 s, 1%) hoặc lệch quãng đường > 50 m.
  const khac = cap.filter(c => Math.abs(mt.motorcycle[c] - mt.car[c]) > Math.max(5, 0.01 * mt.car[c])
    || Math.abs(md.motorcycle[c] - md.car[c]) > 50);
  const lechMaxXM = Math.max(...cap.map(c => Math.abs(mt.motorcycle[c] - mt.car[c])));
  const tbTruck = cap.reduce((s, c) => s + mt.truck[c] / mt.motorcycle[c], 0) / cap.length;
  ghi('T04b', 'Ma trận xe máy so với ô tô và xe tải (20 cặp)', '2.4.1', khac.length ? 'THÔNG TIN' : 'CẦN XEM',
    `xe máy khác đáng kể so với ô tô ở ${khac.length}/${cap.length} cặp, lệch thời gian lớn nhất ${lechMaxXM} s` +
    `${khac.length ? '' : ' (chế độ motorcycle beta ở khu vực này cho kết quả như ô tô)'}` +
    ` · xe tải chậm hơn xe máy trung bình ${soVN((tbTruck - 1) * 100)}%`);
  ghi('T07', `Batch Routing đồng bộ (${muc.length} mục trong 1 lần gọi)`, '2.4.2',
    okTot === muc.length - 1 && cuoi.statusCode !== 200 ? 'ĐẠT' : 'CẦN XEM',
    `${okTot}/${muc.length - 1} mục hợp lệ thành công, mục cố ý lỗi trả ${cuoi.statusCode} (${cuoi.error}) ` +
    `mà không làm hỏng mục khác · ${Math.round(msBatch)} ms · không có giá trị 0 ngoài đường chéo: ` +
    `${Object.values(mt).every(o => Object.values(o).every(v => v > 0)) ? 'đúng' : 'SAI'}`);

  // T08: tính bất đối xứng của ma trận.
  let lechMax = { d: 0 }, soCap = 0, soLech = 0;
  for (const cfg of Object.keys(CAU_HINH))
    for (let x = 0; x < ma.length; x++) for (let y = x + 1; y < ma.length; y++) {
      const di = mt[cfg][`${ma[x]}>${ma[y]}`], ve = mt[cfg][`${ma[y]}>${ma[x]}`];
      if (di == null || ve == null) continue;
      soCap++;
      const d = Math.abs(di - ve);
      if (d >= Math.max(60, 0.1 * Math.min(di, ve))) soLech++;
      if (d > lechMax.d) lechMax = { d, cfg, cap: `${ma[x]}↔${ma[y]}`, di, ve };
    }
  ghi('T08', 'Thời gian hai chiều khác nhau', '2.1.2', 'THÔNG TIN',
    `${soLech}/${soCap} cặp lệch ≥ max(60 s, 10%) · lệch lớn nhất ${lechMax.cap} (${lechMax.cfg}): ${lechMax.di} s và ${lechMax.ve} s`);

  // T09: chặng không có tuyến.
  const r9 = await api.tuyen([P.KHO.vt, BIEN], { ...CHUNG, ...CAU_HINH.motorcycle });
  ghi('T09', 'Chặng không có tuyến (Kho → giữa biển)', '2.4.3, NFR06', r9.status === 400 ? 'ĐẠT' : 'CẦN XEM',
    r9.status === 400 ? `HTTP 400, nhận diện là "${phanLoai(400).loai}", không thử lại, không gán 0: ${loiTomTom(r9.data)}` : loi(r9));

  // T11: thời điểm khởi hành tương lai (giao thông theo lịch sử).
  const ngay = ngayLamViecKeTiep();
  const gio = ['06:30', '09:30', '12:00', '16:00', '17:30', '20:00'];
  const theoGio = [];
  for (const g of gio) {
    const r = await api.tuyen(kb, { ...CHUNG, ...CAU_HINH.motorcycle, departAt: departAt(ngay, g), routeRepresentation: 'summaryOnly' });
    theoGio.push(r.status === 200 ? `${g} ${r.data.routes[0].summary.travelTimeInSeconds} s` : `${g} lỗi ${r.status}`);
  }
  raw.T11 = theoGio;
  ghi('T11', `departAt theo giờ, xe máy Kho → Sơn Trà, ngày ${ngay}`, '2.4.3, 4.2.4', 'THÔNG TIN', theoGio.join(' · '));

  // T12: bản đồ nền.
  const [lat, lon] = P.KHO.vt, z = 15, n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  const r12 = await api.oBanDo(z, x, y);
  ghi('T12', 'Ô bản đồ nền TomTom (Map Display)', '2.5.3', r12.status === 200 && r12.data.type?.startsWith('image') ? 'ĐẠT' : 'LỖI',
    r12.status === 200 ? `${r12.data.type}, ${r12.data.bytes.length} byte, ${Math.round(r12.ms)} ms` : loi(r12));

  // T13: geocoding một địa chỉ của dữ liệu mẫu.
  const r13 = await api.geocode('45 Lê Duẩn, Hải Châu, Đà Nẵng', P.KHO.vt);
  const g = r13.data?.results?.[0];
  ghi('T13', 'Geocoding địa chỉ mẫu "45 Lê Duẩn, Hải Châu"', '4.2.2', g ? 'ĐẠT' : 'LỖI',
    g ? `${g.address.freeformAddress} → ${g.position.lat}, ${g.position.lon} (loại ${g.type}, độ khớp ${soVN(g.matchConfidence?.score ?? 0, 2)})` : loi(r13));

  // T14: thời gian phản hồi.
  const ds = [...api.thoiGianGoi].sort((a, b) => a - b);
  ghi('T14', 'Thời gian phản hồi của TomTom', 'NFR09', 'THÔNG TIN',
    `${ds.length} lần gọi · trung vị ${Math.round(ds[ds.length >> 1])} ms · lớn nhất ${Math.round(ds.at(-1))} ms`);
}

await main();
const dem = k => kq.filter(x => x.ket === k).length;
console.log(`\nTổng: ${dem('ĐẠT')} đạt, ${dem('CẦN XEM')} cần xem, ${dem('LỖI')} lỗi, ${dem('THÔNG TIN')} thông tin`);
console.log(`Đã dùng: ${api.dem.routing} request Routing, ${api.dem.search} Search, ${api.dem.tile} ô bản đồ`);
mkdirSync(join(ROOT, 'ket_qua'), { recursive: true });
const ten = `kiem_tra_api_${nhanFile()}.json`;
writeFileSync(join(ROOT, 'ket_qua', ten), JSON.stringify({ luc: new Date().toISOString(), ket_qua: kq, du_lieu: raw, dem: api.dem }, null, 2));
console.log(`Đã lưu ket_qua/${ten}`);
