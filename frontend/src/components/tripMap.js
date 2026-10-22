// Chuyển dữ liệu chuyến thành lớp vẽ cho MapView.
import { routeHex } from '../format.js'

const STALE_MS = 30_000

/** Đổi GeoJSON LineString sang mảng [vĩ độ, kinh độ] cho Leaflet (GeoJSON ghi kinh độ trước). */
export const geoToLatLngs = g => (g?.coordinates ? g.coordinates.map(([lon, lat]) => [lat, lon]) : null)

/** Trạng thái hiển thị của điểm dừng: done | failed | next | pending */
export const stopState = (stop, nextStopId) =>
  stop.status === 'delivered' ? 'done' : stop.status === 'failed' ? 'failed' : stop.id === nextStopId ? 'next' : 'pending'

export const CONGESTION_HEX = '#d92d20'

/** Hướng chạy (độ, 0 là bắc) từ hai điểm cuối khác nhau của vệt di chuyển. */
function heading(trail) {
  if (!trail || trail.length < 2) return undefined
  const [lon2, lat2] = trail[trail.length - 1]
  for (let i = trail.length - 2; i >= 0; i--) {
    const [lon1, lat1] = trail[i]
    if (Math.abs(lat2 - lat1) + Math.abs(lon2 - lon1) < 2e-5) continue
    const r = Math.PI / 180
    const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r)
    const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r)
    return (Math.atan2(y, x) / r + 360) % 360
  }
  return undefined
}

/** Đoạn ùn tắc theo lần đánh giá đổi tuyến gần nhất, vẽ đè lên tuyến. */
export const congestionRoutes = trip => (trip.congestion ?? []).map(c => ({ points: geoToLatLngs({ coordinates: c.points }), color: CONGESTION_HEX, weight: 7, opacity: 0.9 }))

export function tripLayers(trip, { now = Date.now(), opacity = 0.85, label } = {}) {
  const color = routeHex(trip.vehicle.id)
  const depot = [trip.depot.lat, trip.depot.lon]
  const ordered = [...trip.stops].sort((a, b) => a.seq - b.seq)
  const pending = ordered.filter(s => s.status === 'pending')
  const done = ordered.filter(s => s.status !== 'pending')
  const routes = []
  const geom = geoToLatLngs(trip.routeVersion?.geometry)
  const trail = ['in_progress', 'awaiting_reconciliation'].includes(trip.status) && trip.trail?.length > 1 ? geoToLatLngs({ coordinates: trip.trail }) : null
  if (!trail && trip.status === 'in_progress' && done.length) {
    // Chưa có vệt di chuyển: nối kho → các điểm đã xử lý → vị trí xe, màu xám
    const passed = [depot, ...done.map(s => [s.order.lat, s.order.lon])]
    if (trip.position) passed.push([trip.position.lat, trip.position.lon])
    routes.push({ points: passed, color: '#94a3b8', weight: 4, opacity: 0.9 })
  }
  if (geom) {
    routes.push({ points: geom, color, opacity })
  } else {
    const start = trip.status === 'in_progress' && trip.position ? [trip.position.lat, trip.position.lon] : depot
    const list = trip.status === 'in_progress' ? pending : ordered
    routes.push({ points: [start, ...list.map(s => [s.order.lat, s.order.lon]), depot], color, opacity, dashed: !geom })
  }
  routes.push(...congestionRoutes(trip))
  // Vệt di chuyển thật của xe vẽ sau cùng để nằm trên tuyến
  if (trail) routes.push({ points: trail, color: '#64748b', weight: 4, opacity: 0.95 })
  const stops = ordered.map(s => ({
    lat: s.order.lat, lon: s.order.lon, label: s.seq, color,
    state: s.status === 'delivered' ? 'done' : s.status === 'failed' ? 'failed' : 'pending',
    title: `${s.seq}. ${s.order.code} · ${s.order.recipientName}`,
  }))
  const vehicles = trip.position && trip.status === 'in_progress'
    ? [{
      key: trip.id, heading: heading(trip.trail),
      lat: trip.position.lat, lon: trip.position.lon, color,
      stale: now - new Date(trip.position.observedAt).getTime() > STALE_MS,
      label,
    }] : []
  return { routes, stops, vehicles, depot: trip.depot }
}

export const isStale = (position, now = Date.now()) => !position || now - new Date(position.observedAt).getTime() > STALE_MS
