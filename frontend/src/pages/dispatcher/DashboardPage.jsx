// D01 Tổng quan ca làm việc: chỉ số, việc cần xử lý, chuyến đang giao và bản đồ xe đang chạy.
import { ClipboardCheck, Clock, Hourglass, Navigation, Package, PhoneCall, Route, Timer, TriangleAlert, CircleCheck } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { api } from '../../api.js'
import MapView, { Legend, MapOverlay } from '../../components/MapView.jsx'
import { CONGESTION_HEX, isStale, NO_ROAD_LEGEND, staleAfter, tripLayers } from '../../components/tripMap.js'
import { Badge, Button, Card, Dot, ErrorBox, Loading, Metric, PageHeader, Progress, StatusBadge } from '../../components/ui.jsx'
import { ago, duration, longDate, routeHex, time, TRIP_STATUS } from '../../format.js'
import { LIVE_MS, useLoad, useNow } from '../../hooks.js'

function TodoItem({ icon: Icon, tone, title, desc, action, to, phone }) {
  const navigate = useNavigate()
  return (
    <div className="todo">
      <span className={`icon-wrap ${tone}`}><Icon size={18} /></span>
      <div className="col grow">
        <span className="strong">{title}</span>
        <span className="caption secondary">{desc}</span>
      </div>
      {phone && <a className="btn secondary" href={`tel:${phone.replace(/\s/g, '')}`}>{phone}</a>}
      <Button variant="ghost" onClick={() => navigate(to)}>{action}</Button>
    </div>
  )
}

export default function DashboardPage() {
  const { data, error, loading, reload } = useLoad(() => api('/dashboard'), [], { interval: LIVE_MS })
  const now = useNow()
  if (loading && !data) return <Loading />
  const m = data?.metrics
  const active = data?.trips.filter(t => t.status === 'in_progress') ?? []
  const layers = active.map(t => tripLayers(t, { now, label: ago(t.position?.observedAt, now) }))

  // Mỗi loại việc có cách hiển thị riêng; chỉ dựng đúng loại của việc đang xét
  const staleText = duration(data?.thresholds?.stalePositionSeconds)
  const TODO = {
    stale_position: x => ({ icon: Clock, tone: 'tone-warning-bg', title: `Vị trí xe ${x.plate} cũ hơn ${staleText}`, desc: x.observedAt ? `Cập nhật lần cuối ${ago(x.observedAt, now)}` : 'Chưa nhận được vị trí nào', action: 'Xem chuyến', to: `/dispatcher/trips/${x.tripId}` }),
    late: x => ({ icon: Timer, tone: 'tone-warning-bg', title: `${x.tripCode} trễ so với kế hoạch`, desc: `Dự kiến về kho ${time(x.etaReturn)} · kế hoạch ${time(x.overShift ? x.shiftEndAt : x.plannedReturnAt)}`, action: 'Xem chuyến', to: `/dispatcher/trips/${x.tripId}` }),
    not_started: x => ({ icon: Hourglass, tone: 'tone-warning-bg', title: `${x.tripCode} chưa xuất phát`, desc: `${x.driverName} · phân chuyến lúc ${time(x.createdAt)}`, action: 'Xem chuyến', to: `/dispatcher/trips/${x.tripId}`, phone: x.driverPhone }),
    failed_attempt: x => ({ icon: PhoneCall, tone: 'tone-danger-bg', title: `${x.orderCode} chưa giao được · ${x.reason}`, desc: `${x.recipientName} · ${x.tripCode} · ${time(x.occurredAt)}`, action: 'Xem chuyến', to: `/dispatcher/trips/${x.tripId}`, phone: x.phone }),
    reconcile: x => ({ icon: ClipboardCheck, tone: 'tone-warning-bg', title: `${x.tripCode} chờ đối chiếu`, desc: `${x.failed} đơn chưa giao được · ${x.aborted ? 'kết thúc do sự cố' : 'về kho'} lúc ${time(x.returnedAt)}`, action: 'Đối chiếu', to: `/dispatcher/trips/${x.tripId}/reconcile` }),
    loading_mismatch: x => ({ icon: TriangleAlert, tone: 'tone-danger-bg', title: `${x.tripCode}: hàng không khớp khi xuất phát`, desc: `Thiếu ${x.missingOrderIds.length} kiện so với danh sách`, action: 'Xem chuyến', to: `/dispatcher/trips/${x.tripId}` }),
  }
  const todo = (data?.todo ?? []).filter(x => TODO[x.type]).map(x => TODO[x.type](x))

  return (
    <>
      <PageHeader title="Tổng quan ca làm việc" subtitle={`${longDate()}${data?.depot ? ` · ${data.depot.name}` : ''}`}
        actions={<Link className="btn primary" to="/dispatcher/planning"><Route size={16} /> Lập kế hoạch</Link>} />
      <ErrorBox error={error} onRetry={reload} />
      {m && (
        <div className="grid-metrics">
          <Metric label="Đơn chờ xếp" value={m.pendingOrders} hint={`${m.truckOnlyOrders} đơn chỉ cho phép xe tải`} icon={Package} />
          <Metric label="Chuyến đang giao" value={m.tripsInProgress} hint={`${m.stopsDone}/${m.stopsTotal} đơn đã xử lý · ${m.assigned} chuyến chờ xuất phát`} icon={Navigation} />
          <Metric label="Chờ đối chiếu" value={m.awaitingReconciliation} hint={`${m.needsActionOrders} đơn chưa giao được`} icon={ClipboardCheck} tone={m.awaitingReconciliation ? 'warning' : undefined} />
          <Metric label="Cảnh báo" value={m.warnings} icon={TriangleAlert} tone={m.warnings ? 'warning' : undefined} />
        </div>
      )}
      <div className="console">
        <div className="panel-col">
          <Card title="Cần xử lý" extra={todo.length ? <Badge tone="warning">{todo.length} việc</Badge> : <Badge tone="success">Không có</Badge>}>
            {todo.length === 0 && <div className="row muted"><CircleCheck size={16} /> Chưa có việc nào cần xử lý.</div>}
            <div>{todo.map((t, i) => <TodoItem key={i} {...t} />)}</div>
          </Card>
          <Card title="Chuyến đang chạy" extra={<Link to="/dispatcher/trips">Theo dõi chuyến</Link>}>
            {data?.trips.length === 0 && <p className="muted">Chưa có chuyến nào.</p>}
            <div>
              {data?.trips.map(t => (
                <Link key={t.id} to={`/dispatcher/trips/${t.id}`} className="todo" style={{ color: 'inherit', textDecoration: 'none' }}>
                  <Dot color={routeHex(t.vehicle.id)} />
                  <div className="col grow">
                    <span><span className="mono strong">{t.code}</span> · {t.driver.name}</span>
                    {t.status === 'in_progress' && isStale(t.position, now, staleAfter(t))
                      ? <span className="caption warning row" style={{ gap: 4 }}><Clock size={12} /> Vị trí {t.position ? `cũ ${ago(t.position.observedAt, now).replace(' trước', '')}` : 'chưa có'}</span>
                      : <StatusBadge map={TRIP_STATUS} value={t.status} />}
                  </div>
                  <Progress value={t.progress.done / t.progress.total} width={64} color={routeHex(t.vehicle.id)} />
                  <span className="tabular secondary nowrap">{t.progress.done}/{t.progress.total}</span>
                </Link>
              ))}
            </div>
          </Card>
        </div>
        <div className="map-col">
          <MapView depot={data?.depot}
            routes={layers.flatMap(l => l.routes)} stops={layers.flatMap(l => l.stops)} vehicles={layers.flatMap(l => l.vehicles)}
            fitKey={active.map(t => t.id).join(',')}>
            {active.length > 0 && (
              <MapOverlay><Legend items={[...active.map(t => ({ color: routeHex(t.vehicle.id), label: t.code })), { color: '#2b7a3b', label: 'Đã giao' }, { color: '#c0392b', label: 'Chưa giao được' }, ...(active.some(t => t.congestion?.length) ? [{ color: CONGESTION_HEX, label: 'Ùn tắc', line: true }] : []), ...(layers.some(l => l.noRoad) ? [NO_ROAD_LEGEND] : [])]} /></MapOverlay>
            )}
          </MapView>
        </div>
      </div>
    </>
  )
}
