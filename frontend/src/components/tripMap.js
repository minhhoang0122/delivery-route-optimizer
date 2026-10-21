// Chuyển dữ liệu chuyến thành lớp vẽ cho MapView.
import { routeHex } from '../format.js'

const STALE_MS = 30_000

/** Đổi GeoJSON LineString sang mảng [vĩ độ, kinh độ] cho Leaflet (GeoJSON ghi kinh độ trước). */
export const geoToLatLngs = g => (g?.coordinates ? g.coordinates.map(([lon, lat]) => [lat, lon]) : null)

/** Trạng thái hiển thị của điểm dừng: done | failed | next | pending */
export const stopState = (stop, nextStopId) =>
  stop.status === 'delivered' ? 'done' : stop.status === 'failed' ? 'failed' : stop.id === nextStopId ? 'next' : 'pending'

export function tripLayers(trip, { now = Date.now(), opacity = 0.85, label } = {}) {
  const color = routeHex(trip.vehicle.id)
  const depot = [trip.depot.lat, trip.depot.lon]
  const ordered = [...trip.stops].sort((a, b) => a.seq - b.seq)
  const pending = ordered.filter(s => s.status === 'pending')
  const done = ordered.filter(s => s.status !== 'pending')
  const routes = []
  const geom = geoToLatLngs(trip.routeVersion?.geometry)
  if (trip.status === 'in_progress' && done.length) {
    // Phần đã đi qua: kho → các điểm đã xử lý → vị trí xe, màu xám
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
  const stops = ordered.map(s => ({
    lat: s.order.lat, lon: s.order.lon, label: s.seq, color,
    state: s.status === 'delivered' ? 'done' : s.status === 'failed' ? 'failed' : 'pending',
    title: `${s.seq}. ${s.order.code} · ${s.order.recipientName}`,
  }))
  const vehicles = trip.position && trip.status === 'in_progress'
    ? [{
      lat: trip.position.lat, lon: trip.position.lon, color,
      stale: now - new Date(trip.position.observedAt).getTime() > STALE_MS,
      label,
    }] : []
  return { routes, stops, vehicles, depot: trip.depot }
}

export const isStale = (position, now = Date.now()) => !position || now - new Date(position.observedAt).getTime() > STALE_MS
