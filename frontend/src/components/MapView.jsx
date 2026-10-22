// Bản đồ Leaflet: kho, điểm dừng, đường tuyến và vị trí xe.
// Leaflet nhận tọa độ theo thứ tự [vĩ độ, kinh độ]; GeoJSON từ Backend là [kinh độ, vĩ độ] nên phải đảo khi vẽ (mục 2.5.3).
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'

const DA_NANG = [16.0544, 108.2022]
let tileSource = null

function icon(html, size) {
  return L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
}
// Leaflet gán nội dung tooltip dạng chuỗi bằng innerHTML, nên tên người nhận, tên kho phải được thoát ký tự HTML
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const STOP_COLORS = { done: '#2b7a3b', failed: '#c0392b' }
const WAREHOUSE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z"/><path d="M6 18h12"/><path d="M6 14h12"/><rect width="12" height="12" x="6" y="10"/></svg>'
const VEHICLE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>'

/**
 * depot:    { lat, lon }
 * routes:   [{ points: [[lat, lon]], color, dashed, opacity, weight }]
 * stops:    [{ lat, lon, label, color, state }]  state done | failed thì đổi màu
 * vehicles: [{ lat, lon, color, label, stale }]
 * pin:      { lat, lon } điểm đang chọn (tạo đơn)
 * fitKey:   đổi giá trị này thì bản đồ căn lại khung nhìn; tải lại dữ liệu theo chu kỳ thì không căn lại
 */
export default function MapView({ height = 480, depot, routes = [], stops = [], vehicles = [], pin, onClick, fitKey, children }) {
  const box = useRef(null)
  const map = useRef(null)
  const layer = useRef(null)
  const fitted = useRef(null)
  const click = useRef(onClick)
  useEffect(() => { click.current = onClick })

  useEffect(() => {
    const m = L.map(box.current, { zoomControl: true, attributionControl: true }).setView(DA_NANG, 13)
    map.current = m
    layer.current = L.layerGroup().addTo(m)
    m.on('click', e => click.current?.({ lat: e.latlng.lat, lon: e.latlng.lng }))
    const addTiles = src => {
      // Lần tải nguồn ô bản đồ có thể xong sau khi bản đồ đã bị gỡ (ví dụ khi chuyển trang)
      if (map.current !== m) return
      L.tileLayer('/api/map/tiles/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: src === 'tomtom' ? '© TomTom' : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(m)
    }
    if (tileSource) addTiles(tileSource)
    else fetch('/api/map/source').then(r => r.json()).then(d => { tileSource = d.tiles; addTiles(tileSource) }).catch(() => addTiles('openstreetmap'))
    return () => { m.remove(); map.current = null }
  }, [])

  useEffect(() => {
    // Effect tạo bản đồ ở trên chạy trước effect này trong cùng lần gắn, nên map.current đã có
    if (!map.current) return
    const g = layer.current
    g.clearLayers()
    const bounds = []
    for (const r of routes) {
      if (!r.points?.length) continue
      L.polyline(r.points, { color: r.color, weight: r.weight ?? 4, opacity: r.opacity ?? 0.9, dashArray: r.dashed ? '8 8' : null }).addTo(g)
      bounds.push(...r.points)
    }
    for (const s of stops) {
      const bg = STOP_COLORS[s.state] || s.color || '#1f5fae'
      L.marker([s.lat, s.lon], { icon: icon(`<div class="marker-stop" style="background:${bg}">${esc(s.label)}</div>`, 26), title: s.title })
        .addTo(g).bindTooltip(esc(s.title || s.label))
      bounds.push([s.lat, s.lon])
    }
    if (depot) {
      L.marker([depot.lat, depot.lon], { icon: icon(`<div class="marker-depot">${WAREHOUSE_SVG}</div>`, 30), zIndexOffset: 500 })
        .addTo(g).bindTooltip(esc(depot.name || 'Kho'))
      bounds.push([depot.lat, depot.lon])
    }
    for (const v of vehicles) {
      L.marker([v.lat, v.lon], { icon: icon(`<div class="marker-vehicle${v.stale ? ' stale' : ''}" style="background:${v.color}">${VEHICLE_SVG}</div>`, 34), zIndexOffset: 1000 })
        .addTo(g).bindTooltip(esc(v.label || 'Xe'), { permanent: Boolean(v.label), direction: 'top', offset: [0, -16] })
      bounds.push([v.lat, v.lon])
    }
    if (pin) {
      L.marker([pin.lat, pin.lon], { icon: L.divIcon({ html: '<div class="marker-pin"></div>', className: '', iconSize: [28, 28], iconAnchor: [14, 28] }) }).addTo(g)
      bounds.push([pin.lat, pin.lon])
    }
    const key = fitKey ?? 'once'
    if (fitted.current !== key && bounds.length) {
      fitted.current = key
      if (bounds.length === 1) map.current.setView(bounds[0], 15)
      else map.current.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 })
    }
  }, [depot, routes, stops, vehicles, pin, fitKey])

  return (
    <div className="map" style={{ height }}>
      <div ref={box} style={{ position: 'absolute', inset: 0 }} />
      {children}
    </div>
  )
}

export function MapOverlay({ position = 'top-left', children }) {
  const pos = {
    'top-left': { top: 12, left: 52 }, 'top-right': { top: 12, right: 12 },
    'bottom-left': { bottom: 12, left: 12 }, 'bottom-right': { bottom: 24, right: 12 },
  }[position]
  return <div className="map-overlay" style={pos}>{children}</div>
}

export function Legend({ items }) {
  return (
    <div className="map-legend">
      {items.map(it => (
        <span key={it.label} className="row" style={{ gap: 6 }}>
          {it.line
            ? <span style={{ width: 22, height: 0, borderTop: `4px ${it.dashed ? 'dashed' : 'solid'} ${it.color}`, opacity: it.opacity ?? 1 }} />
            : <span className="dot" style={{ background: it.color }} />}
          {it.label}
        </span>
      ))}
    </div>
  )
}
