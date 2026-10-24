// D11 Chi tiết chuyến và lần hệ thống tự đổi tuyến (UC06, UC07), E09 Thu hồi chuyến (UC16), nhật ký thao tác (NFR08).
import { ClipboardCheck, Lock, Phone, Route, TrafficCone, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, newEventId } from '../../api.js'
import MapView, { Legend, MapOverlay } from '../../components/MapView.jsx'
import { CONGESTION_HEX, congestionRoutes, geoToLatLngs, isStale, NO_ROAD_LEGEND, noRoadRoute, stopState, tripLayers } from '../../components/tripMap.js'
import { Alert, Badge, Button, Card, Checkbox, Dialog, ErrorBox, KeyValue, Loading, LoadError, PageHeader, Stat, StatusBadge, StopItem } from '../../components/ui.jsx'
import { ago, dateTime, duration, kg, km, percent, routeHex, time, TRIP_STATUS, VEHICLE_TYPE } from '../../format.js'
import { LIVE_MS, useAction, useLoad, useNow } from '../../hooks.js'

const EVENT_LABEL = {
  trip_assigned: 'Giao chuyến', trip_started: 'Bắt đầu chuyến', route_replanned: 'Tự đổi tuyến', route_acknowledged: 'Thiết bị Driver đã nhận tuyến mới',
  attempt_recorded: 'Ghi kết quả giao', trip_returned: 'Báo về kho', trip_closed: 'Chốt chuyến', trip_revoked: 'Thu hồi chuyến',
  loading_mismatch: 'Hàng không khớp khi xuất phát', reroute_evaluated: 'Đánh giá đổi tuyến',
}

function eventDetail(e, stopsById, versionNo) {
  const p = e.payload || {}
  switch (e.type) {
    case 'trip_assigned': return `${p.orderIds?.length} đơn · tuyến phiên bản 1 · ${duration(p.objectiveSeconds)}`
    case 'attempt_recorded': return `${stopsById.get(p.stopId)?.order.code ?? ''} · ${p.result === 'delivered' ? 'giao thành công' : `chưa giao được (${p.reason})`}`
    case 'route_replanned': return `Phiên bản ${p.fromVersion} → ${p.toVersion} · tiết kiệm ${duration(p.savingSeconds)}`
    case 'reroute_evaluated': return p.valid ? `Thứ tự hiện tại ${duration(p.currentSeconds)}, thứ tự mới ${duration(p.proposedSeconds)}` : p.reason
    case 'route_acknowledged': return versionNo.get(p.routeVersionId) ? `Phiên bản ${versionNo.get(p.routeVersionId)}` : ''
    case 'loading_mismatch': return `Thiếu ${p.missingOrderIds?.length ?? 0} kiện`
    case 'trip_returned': return `Mang về ${p.returnedOrderIds?.length ?? 0} kiện`
    case 'trip_closed': return `${p.requeue?.length ?? 0} đơn chuyển kế hoạch sau, ${p.cancel?.length ?? 0} đơn hủy`
    case 'trip_revoked': return `${p.orderIds?.length ?? 0} đơn trở về chờ xếp`
    default: return ''
  }
}

/** Lần hệ thống tự đổi tuyến gần nhất: thứ tự cũ và mới trên bản đồ, thời gian trước và sau, trạng thái thiết bị Driver nhận tuyến. */
function ReplanCard({ trip }) {
  const r = trip.lastReplan
  const byId = new Map(trip.stops.map(s => [s.id, s]))
  const pos = [r.position.lat, r.position.lon]
  const depot = [trip.depot.lat, trip.depot.lon]
  const pts = ids => (ids ?? []).map(id => byId.get(id)).filter(Boolean).map(s => [s.order.lat, s.order.lon])
  const color = routeHex(trip.vehicle.id)
  const done = trip.stops.filter(s => !r.proposedStopIds.includes(s.id)).sort((a, b) => a.seq - b.seq)
  const newSeq = new Map(r.proposedStopIds.map((id, i) => [id, done.length + i + 1]))
  const stops = trip.stops.map(s => ({
    lat: s.order.lat, lon: s.order.lon, color, label: newSeq.get(s.id) ?? s.seq,
    state: s.status === 'delivered' ? 'done' : s.status === 'failed' ? 'failed' : 'pending', title: s.order.code,
  }))
  // Tuyến cũ cắt từ đường đi của phiên bản trước, tuyến mới là đường đi của phiên bản hiện hành; tuyến mới chưa có đường đi thì vẽ nét chấm
  const newGeom = trip.routeVersion?.id === r.routeVersionId ? geoToLatLngs(trip.routeVersion.geometry) : null
  const oldGeom = geoToLatLngs(r.oldGeometry)
  const routes = [
    ...(trip.trail?.length > 1 ? [{ points: geoToLatLngs({ coordinates: trip.trail }), color: '#94a3b8' }] : []),
    ...(oldGeom ? [{ points: oldGeom, color: '#6b7280', dashed: true, opacity: 0.9, weight: 3 }] : []),
    ...congestionRoutes(trip),
    newGeom ? { points: newGeom, color, weight: 5 } : noRoadRoute([pos, ...pts(r.proposedStopIds), depot]),
  ]
  const kept = newSeq.get(r.nextStopId)
  const title = (
    <div className="row"><span className="icon-wrap tone-info"><Route size={18} /></span>
      <div className="col"><h3 className="h4">Hệ thống đã đổi tuyến</h3><span className="caption muted">Phiên bản {r.fromVersion} → {r.toVersion} · {time(r.at)}</span></div>
    </div>
  )
  const status = r.received
    ? <Badge tone="success">Driver đã nhận tuyến mới{r.receivedAt ? ` · ${time(r.receivedAt)}` : ''}</Badge>
    : <Badge tone="warning">Chờ thiết bị Driver nhận</Badge>

  return (
    <Card tone="brand" title={title} extra={status}>
      <MapView height={320} depot={trip.depot} routes={routes} stops={stops} vehicles={[{ key: 'p', lat: pos[0], lon: pos[1], color, label: time(r.position.observedAt) }]} fitKey={`r${r.toVersion}`}>
        <MapOverlay><Legend items={[...(oldGeom ? [{ color: '#6b7280', label: 'Tuyến cũ', line: true, dashed: true }] : []), ...(newGeom ? [{ color, label: 'Tuyến mới', line: true }] : []), ...(trip.trail?.length > 1 ? [{ color: '#94a3b8', label: 'Đã đi qua', line: true }] : []), ...(trip.congestion?.length ? [{ color: CONGESTION_HEX, label: 'Ùn tắc', line: true }] : []), ...(newGeom ? [] : [NO_ROAD_LEGEND])]} /></MapOverlay>
      </MapView>
      <div className="row top">
        <div className="tile grow"><span className="caption muted">Tuyến cũ</span><span className="h3">{duration(r.currentSeconds)}</span></div>
        <div className="tile info grow"><span className="caption secondary">Tuyến mới</span><span className="h3 brand">{duration(r.proposedSeconds)}</span></div>
        <div className="tile success grow"><span className="caption secondary">Tiết kiệm</span><span className="h3 success">{duration(r.savingSeconds)} ({percent(r.savingRatio)})</span></div>
      </div>
      <div className="stack-sm">
        {r.increase?.increase > 0 && <div className="row" style={{ gap: 8 }}><TrafficCone size={16} className="danger" /><span>Các chặng còn lại chậm thêm {duration(r.increase.increase)}{r.slowLegs.length ? ` · ${r.slowLegs.length} chặng ùn tắc` : ''}</span></div>}
        {kept && <div className="row" style={{ gap: 8 }}><Lock size={16} className="muted" /><span>Giữ nguyên điểm {kept > 1 ? `1–${kept}` : kept}</span></div>}
      </div>
    </Card>
  )
}

export default function TripDetailPage() {
  const { id } = useParams()
  const { data, error, loading, reload } = useLoad(() => api(`/trips/${id}`), [id], { interval: LIVE_MS })
  const now = useNow()
  const [revoke, setRevoke] = useState(false)
  const [goodsBack, setGoodsBack] = useState(false)
  const action = useAction()
  if (loading && !data) return <Loading />
  const t = data?.trip
  if (!t) return <LoadError error={error} onRetry={reload} notFound="Không tìm thấy chuyến" back="/dispatcher/trips" />
  const byId = new Map(t.stops.map(s => [s.id, s]))
  const versionNo = new Map(t.routeVersions.map(v => [v.id, v.versionNo]))
  const layers = tripLayers(t, { now, label: t.position ? ago(t.position.observedAt, now) : undefined })
  const stale = t.status === 'in_progress' && isStale(t.position, now)

  async function doRevoke() {
    const ok = await action.run(() => api(`/trips/${t.id}/revoke`, { method: 'POST', body: { clientEventId: newEventId(), stateVersion: t.stateVersion, goodsReturned: goodsBack } }))
    if (ok) { setRevoke(false); reload() }
  }

  return (
    <>
      <PageHeader title={`Chuyến ${t.code}`} badge={<StatusBadge map={TRIP_STATUS} value={t.status} />}
        subtitle={`${t.driver.name} · ${VEHICLE_TYPE[t.vehicle.type]} ${t.vehicle.plate} · ${t.startedAt ? `Xuất phát ${time(t.startedAt)}` : `Giao chuyến lúc ${time(t.createdAt)}`}`}
        actions={<>
          {t.driver.phone && <a className="btn secondary" href={`tel:${t.driver.phone.replace(/\s/g, '')}`}><Phone size={18} /> Gọi Driver</a>}
          {t.status === 'assigned' && <Button variant="danger" icon={Undo2} onClick={() => { action.setError(null); setGoodsBack(false); setRevoke(true) }}>Thu hồi chuyến</Button>}
          {t.status === 'awaiting_reconciliation' && <Link className="btn primary" to={`/dispatcher/trips/${t.id}/reconcile`}><ClipboardCheck size={18} /> Đối chiếu và chốt chuyến</Link>}
        </>} />
      <ErrorBox error={error} onRetry={reload} />
      {t.status === 'assigned' && !t.loadingMismatch && <Alert tone="info" title={`Driver chưa bắt đầu chuyến · ${t.stops.length} kiện chờ bàn giao`} />}
      {t.loadingMismatch && (
        <Alert tone="danger" title="Hàng thực nhận không khớp danh sách">
          Driver báo thiếu {t.loadingMismatch.missingOrderIds.map(oid => t.stops.find(s => s.order.id === oid)?.order.code).join(', ')} lúc {time(t.loadingMismatch.reportedAt)}.
        </Alert>
      )}
      {stale && <Alert tone="warning" title={`Vị trí xe ${t.vehicle.plate} cũ hơn 30 giây`}>Cập nhật lần cuối {ago(t.position?.observedAt, now)}.</Alert>}

      <div className="grid-split">
        <Card title={`Điểm dừng (${t.progress.done}/${t.progress.total})`} extra={<span className="caption muted">Phiên bản tuyến {t.routeVersion?.versionNo}</span>}>
          <div className="stack-sm" style={{ maxHeight: 640, overflowY: 'auto' }}>
            {t.stops.map(s => (
              <StopItem key={s.id} state={stopState(s, t.nextStopId)} seq={s.seq} name={s.order.recipientName} address={s.order.address}
                meta={s.attempt
                  ? `${s.attempt.result === 'delivered' ? 'Đã giao' : s.attempt.reason} ${time(s.attempt.occurredAt)} · ${s.order.code} · ${kg(s.order.weightKg)}${s.attempt.note ? ` · ${s.attempt.note}` : ''}`
                  : `${s.eta ? `Dự kiến ${time(s.eta)} · ` : ''}${s.order.code} · ${kg(s.order.weightKg)}`} />
            ))}
          </div>
        </Card>
        <div className="stack">
          <Card compact>
            <div className="row top wrap" style={{ gap: 16 }}>
              <Stat label="Đã xử lý" valueClass="h4" value={`${t.progress.done}/${t.progress.total} điểm`} />
              <Stat sep label="Giao thành công" valueClass="h4" valueTone="success" value={t.progress.delivered} />
              <Stat sep label="Chưa giao được" valueClass="h4" valueTone="danger" value={t.progress.failed} />
              <Stat sep label={t.status === 'in_progress' ? 'Vị trí cập nhật' : 'Tổng khối lượng'} valueClass="h4" valueTone={stale ? 'warning' : ''}
                value={t.status === 'in_progress' ? ago(t.position?.observedAt, now) : `${kg(t.loadKg)}/${kg(t.vehicle.capacityKg)}`} />
            </div>
          </Card>
          {t.status === 'in_progress' && t.lastReplan && <ReplanCard trip={t} />}
          <Card compact title="Tuyến dự kiến" extra={<span className="caption muted">{duration(t.routeVersion?.objectiveSeconds)} · {km(t.routeVersion?.distanceM)}{t.etaReturn ? ` · về kho ${time(t.etaReturn)}` : ''}</span>}>
            <MapView height={360} depot={t.depot} routes={layers.routes} stops={layers.stops} vehicles={layers.vehicles} fitKey={`${t.id}-${t.routeVersion?.id}`}>
              {(t.congestion?.length > 0 || layers.noRoad) && <MapOverlay><Legend items={[...(t.congestion?.length ? [{ color: CONGESTION_HEX, label: 'Ùn tắc', line: true }] : []), ...(layers.noRoad ? [NO_ROAD_LEGEND] : [])]} /></MapOverlay>}
            </MapView>
          </Card>
        </div>
      </div>

      <Card title="Nhật ký thao tác">
        <div className="stack-sm">
          {t.events.map(e => (
            <div key={e.id} className="row top" style={{ gap: 16 }}>
              <span className="caption muted tabular" style={{ width: 130 }}>{dateTime(e.createdAt)}</span>
              <span className="strong" style={{ width: 210 }}>{EVENT_LABEL[e.type] ?? e.type}</span>
              <span className="secondary grow">{eventDetail(e, byId, versionNo)}</span>
              <span className="caption muted">{e.actorName ?? 'Hệ thống'}</span>
            </div>
          ))}
        </div>
      </Card>

      {revoke && (
        <Dialog tone="danger" title={`Thu hồi chuyến ${t.code}?`} confirmLabel="Thu hồi chuyến" busy={action.busy} confirmDisabled={!goodsBack}
          onCancel={() => setRevoke(false)} onConfirm={doRevoke}>
                    <div className="stack-sm">
            <KeyValue label="Hàng đã bàn giao" value={`${t.stops.length} kiện · ${kg(t.loadKg)}`} />
            <Checkbox label="Đã nhận lại đủ hàng tại kho" checked={goodsBack} onChange={setGoodsBack} />
          </div>
          <ErrorBox error={action.error} />
        </Dialog>
      )}
      {t.status === 'revoked' && <Alert tone="info" title="Chuyến đã thu hồi" />}
    </>
  )
}
