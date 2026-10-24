// Bản đồ Leaflet: kho, điểm dừng, đường tuyến và vị trí xe.
// Leaflet nhận tọa độ theo thứ tự [vĩ độ, kinh độ]; GeoJSON từ Backend là [kinh độ, vĩ độ] nên phải đảo khi vẽ (mục 2.5.3).
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import { LIVE_MS } from '../hooks.js'

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
 * routes:   [{ points: [[lat, lon]], color, dashed, dotted, opacity, weight }]
 * stops:    [{ lat, lon, label, color, state }]  state done | failed thì đổi màu
 * vehicles: [{ key, lat, lon, color, label, stale, heading }]  xe cùng key trượt từ vị trí cũ sang vị trí mới
 * pin:      { lat, lon } điểm đang chọn (tạo đơn)
 * fitKey:   đổi giá trị này thì bản đồ căn lại khung nhìn; tải lại dữ liệu theo chu kỳ thì không căn lại
 */
export default function MapView({ height = 480, depot, routes = [], stops = [], vehicles = [], pin, onClick, fitKey, children }) {
  const box = useRef(null)
  const map = useRef(null)
  const layer = useRef(null)
  const carLayer = useRef(null)
  const cars = useRef(new Map())
  const fitted = useRef(null)
  // Chữ ký của lớp tĩnh (tuyến, điểm dừng, kho, ghim) đã vẽ: trang vẽ lại mỗi giây (đồng hồ "x giây trước")
  // nhưng dữ liệu không đổi thì không xóa và vẽ lại
  const drawn = useRef(null)
  const click = useRef(onClick)
  useEffect(() => { click.current = onClick })

  useEffect(() => {
    const m = L.map(box.current, { zoomControl: true, attributionControl: true }).setView(DA_NANG, 13)
    map.current = m
    layer.current = L.layerGroup().addTo(m)
    carLayer.current = L.layerGroup().addTo(m)
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
    const carMap = cars.current
    return () => {
      for (const c of carMap.values()) cancelAnimationFrame(c.frame)
      carMap.clear()
      // Dừng hiệu ứng zoom đang chạy trước khi gỡ, nếu không Leaflet báo lỗi _leaflet_pos khi rời trang giữa lúc căn khung
      m.stop(); m.remove(); map.current = null
      // StrictMode gắn lại bản đồ mới: phải vẽ và căn khung nhìn lại từ đầu
      fitted.current = null
      drawn.current = null
    }
  }, [])

  useEffect(() => {
    // Effect tạo bản đồ ở trên chạy trước effect này trong cùng lần gắn, nên map.current đã có
    if (!map.current) return
    const g = layer.current
    const bounds = []
    for (const r of routes) if (r.points?.length) bounds.push(...r.points)
    for (const s of stops) bounds.push([s.lat, s.lon])
    if (depot) bounds.push([depot.lat, depot.lon])
    const sig = JSON.stringify([
      routes.map(r => [r.points, r.color, r.weight, r.opacity, r.dashed, r.dotted]),
      stops.map(s => [s.lat, s.lon, s.label, s.title, s.color, s.state]),
      depot && [depot.lat, depot.lon, depot.name],
      pin && [pin.lat, pin.lon],
    ])
    if (drawn.current !== sig) {
      drawn.current = sig
      g.clearLayers()
      for (const r of routes) {
        if (!r.points?.length) continue
        L.polyline(r.points, { color: r.color, weight: r.weight ?? 4, opacity: r.opacity ?? 0.9, dashArray: r.dotted ? '1 8' : r.dashed ? '8 8' : null }).addTo(g)
      }
      for (const s of stops) {
        const bg = STOP_COLORS[s.state] || s.color || '#1f5fae'
        L.marker([s.lat, s.lon], { icon: icon(`<div class="marker-stop" style="background:${bg}">${esc(s.label)}</div>`, 26), title: s.title })
          .addTo(g).bindTooltip(esc(s.title || s.label))
      }
      if (depot) {
        L.marker([depot.lat, depot.lon], { icon: icon(`<div class="marker-depot">${WAREHOUSE_SVG}</div>`, 30), zIndexOffset: 500 })
          .addTo(g).bindTooltip(esc(depot.name || 'Kho'))
      }
      if (pin) {
        L.marker([pin.lat, pin.lon], { icon: L.divIcon({ html: '<div class="marker-pin"></div>', className: '', iconSize: [28, 28], iconAnchor: [14, 28] }) }).addTo(g)
      }
    }
    // Xe giữ nguyên marker giữa các lần tải lại và trượt tới vị trí mới, mũi tên xoay theo hướng chạy
    const seen = new Set()
    vehicles.forEach((v, i) => {
      const key = v.key ?? i
      seen.add(key)
      // Mũi tên gốc chỉ hướng đông bắc (45°)
      const html = `<div class="marker-vehicle${v.stale ? ' stale' : ''}" style="background:${v.color}"><span style="display:grid;transform:rotate(${(v.heading ?? 45) - 45}deg)">${VEHICLE_SVG}</span></div>`
      const to = L.latLng(v.lat, v.lon)
      let c = cars.current.get(key)
      if (!c) {
        const marker = L.marker(to, { icon: icon(html, 34), zIndexOffset: 1000 }).addTo(carLayer.current)
          .bindTooltip(esc(v.label || 'Xe'), { permanent: Boolean(v.label), direction: 'top', offset: [0, -16] })
        c = { marker, html, frame: 0, target: to }
        cars.current.set(key, c)
      } else {
        if (c.html !== html) { c.marker.setIcon(icon(html, 34)); c.html = html }
        c.marker.setTooltipContent(esc(v.label || 'Xe'))
        // Vị trí không đổi (chỉ đồng hồ trên trang chạy): để xe trượt tiếp tới đích cũ, không bắt đầu lại
        if (c.target.equals(to)) { bounds.push([v.lat, v.lon]); return }
        c.target = to
        cancelAnimationFrame(c.frame)
        const from = c.marker.getLatLng()
        const ms = Math.min(LIVE_MS, 3000)
        const t0 = performance.now()
        const step = now => {
          const k = Math.min(1, (now - t0) / ms)
          c.marker.setLatLng([from.lat + (to.lat - from.lat) * k, from.lng + (to.lng - from.lng) * k])
          if (k < 1) c.frame = requestAnimationFrame(step)
        }
        c.frame = requestAnimationFrame(step)
      }
      bounds.push([v.lat, v.lon])
    })
    for (const [key, c] of cars.current) {
      if (seen.has(key)) continue
      cancelAnimationFrame(c.frame)
      c.marker.remove()
      cars.current.delete(key)
    }
    if (pin) bounds.push([pin.lat, pin.lon])
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
            ? <span style={{ width: 22, height: 0, borderTop: `${it.dotted ? 3 : 4}px ${it.dotted ? 'dotted' : it.dashed ? 'dashed' : 'solid'} ${it.color}`, opacity: it.opacity ?? 1 }} />
            : <span className="dot" style={{ background: it.color }} />}
          {it.label}
        </span>
      ))}
    </div>
  )
}
