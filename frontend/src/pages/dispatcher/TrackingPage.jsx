// D10 Theo dõi chuyến giao (UC06): vị trí cập nhật theo chu kỳ, kèm thời điểm ghi nhận.
import { ChevronRight, LocateFixed, Navigation, Route, TriangleAlert } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { api } from '../../api.js'
import MapView, { Legend, MapOverlay } from '../../components/MapView.jsx'
import { CONGESTION_HEX, isStale, NO_ROAD_LEGEND, staleAfter, tripLayers } from '../../components/tripMap.js'
import { Card, Chips, Dot, Empty, ErrorBox, Loading, PageHeader, Progress, Stat, StatusBadge } from '../../components/ui.jsx'
import { ago, dateTime, duration, routeHex, time, TRIP_STATUS, VEHICLE_TYPE } from '../../format.js'
import { LIVE_MS, useLoad, useNow } from '../../hooks.js'

const FILTERS = [
  ['in_progress', 'Đang giao'], ['assigned', 'Chờ xuất phát'], ['awaiting_reconciliation', 'Chờ đối chiếu'], ['closed,revoked', 'Đã kết thúc'],
]

function TripCard({ t, now }) {
  const stale = t.status === 'in_progress' && isStale(t.position, now, staleAfter(t))
  const next = t.stops.find(s => s.id === t.nextStopId)
  const color = routeHex(t.vehicle.id)
  const href = t.status === 'awaiting_reconciliation' ? `/dispatcher/trips/${t.id}/reconcile` : `/dispatcher/trips/${t.id}`
  return (
    <Link to={href} className={`card compact${stale ? ' tone-warning' : ''}`} style={{ color: 'inherit', textDecoration: 'none' }}>
      <div className="row between">
        <div className="row" style={{ gap: 8 }}><Dot color={color} /><span className="h4">{t.code}</span></div>
        <StatusBadge map={TRIP_STATUS} value={t.status} />
      </div>
      <span className="secondary">{t.driver.name} · {VEHICLE_TYPE[t.vehicle.type]} {t.vehicle.plate}</span>
      <div className="row">
        <Progress value={t.progress.done / t.progress.total} width="75%" color={color} />
        <span className="caption strong secondary nowrap">{t.progress.done}/{t.progress.total} điểm</span>
      </div>
      {t.status === 'in_progress' && (
        <div className="row top">
          <div className="grow"><Stat label="Điểm kế tiếp" valueClass="strong" value={next ? `Điểm ${next.seq} · dự kiến ${time(next.eta)}` : 'Về kho'} /></div>
          <div style={{ width: 140 }}><Stat label="Dự kiến về kho" valueClass="strong" value={time(t.etaReturn)} /></div>
        </div>
      )}
      {t.status === 'assigned' && <span className="caption muted">Phân chuyến lúc {time(t.createdAt)} · {duration(t.routeVersion?.objectiveSeconds)} di chuyển dự kiến</span>}
      {t.status === 'awaiting_reconciliation' && <span className="caption warning strong">{t.returnReport?.aborted ? 'Kết thúc do sự cố' : 'Về kho'} lúc {time(t.returnedAt)} · {t.progress.failed} đơn chưa giao được</span>}
      {['closed', 'revoked'].includes(t.status) && <span className="caption muted">Kết thúc lúc {dateTime(t.closedAt)}</span>}
      {t.needsAck && <div className="row tile info" style={{ flexDirection: 'row', gap: 8 }}><Route size={16} className="brand" /><span className="caption strong brand">Chờ thiết bị tài xế nhận tuyến mới</span></div>}
      {t.loadingMismatch && <div className="row tile danger" style={{ flexDirection: 'row', gap: 8 }}><TriangleAlert size={16} className="danger" /><span className="caption strong danger">Hàng không khớp khi xuất phát</span></div>}
      {stale ? (
        <div className="row tile" style={{ flexDirection: 'row', gap: 8, background: 'var(--warn-bg)' }}>
          <TriangleAlert size={16} className="warning" /><span className="caption strong warning">Vị trí cũ · cập nhật {ago(t.position?.observedAt, now)}</span>
        </div>
      ) : t.status === 'in_progress' && (
        <div className="row between">
          <span className="row caption muted" style={{ gap: 6 }}><LocateFixed size={14} /> Vị trí cập nhật {ago(t.position.observedAt, now)}</span>
          <span className="row caption strong brand" style={{ gap: 2 }}>Xem chi tiết <ChevronRight size={14} /></span>
        </div>
      )}
    </Link>
  )
}

export default function TrackingPage() {
  const [params, setParams] = useSearchParams()
  const filter = params.get('status') || 'in_progress'
  const all = useLoad(() => api('/trips?status=active'), [], { interval: LIVE_MS })
  const ended = useLoad(() => (filter === 'closed,revoked' ? api('/trips?status=closed,revoked&limit=30') : Promise.resolve({ trips: [] })), [filter])
  const now = useNow()
  if (all.loading && !all.data) return <Loading />
  const active = all.data?.trips ?? []
  const trips = filter === 'closed,revoked' ? ended.data?.trips ?? [] : active.filter(t => t.status === filter)
  const moving = active.filter(t => t.status === 'in_progress')
  // Bản đồ vẽ các chuyến đang lọc; mục "Đã kết thúc" thì vẫn hiện các xe đang chạy
  const onMap = filter === 'in_progress' || filter === 'closed,revoked' ? moving : trips
  const layers = onMap.map(t => tripLayers(t, { now, opacity: 0.5, label: t.position ? ago(t.position.observedAt, now) : undefined }))
  const staleTrip = moving.find(t => isStale(t.position, now, staleAfter(t)))

  return (
    <>
      <div className="stack-sm">
        <PageHeader title="Theo dõi chuyến giao" />
        <Chips value={filter} onChange={v => setParams({ status: v })} items={FILTERS.map(([v, l]) => ({
          value: v, label: l, count: v === 'closed,revoked' ? undefined : active.filter(t => t.status === v).length,
        }))} />
      </div>
      <ErrorBox error={all.error} onRetry={all.reload} />
      <div className="console">
        <div className="panel-col">
          {trips.length === 0 && <Card><Empty icon={Navigation} title="Không có chuyến" /></Card>}
          {trips.map(t => <TripCard key={t.id} t={t} now={now} />)}
        </div>
        <div className="map-col">
        <MapView depot={active[0]?.depot ?? ended.data?.trips[0]?.depot} routes={layers.flatMap(l => l.routes)} stops={layers.flatMap(l => l.stops)}
          vehicles={layers.flatMap(l => l.vehicles)} fitKey={`${filter}:${onMap.map(t => t.id).join(',')}`}>
          {onMap.length > 0 && (
            <MapOverlay><Legend items={[...onMap.map(t => ({ color: routeHex(t.vehicle.id), label: t.code })), { color: '#2b7a3b', label: 'Đã giao' }, { color: '#c0392b', label: 'Chưa giao được' }, ...(onMap.some(t => t.congestion?.length) ? [{ color: CONGESTION_HEX, label: 'Ùn tắc', line: true }] : []), ...(layers.some(l => l.noRoad) ? [NO_ROAD_LEGEND] : [])]} /></MapOverlay>
          )}
          {staleTrip && (
            <MapOverlay position="bottom-left"><span className="map-chip warning"><TriangleAlert size={16} /> Xe {staleTrip.vehicle.plate}: vị trí cũ hơn {duration(staleAfter(staleTrip))}</span></MapOverlay>
          )}
        </MapView>
        </div>
      </div>
    </>
  )
}
