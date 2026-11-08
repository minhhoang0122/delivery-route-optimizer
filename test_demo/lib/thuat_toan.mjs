// Thuật toán phân công và lập tuyến theo mục 3.4 của báo cáo, kèm các biến thể cải tiến để so sánh.
// Không dùng API riêng của Node nên chạy được cả trong Node (03_so_sanh_thuat_toan.mjs) và trình duyệt (web/).
//
// Quy ước: điểm 0 của ma trận là kho; tuyến của xe v là mảng chỉ số đơn theo thứ tự giao;
// thời gian tính bằng giây; null trong ma trận là chặng không có tuyến.

const now = () => performance.now();

/** Ghép kịch bản (kho, xe, đơn) với một đợt ma trận đã ghi thành dữ liệu đầu vào của thuật toán. */
export function taoBaiToan(kichBan, maTran, { gioiHanChuyenGiay = null } = {}) {
  const idx = new Map(maTran.diem.map((d, i) => [d.ma, i]));
  return {
    kho: 0,
    don: kichBan.don.filter(d => idx.has(d.ma)).map(d => ({
      ma: d.ma, diem: idx.get(d.ma), kg: d.khoi_luong_kg, loaiXe: d.loai_xe,
    })),
    xe: kichBan.xe.map(x => ({ ma: x.ma, bienSo: x.bien_so, loai: x.loai, cauHinh: x.cau_hinh, taiKg: x.tai_trong_kg })),
    M: maTran.thoi_gian,
    // Đề tài không có giới hạn thời lượng chuyến; tham số này chỉ dùng để thử nghiệm.
    gioiHanChuyenGiay,
  };
}

/** Bộ sinh số ngẫu nhiên có hạt giống (mulberry32) để các lần chạy tái lập được. */
export function taoNgauNhien(hatGiong = 1) {
  let s = hatGiong >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const chang = (M, a, b) => (a === b ? 0 : M[a][b]);
const hopLoai = (P, v, o) => P.don[o].loaiXe.includes(P.xe[v].loai);
const taiCua = (P, r) => r.reduce((s, o) => s + P.don[o].kg, 0);

/** Thời gian một chuyến: từ `batDau` qua các đơn rồi về kho. Infinity nếu có chặng không hợp lệ. */
export function thoiGianChuyen(P, v, r, batDau = P.kho) {
  const M = P.M[P.xe[v].cauHinh];
  if (!r.length) return batDau === P.kho ? 0 : (chang(M, batDau, P.kho) ?? Infinity);
  let tong = 0, truoc = batDau;
  for (const o of r) {
    const t = chang(M, truoc, P.don[o].diem);
    if (t == null) return Infinity;
    tong += t;
    truoc = P.don[o].diem;
  }
  const ve = chang(M, truoc, P.kho);
  return ve == null ? Infinity : tong + ve;
}

export const tongThoiGian = (P, kq) => kq.tuyen.reduce((s, r, v) => s + thoiGianChuyen(P, v, r), 0);

/** Chỉ số tóm tắt của một phương án. */
export function tomTat(P, kq) {
  const chuyen = kq.tuyen.map((r, v) => ({ v, soDon: r.length, kg: taiCua(P, r), giay: thoiGianChuyen(P, v, r) }));
  const dung = chuyen.filter(c => c.soDon);
  return {
    T: dung.reduce((s, c) => s + c.giay, 0),
    chuyenDaiNhat: Math.max(0, ...dung.map(c => c.giay)),
    soXe: dung.length,
    soDonDaXep: dung.reduce((s, c) => s + c.soDon, 0),
    chuaXep: kq.chuaXep.length,
    chuyen,
  };
}

// ---------------------------------------------------------------- Insertion Heuristic (mục 3.4.3)

const LY_DO = {
  loai_xe: 'không có xe phù hợp loại xe',
  vuot_tai: 'vượt tải của mọi xe phù hợp',
  thieu_tuyen: 'thiếu dữ liệu tuyến',
  qua_gio: 'vượt giới hạn thời lượng chuyến',
};
const lyDoChuaXep = lyDo => [...lyDo].filter(x => x !== 'loai_xe' || lyDo.size === 1)
  .map(x => LY_DO[x]).join('; ') || LY_DO.loai_xe;

/** Vị trí chèn có mức tăng ΔT = t(i,u) + t(u,j) − t(i,j) thấp nhất của đơn o trên từng xe được phép. */
function cachChen(P, tuyen, tai, chiPhi, o, xeDuocPhep) {
  const ketQua = [];
  const lyDo = new Set();
  const u = P.don[o].diem;
  for (const v of xeDuocPhep) {
    if (!hopLoai(P, v, o)) { lyDo.add('loai_xe'); continue; }
    if (tai[v] + P.don[o].kg > P.xe[v].taiKg) { lyDo.add('vuot_tai'); continue; }
    const M = P.M[P.xe[v].cauHinh];
    const r = tuyen[v];
    let tot = null;
    for (let p = 0; p <= r.length; p++) {
      const i = p === 0 ? P.kho : P.don[r[p - 1]].diem;
      const j = p === r.length ? P.kho : P.don[r[p]].diem;
      const a = chang(M, i, u), b = chang(M, u, j), c = chang(M, i, j);
      if (a == null || b == null || c == null) { lyDo.add('thieu_tuyen'); continue; }
      const d = a + b - c;
      if (P.gioiHanChuyenGiay && chiPhi[v] + d > P.gioiHanChuyenGiay) { lyDo.add('qua_gio'); continue; }
      if (!tot || d < tot.d) tot = { v, p, d };   // bằng nhau thì giữ vị trí đứng trước
    }
    if (tot) ketQua.push(tot);
  }
  return { ketQua, lyDo };
}

/**
 * Insertion Heuristic. Mặc định xét đơn theo khối lượng giảm dần rồi theo mã đơn, chọn cách chèn
 * có ΔT thấp nhất; bằng nhau thì theo thứ tự xe rồi vị trí.
 *  regret: true  – biến thể Regret-2, ưu tiên đơn mà chèn sai xe sẽ thiệt nhiều nhất
 *  tuyenDau      – tuyến có sẵn để chèn tiếp
 *  xeChoDon(o)   – danh sách xe được phép cho đơn o
 *  thuTuDon      – chỉ xét các đơn này; sapXep=false thì giữ nguyên thứ tự đã cho
 */
export function insertion(P, { regret = false, tuyenDau = null, xeChoDon = null, thuTuDon = null, sapXep = true } = {}) {
  const t0 = now();
  const tuyen = tuyenDau ? tuyenDau.map(r => r.slice()) : P.xe.map(() => []);
  const tai = tuyen.map(r => taiCua(P, r));
  const chiPhi = tuyen.map((r, v) => thoiGianChuyen(P, v, r));
  const tatCaXe = P.xe.map((_, v) => v);
  const daCo = new Set(tuyen.flat());
  let cho = (thuTuDon ?? P.don.map((_, o) => o)).filter(o => !daCo.has(o));
  if (sapXep) cho.sort((a, b) => P.don[b].kg - P.don[a].kg || P.don[a].ma.localeCompare(P.don[b].ma));
  const chuaXep = [];
  const chen = ({ v, p, d }, o) => { tuyen[v].splice(p, 0, o); tai[v] += P.don[o].kg; chiPhi[v] += d; };
  const xet = o => cachChen(P, tuyen, tai, chiPhi, o, xeChoDon?.(o) ?? tatCaXe);

  if (!regret) {
    for (const o of cho) {
      const { ketQua, lyDo } = xet(o);
      const tot = ketQua.reduce((a, b) => (b.d < a.d ? b : a), ketQua[0]);
      if (tot) chen(tot, o); else chuaXep.push({ don: o, lyDo: lyDoChuaXep(lyDo) });
    }
  } else {
    while (cho.length) {
      let chon = null;
      for (const o of cho) {
        const { ketQua, lyDo } = xet(o);
        if (!ketQua.length) { chon = { o, tot: null, lyDo }; break; }
        ketQua.sort((a, b) => a.d - b.d);
        const hoiTiec = ketQua.length > 1 ? ketQua[1].d - ketQua[0].d : Infinity;
        if (!chon || hoiTiec > chon.hoiTiec) chon = { o, tot: ketQua[0], hoiTiec };
      }
      cho = cho.filter(o => o !== chon.o);
      if (chon.tot) chen(chon.tot, chon.o); else chuaXep.push({ don: chon.o, lyDo: lyDoChuaXep(chon.lyDo) });
    }
  }
  return { tuyen, chuaXep, thongKe: { ms: now() - t0, danhGia: 0 } };
}

// ---------------------------------------------------------------- Local Search (mục 3.4.4)

/**
 * Local Search theo Best Improvement: quét mọi phương án lân cận theo thứ tự cố định, áp dụng phương án
 * hợp lệ giảm T nhiều nhất rồi lặp lại. Kiểm tra giới hạn tính toán trước mỗi lần xét một phương án.
 *  phepLanCan: 'relocate', 'swap' (đề tài) và 'oropt', '2opt' (thử thêm)
 *  batDau[v]:  điểm xe v đang đứng (chuyến đang giao), mặc định là kho
 *  khoa[v]:    số đơn đầu tuyến của xe v không được đổi (điểm kế tiếp)
 *  trongTuyen: chỉ đổi thứ tự trong cùng một xe
 */
export function localSearch(P, dau, {
  phepLanCan = ['relocate', 'swap'], toiDaDanhGia = 10_000, toiDaMs = 2_000,
  batDau = null, khoa = null, trongTuyen = false,
} = {}) {
  const t0 = now();
  const tuyen = dau.tuyen.map(r => r.slice());
  const V = tuyen.length;
  const bd = v => batDau?.[v] ?? P.kho;
  const kh = v => khoa?.[v] ?? 0;
  const chiPhi = tuyen.map((r, v) => thoiGianChuyen(P, v, r, bd(v)));
  let danhGia = 0, soBuoc = 0, dung = null;

  const conGioiHan = () => {
    if (danhGia >= toiDaDanhGia) dung = 'đạt giới hạn phép đánh giá';
    else if (now() - t0 >= toiDaMs) dung = 'đạt giới hạn thời gian';
    return !dung;
  };
  const giaTri = (v, r) => {
    if (taiCua(P, r) > P.xe[v].taiKg) return Infinity;
    const c = thoiGianChuyen(P, v, r, bd(v));
    return P.gioiHanChuyenGiay && c > P.gioiHanChuyenGiay ? Infinity : c;
  };
  const boViTri = (r, a, L = 1) => r.slice(0, a).concat(r.slice(a + L));
  const chenVao = (r, b, doan) => r.slice(0, b).concat(doan, r.slice(b));

  // Chuyển một chuỗi L đơn liên tiếp sang vị trí khác (L = 1 là Relocate, L = 2–3 là Or-opt).
  function* chuyenChuoi(L) {
    for (let v1 = 0; v1 < V; v1++) for (let a = kh(v1); a + L <= tuyen[v1].length; a++) {
      const doan = tuyen[v1].slice(a, a + L);
      const bo = boViTri(tuyen[v1], a, L);
      for (let v2 = 0; v2 < V; v2++) {
        if (v2 !== v1 && (trongTuyen || doan.some(o => !hopLoai(P, v2, o)))) continue;
        const goc = v2 === v1 ? bo : tuyen[v2];
        for (let b = kh(v2); b <= goc.length; b++) {
          if (v2 === v1 && b === a) continue;
          const moi = chenVao(goc, b, doan);
          yield v2 === v1 ? [[v1, moi]] : [[v1, bo], [v2, moi]];
        }
      }
    }
  }
  function* swap() {
    for (let v1 = 0; v1 < V; v1++) for (let a = kh(v1); a < tuyen[v1].length; a++) {
      for (let v2 = v1; v2 < V && (!trongTuyen || v2 === v1); v2++) {
        for (let b = v2 === v1 ? a + 1 : kh(v2); b < tuyen[v2].length; b++) {
          const o1 = tuyen[v1][a], o2 = tuyen[v2][b];
          if (v1 === v2) {
            const r = tuyen[v1].slice(); r[a] = o2; r[b] = o1;
            yield [[v1, r]];
          } else if (hopLoai(P, v1, o2) && hopLoai(P, v2, o1)) {
            const r1 = tuyen[v1].slice(); r1[a] = o2;
            const r2 = tuyen[v2].slice(); r2[b] = o1;
            yield [[v1, r1], [v2, r2]];
          }
        }
      }
    }
  }
  // Đảo chiều một đoạn trong tuyến. Ma trận bất đối xứng nên phải tính lại cả các chặng trong đoạn.
  function* haiOpt() {
    for (let v = 0; v < V; v++) {
      const r = tuyen[v];
      for (let i = kh(v); i < r.length - 1; i++) for (let j = i + 1; j < r.length; j++)
        yield [[v, r.slice(0, i).concat(r.slice(i, j + 1).reverse(), r.slice(j + 1))]];
    }
  }
  const SINH = {
    relocate: () => chuyenChuoi(1),
    swap,
    oropt: function* () { yield* chuyenChuoi(2); yield* chuyenChuoi(3); },
    '2opt': haiOpt,
  };

  while (true) {
    let tot = null;
    outer: for (const ten of phepLanCan) {
      for (const thayDoi of SINH[ten]()) {
        if (!conGioiHan()) break outer;
        danhGia++;
        let d = 0;
        const moi = [];
        for (const [v, r] of thayDoi) {
          const c = giaTri(v, r);
          if (c === Infinity) { d = Infinity; break; }
          d += c - chiPhi[v];
          moi.push([v, r, c]);
        }
        if (d < (tot ? tot.d : 0)) tot = { d, moi };
      }
    }
    if (!tot) break;
    for (const [v, r, c] of tot.moi) { tuyen[v] = r; chiPhi[v] = c; }
    soBuoc++;
    if (dung) break;
  }
  return {
    tuyen, chuaXep: dau.chuaXep,
    thongKe: { ms: now() - t0, danhGia, soBuoc, dung: dung ?? 'không còn phương án cải thiện' },
  };
}

const noiTiep = (dau, sau) => ({
  ...sau,
  thongKe: { ...sau.thongKe, ms: dau.thongKe.ms + sau.thongKe.ms, danhGia: dau.thongKe.danhGia + sau.thongKe.danhGia },
});

// ---------------------------------------------------------------- k-medoids: gom cụm trước, lập tuyến sau

/** Khoảng cách đối xứng giữa hai đơn: trung bình hai chiều theo ma trận xe máy. */
function khoangCachDon(P) {
  const M = P.M.motorcycle ?? P.M[P.xe[0].cauHinh];
  return (a, b) => {
    if (a === b) return 0;
    const pa = P.don[a].diem, pb = P.don[b].diem;
    const x = chang(M, pa, pb), y = chang(M, pb, pa);
    return x == null || y == null ? 1e9 : (x + y) / 2;
  };
}

/** k-medoids (lặp Voronoi): mỗi cụm có tâm là một đơn thật, tâm là đơn có tổng khoảng cách nhỏ nhất trong cụm. */
export function kMedoids(P, k, { hatGiong = 1, soVong = 100 } = {}) {
  const n = P.don.length;
  const d = khoangCachDon(P);
  const rand = taoNgauNhien(hatGiong);
  const ds = [...Array(n).keys()];
  const tam = [Math.floor(rand() * n)];
  while (tam.length < Math.min(k, n)) {             // khởi tạo kiểu k-means++
    const w = ds.map(i => Math.min(...tam.map(m => d(i, m))) ** 2);
    let s = rand() * w.reduce((a, b) => a + b, 0), i = 0;
    while (i < n - 1 && (s -= w[i]) > 0) i++;
    tam.push(i);
  }
  let cum = [];
  for (let vong = 0; vong < soVong; vong++) {
    cum = ds.map(i => tam.reduce((tot, m, c) => (d(i, m) < d(i, tam[tot]) ? c : tot), 0));
    let doi = false;
    tam.forEach((m, c) => {
      const tv = ds.filter(i => cum[i] === c);
      if (!tv.length) return;
      const tong = x => tv.reduce((s, y) => s + d(x, y), 0);
      const moi = tv.reduce((a, b) => (tong(b) < tong(a) ? b : a));
      if (moi !== m) { tam[c] = moi; doi = true; }
    });
    if (!doi) break;
  }
  return { tam, cum };
}

/** Gom đơn thành k cụm bằng k-medoids, ghép mỗi cụm với một xe, lập tuyến trong từng xe; đơn không vừa xe của cụm được chèn chung. */
export function clusterFirst(P, { hatGiong = 1, k = P.xe.length } = {}) {
  const t0 = now();
  const { tam, cum } = kMedoids(P, k, { hatGiong });
  const nhom = tam.map((_, c) => {
    const ds = P.don.map((_, o) => o).filter(o => cum[o] === c);
    return { c, kg: taiCua(P, ds), canXeTai: ds.some(o => !P.don[o].loaiXe.includes('xe_may')) };
  }).sort((a, b) => b.canXeTai - a.canXeTai || b.kg - a.kg);
  const xeTheoTai = P.xe.map((_, v) => v).sort((a, b) => P.xe[b].taiKg - P.xe[a].taiKg || a - b);
  const xeCuaCum = new Map(nhom.map((g, i) => [g.c, xeTheoTai[i % xeTheoTai.length]]));
  const lan1 = insertion(P, { xeChoDon: o => [xeCuaCum.get(cum[o])] });
  const lan2 = insertion(P, { tuyenDau: lan1.tuyen, thuTuDon: lan1.chuaXep.map(x => x.don) });
  return { tuyen: lan2.tuyen, chuaXep: lan2.chuaXep, cum: { tam, cum }, thongKe: { ms: now() - t0, danhGia: 0 } };
}

// ---------------------------------------------------------------- ILS: tham chiếu với giới hạn tính toán lớn

/** Iterated Local Search: lặp "bỏ 2–4 đơn ngẫu nhiên, chèn lại, Local Search", giữ phương án tốt nhất. */
export function ils(P, { soLan = 80, hatGiong = 1, toiDaDanhGia = 300_000, phepLanCan = ['relocate', 'swap', 'oropt', '2opt'] } = {}) {
  const t0 = now();
  const rand = taoNgauNhien(hatGiong);
  let danhGia = 0;
  const ls = kq => {
    const r = localSearch(P, kq, { phepLanCan, toiDaDanhGia: Math.max(1, toiDaDanhGia - danhGia), toiDaMs: 60_000 });
    danhGia += r.thongKe.danhGia;
    return r;
  };
  const dau = insertion(P);
  let hienTai = ls(dau), tot = hienTai;
  for (let lan = 0; lan < soLan && danhGia < toiDaDanhGia; lan++) {
    const daXep = hienTai.tuyen.flat();
    const bo = [];
    for (let i = 2 + Math.floor(rand() * 3); i > 0 && daXep.length; i--) bo.push(daXep.splice(Math.floor(rand() * daXep.length), 1)[0]);
    const conLai = hienTai.tuyen.map(r => r.filter(o => !bo.includes(o)));
    const dung = insertion(P, { tuyenDau: conLai, thuTuDon: bo, sapXep: false });
    if (dung.chuaXep.length) continue;
    const moi = ls({ ...dung, chuaXep: dau.chuaXep });
    if (tongThoiGian(P, moi) <= tongThoiGian(P, hienTai)) hienTai = moi;
    if (tongThoiGian(P, moi) < tongThoiGian(P, tot)) tot = moi;
  }
  return { tuyen: tot.tuyen, chuaXep: dau.chuaXep, thongKe: { ms: now() - t0, danhGia, dung: `${soLan} lượt khởi động lại` } };
}

// ---------------------------------------------------------------- Điều chỉnh tuyến đang giao (mục 3.4.5–3.4.7)

/**
 * Đánh giá đổi tuyến cho xe v đang giao.
 *  Pcu, Pmoi: cùng kịch bản với ma trận đợt trước và đợt mới
 *  viTri:     chỉ số điểm trong ma trận nơi xe đang đứng (điểm vừa giao)
 *  conLai:    các đơn chưa giao theo thứ tự hiện hành; phần tử đầu là điểm kế tiếp và bị khóa
 */
export function danhGiaDoiTuyen(Pcu, Pmoi, v, viTri, conLai, { tangTuongDoi = 0.10, tangTuyetDoi = 120 } = {}) {
  // Phát hiện tăng thời gian: chỉ so chặng chung, bỏ chặng xuất phát từ vị trí xe.
  const cfg = Pmoi.xe[v].cauHinh;
  const chuoi = [...conLai.map(o => Pmoi.don[o].diem), Pmoi.kho];
  let cu = 0, moi = 0, soChang = 0;
  for (let i = 0; i + 1 < chuoi.length; i++) {
    const a = chang(Pcu.M[cfg], chuoi[i], chuoi[i + 1]), b = chang(Pmoi.M[cfg], chuoi[i], chuoi[i + 1]);
    if (a == null || b == null) continue;
    cu += a; moi += b; soChang++;
  }
  const tang = moi - cu;
  const kichHoat = soChang > 0 && (tang >= tangTuyetDoi || (cu > 0 && tang / cu >= tangTuongDoi));

  // So sánh hai phương án trên cùng ma trận mới.
  const T = thoiGianChuyen(Pmoi, v, conLai, viTri);
  if (!Number.isFinite(T)) return { kichHoat, cu, moi, tang, ngoaiLe: 'tuyến hiện hành có chặng không hợp lệ' };
  const tuyen = Pmoi.xe.map(() => []);
  tuyen[v] = conLai.slice();
  const kq = localSearch(Pmoi, { tuyen, chuaXep: [] }, {
    batDau: { [v]: viTri }, khoa: { [v]: 1 }, trongTuyen: true,
  });
  const T2 = thoiGianChuyen(Pmoi, v, kq.tuyen[v], viTri);
  const G = T - T2;
  return {
    kichHoat, cu, moi, tang, T, T2, G,
    datNguong: G >= Math.max(60, 0.05 * T),   // điều kiện áp dụng G ≥ max(60, 5% × T)
    tuyenMoi: kq.tuyen[v], danhGia: kq.thongKe.danhGia,
  };
}

// ---------------------------------------------------------------- Các biến thể để so sánh

export const BIEN_THE = [
  { ma: 'insertion', ten: 'Insertion Heuristic', chay: P => insertion(P) },
  {
    ma: 'de_tai', ten: 'Insertion + Relocate/Swap (đề tài)',
    chay: P => { const a = insertion(P); return noiTiep(a, localSearch(P, a)); },
  },
  {
    ma: 'de_tai_khong_gioi_han', ten: 'Như đề tài, bỏ giới hạn 10.000',
    chay: P => { const a = insertion(P); return noiTiep(a, localSearch(P, a, { toiDaDanhGia: 5_000_000, toiDaMs: 60_000 })); },
  },
  {
    ma: 'them_oropt_2opt', ten: 'Insertion + Relocate/Swap/Or-opt/2-opt',
    chay: P => { const a = insertion(P); return noiTiep(a, localSearch(P, a, { phepLanCan: ['relocate', 'swap', 'oropt', '2opt'] })); },
  },
  {
    ma: 'regret', ten: 'Regret-2 + Relocate/Swap',
    chay: P => { const a = insertion(P, { regret: true }); return noiTiep(a, localSearch(P, a)); },
  },
  {
    ma: 'kmedoids', ten: 'k-medoids + Insertion + Relocate/Swap',
    chay: P => { const a = clusterFirst(P); return { ...noiTiep(a, localSearch(P, a)), cum: a.cum }; },
  },
  { ma: 'ils', ten: 'ILS tham chiếu (300.000 phép đánh giá)', chay: P => ils(P) },
];
