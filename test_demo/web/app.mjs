// Giao diện demo: chạy thuật toán ngay trong trình duyệt trên ma trận đã ghi, vẽ đường TomTom qua máy chủ demo.
import { taoBaiToan, tomTat, BIEN_THE, danhGiaDoiTuyen } from '/lib/thuat_toan.mjs';

const MAU = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];
const $ = id => document.getElementById(id);
const phut = s => `${(s / 60).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} phút`;
const thoat = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const docJson = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };

const kb = await docJson('/du_lieu/kich_ban.json');
const donTheoMa = new Map(kb.don.map(d => [d.ma, d]));
const dsMaTran = await docJson('/api/ma-tran');
const maTranDaTai = new Map();
const layMaTran = async f => {
  if (!maTranDaTai.has(f)) maTranDaTai.set(f, await docJson(`/du_lieu/${f}`));
  return maTranDaTai.get(f);
};

// ---- Điều khiển
for (const sel of [$('maTran'), $('maTranDoi')])
  sel.innerHTML = dsMaTran.map(m => `<option value="${thoat(m.file)}">${thoat(m.nhan)}</option>`).join('');
if (dsMaTran.length > 1) $('maTranDoi').selectedIndex = 1;
$('bienThe').innerHTML = BIEN_THE.map(b => `<option value="${b.ma}"${b.ma === 'de_tai' ? ' selected' : ''}>${thoat(b.ten)}</option>`).join('');
$('moTa').textContent = `${kb.kho.ten}, ${kb.kho.dia_chi} · ${kb.don.filter(d => d.lat != null).length} đơn · ${kb.xe.length} xe`;
if (!dsMaTran.length) $('tongQuan').innerHTML = '<p class="loi">Chưa có ma trận. Chạy node 02_ghi_ma_tran.mjs trước.</p>';

// ---- Bản đồ
const map = L.map('banDo').setView([kb.kho.lat, kb.kho.lon], 13);
const nenTomTom = L.tileLayer('/api/o/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© TomTom' });
const nenOSM = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
nenTomTom.addTo(map);
L.control.layers({ 'Bản đồ TomTom': nenTomTom, OpenStreetMap: nenOSM }).addTo(map);
const lopTuyen = L.layerGroup().addTo(map);
const lopDoi = L.layerGroup().addTo(map);
const lopDiem = L.layerGroup().addTo(map);
const icon = (html, cls, size) => L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

function veDiem(P, kq) {
  lopDiem.clearLayers();
  L.marker([kb.kho.lat, kb.kho.lon], { icon: icon('<div class="nhan-kho">K</div>', '', 28), zIndexOffset: 1000 })
    .bindTooltip(`${thoat(kb.kho.ten)}<br>${thoat(kb.kho.dia_chi)}`).addTo(lopDiem);
  const viTri = new Map();
  kq.tuyen.forEach((r, v) => r.forEach((o, k) => viTri.set(o, { v, k })));
  P.don.forEach((d, o) => {
    const goc = donTheoMa.get(d.ma);
    const vt = viTri.get(o);
    const mau = vt ? MAU[vt.v % MAU.length] : '#6b7280';
    L.marker([goc.lat, goc.lon], { icon: icon(`<div class="nhan-diem" style="background:${mau}">${vt ? vt.k + 1 : '–'}</div>`, '', 22) })
      .bindTooltip(`<b>${thoat(d.ma)}</b> · ${thoat(goc.dia_chi)}<br>${d.kg} kg · ${vt ? `${P.xe[vt.v].ma}, điểm ${vt.k + 1}` : 'chưa xếp'}`)
      .addTo(lopDiem);
  });
}

/** Gọi máy chủ demo để lấy đường TomTom qua các điểm theo đúng thứ tự. */
async function duongTomTom(cauHinh, departAt, diem) {
  const r = await fetch('/api/tuyen', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cauHinh, departAt, diem }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.loi || `HTTP ${r.status}`);
  return body;
}
const toaDo = (P, o) => { const d = donTheoMa.get(P.don[o].ma); return [d.lat, d.lon]; };

// ---- Lập kế hoạch
let hienTai = null;

async function lapKeHoach() {
  $('chay').disabled = true;
  lopTuyen.clearLayers(); lopDoi.clearLayers(); $('ketQuaDoi').innerHTML = '';
  try {
    const mt = await layMaTran($('maTran').value);
    const P = taoBaiToan(kb, mt, { gioiHanChuyenGiay: $('coGioiHan').checked ? Number($('gioiHan').value) * 60 : null });
    const bt = BIEN_THE.find(b => b.ma === $('bienThe').value);
    const kq = bt.chay(P);
    const tt = tomTat(P, kq);
    hienTai = { P, kq, mt };
    veDiem(P, kq);
    $('tongQuan').innerHTML = `
      <h2>${thoat(bt.ten)}</h2>
      <div class="so">
        <div><b>${phut(tt.T)}</b><span>Tổng thời gian T</span></div>
        <div><b>${phut(tt.chuyenDaiNhat)}</b><span>Chuyến dài nhất</span></div>
        <div><b>${tt.soXe}/${P.xe.length}</b><span>Xe được dùng</span></div>
      </div>
      <p class="ghi-chu">${kq.thongKe.danhGia.toLocaleString('vi-VN')} phép đánh giá · tính trong ${Math.round(kq.thongKe.ms)} ms
        ${kq.thongKe.dung ? ` · dừng vì ${thoat(kq.thongKe.dung)}` : ''} · ma trận: ${thoat(mt.nhan)}</p>`;
    $('dsChuyen').innerHTML = '<h2>Chuyến</h2>' + tt.chuyen.filter(c => c.soDon).map(c => {
      const x = P.xe[c.v];
      return `<div class="chuyen" id="chuyen${c.v}">
        <div class="dau"><span class="mau" style="background:${MAU[c.v % MAU.length]}"></span>
          ${thoat(x.ma)} · ${thoat(x.bienSo)} · ${x.loai === 'xe_may' ? 'Xe máy' : 'Xe tải nhỏ'}</div>
        <div class="chi-so">${c.soDon} điểm · ${c.kg.toLocaleString('vi-VN')}/${x.taiKg} kg · ${phut(c.giay)} theo ma trận
          · <span class="tomtom">đang lấy đường TomTom…</span></div>
        <div class="thu-tu">KHO → ${kq.tuyen[c.v].map(o => thoat(P.don[o].ma)).join(' → ')} → KHO</div>
      </div>`;
    }).join('');
    $('chuaXep').innerHTML = kq.chuaXep.length
      ? '<h2>Đơn chưa xếp</h2>' + kq.chuaXep.map(x => `<div>${thoat(P.don[x.don].ma)}: ${thoat(x.lyDo)}</div>`).join('') : '';
    $('danhGia').disabled = false;

    // Khung nhìn bao mọi điểm giao; vẽ lần lượt từng chuyến để không vượt QPS của khóa.
    const vung = L.latLngBounds([[kb.kho.lat, kb.kho.lon], ...P.don.map((_, o) => toaDo(P, o))]);
    map.invalidateSize(); map.fitBounds(vung, { padding: [30, 30], maxZoom: 16 });
    for (const c of tt.chuyen.filter(c => c.soDon)) {
      const diem = [[kb.kho.lat, kb.kho.lon], ...kq.tuyen[c.v].map(o => toaDo(P, o)), [kb.kho.lat, kb.kho.lon]];
      const o = document.querySelector(`#chuyen${c.v} .tomtom`);
      try {
        const d = await duongTomTom(P.xe[c.v].cauHinh, mt.departAt, diem);
        L.polyline(d.duong, { color: MAU[c.v % MAU.length], weight: 5, opacity: .8 }).addTo(lopTuyen);
        d.duong.forEach(p => vung.extend(p));
        o.textContent = `TomTom tính cả tuyến: ${phut(d.summary.travelTimeInSeconds)}, ${(d.summary.lengthInMeters / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} km`;
      } catch (e) {
        L.polyline(diem, { color: MAU[c.v % MAU.length], weight: 2, dashArray: '2 6' }).addTo(lopTuyen);
        o.innerHTML = `<span class="loi">không lấy được đường TomTom (${thoat(e.message)})</span>`;
      }
    }
    map.invalidateSize(); map.fitBounds(vung, { padding: [30, 30], maxZoom: 16 });
  } catch (e) {
    $('tongQuan').innerHTML = `<p class="loi">${thoat(e.message)}</p>`;
  } finally {
    $('chay').disabled = false;
  }
}

// ---- Đánh giá đổi tuyến khi giao thông thay đổi (mục 3.4.5–3.4.7)
async function danhGiaDoi() {
  if (!hienTai) return;
  $('danhGia').disabled = true;
  lopDoi.clearLayers();
  try {
    const { P, kq } = hienTai;
    const mtDoi = await layMaTran($('maTranDoi').value);
    const Pdoi = taoBaiToan(kb, mtDoi, { gioiHanChuyenGiay: P.gioiHanChuyenGiay });
    const dong = [];
    for (const [v, r] of kq.tuyen.entries()) {
      if (r.length < 3) continue;
      const daGiao = Math.max(1, Math.floor(r.length / 3));
      const viTri = P.don[r[daGiao - 1]].diem;
      const d = danhGiaDoiTuyen(P, Pdoi, v, viTri, r.slice(daGiao));
      dong.push({ v, daGiao, d });
      if (d.G > 0) {
        const diem = [toaDo(P, r[daGiao - 1]), ...d.tuyenMoi.map(o => toaDo(P, o)), [kb.kho.lat, kb.kho.lon]];
        try {
          const g = await duongTomTom(P.xe[v].cauHinh, mtDoi.departAt, diem);
          L.polyline(g.duong, { color: MAU[v % MAU.length], weight: 4, dashArray: '8 8', opacity: .95 }).addTo(lopDoi);
        } catch { /* bảng kết quả vẫn hiển thị khi không vẽ được */ }
      }
    }
    $('ketQuaDoi').innerHTML = dong.length ? `
      <table>
        <tr><th>Xe</th><th>Chặng chung</th><th>Kích hoạt</th><th>T</th><th>T'</th><th>G</th><th>Áp dụng</th></tr>
        ${dong.map(({ v, d }) => `<tr>
          <td>${thoat(P.xe[v].ma)}</td>
          <td>${d.tang >= 0 ? '+' : ''}${d.tang} s</td>
          <td>${d.kichHoat ? 'có' : 'không'}</td>
          <td>${d.ngoaiLe ? '–' : phut(d.T)}</td><td>${d.ngoaiLe ? '–' : phut(d.T2)}</td>
          <td>${d.ngoaiLe ? thoat(d.ngoaiLe) : `${d.G} s`}</td>
          <td class="${d.datNguong ? 'dat' : 'khong'}">${d.datNguong ? 'đạt' : 'giữ tuyến'}</td></tr>`).join('')}
      </table>
      <p class="ghi-chu">Ma trận mới: ${thoat(mtDoi.nhan)}. Kích hoạt khi thời gian các chặng chung tăng ≥ 10% hoặc ≥ 120 giây.</p>`
      : '<p class="ghi-chu">Không có chuyến nào từ 3 điểm trở lên để đánh giá.</p>';
  } catch (e) {
    $('ketQuaDoi').innerHTML = `<p class="loi">${thoat(e.message)}</p>`;
  } finally {
    $('danhGia').disabled = false;
  }
}

$('chay').addEventListener('click', lapKeHoach);
$('danhGia').addEventListener('click', danhGiaDoi);
if (dsMaTran.length) lapKeHoach();
