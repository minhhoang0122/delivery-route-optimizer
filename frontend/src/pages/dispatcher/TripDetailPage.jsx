// D11 Chi tiết chuyến và đề xuất đổi tuyến (UC06, UC07), E09 Thu hồi chuyến (UC16), nhật ký thao tác (NFR08).
import { ClipboardCheck, Clock, Lock, Phone, Route, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, newEventId } from '../../api.js'
import MapView, { Legend, MapOverlay } from '../../components/MapView.jsx'
import { isStale, stopState, tripLayers } from '../../components/tripMap.js'
import { Alert, Button, Card, Checkbox, Dialog, ErrorBox, KeyValue, Loading, PageHeader, Stat, StatusBadge, StopItem } from '../../components/ui.jsx'
import { ago, dateTime, duration, kg, km, percent, routeHex, time, TRIP_STATUS, VEHICLE_TYPE } from '../../format.js'
import { useAction, useLoad, useNow } from '../../hooks.js'

const EVENT_LABEL = {
  trip_assigned: 'Giao chuyến', trip_started: 'Bắt đầu chuyến', route_replanned: 'Duyệt tuyến mới', route_acknowledged: 'Driver xác nhận tuyến',
  attempt_recorded: 'Ghi kết quả giao', trip_returned: 'Báo về kho', trip_closed: 'Chốt chuyến', trip_revoked: 'Thu hồi chuyến',
  loading_mismatch: 'Hàng không khớp khi xuất phát', reroute_evaluated: 'Đánh giá đổi tuyến', reroute_dismissed: 'Bỏ qua đề xuất',
}

function eventDetail(e, stopsById) {
  const p = e.payload || {}
  switch (e.type) {
    case 'trip_assigned': return `${p.orderIds?.length} đơn · tuyến phiên bản 1 · ${duration(p.objectiveSeconds)}`
    case 'attempt_recorded': return `${stopsById.get(p.stopId)?.order.code ?? ''} · ${p.result === 'delivered' ? 'giao thành công' : `chưa giao được (${p.reason})`}`
    case 'route_replanned': return `Phiên bản ${p.fromVersion} → ${p.toVersion} · tiết kiệm ${duration(p.savingSeconds)}`
    case 'reroute_evaluated': return p.valid ? `Hiện tại ${duration(p.currentSeconds)}, đề xuất ${duration(p.proposedSeconds)} · ${p.meetsThreshold ? 'đạt ngưỡng' : 'không đạt ngưỡng'}` : p.reason
    case 'loading_mismatch': return `Thiếu ${p.missingOrderIds?.length ?? 0} kiện`
    case 'trip_returned': return `Mang về ${p.returnedOrderIds?.length ?? 0} kiện`
    case 'trip_closed': return `${p.requeue?.length ?? 0} đơn chuyển kế hoạch sau, ${p.cancel?.length ?? 0} đơn hủy`
    case 'trip_revoked': return `${p.orderIds?.length ?? 0} đơn trở về chờ xếp`
    default: return ''
  }
}

function ProposalCard({ trip, now, onChanged }) {
  const evaluate = useAction()
  const decide = useAction()
  const p = trip.proposal && !trip.proposal.outdated ? trip.proposal : null
  const byId = new Map(trip.stops.map(s => [s.id, s]))

  async function runEvaluate() {
    if (await evaluate.run(() => api(`/trips/${trip.id}/reroute-evaluations`, { method: 'POST', body: {} }))) onChanged()
  }
  async function approve() {
    const ok = await decide.run(() => api(`/trips/${trip.id}/reroute-evaluations/${p.eventId}/approve`, { method: 'POST', body: {} }))
    if (ok) onChanged()
  }
  async function dismiss() {
    if (await decide.run(() => api(`/trips/${trip.id}/reroute-evaluations/${p.eventId}/dismiss`, { method: 'POST', body: {} }))) onChanged()
  }
  const err = decide.error
  const staleError = err?.code === 'STALE' ? err : null

  if (trip.needsAck) {
    return (
      <Card title="Chuyến đang chờ Driver xác nhận tuyến">
        <Alert tone="info" title="Tuyến mới đang chờ Driver xác nhận">Hệ thống chưa đề xuất thêm phiên bản tuyến cho chuyến này cho đến khi Driver xác nhận.</Alert>
        <div className="row between">
          <div className="col"><span className="medium secondary">Phiên bản tuyến {trip.routeVersion.versionNo} · gửi lúc {time(trip.routeVersion.createdAt)} · Driver chưa xác nhận</span>
            <span className="caption muted">Nút đánh giá đổi tuyến mở lại sau khi Driver xác nhận.</span></div>
          <Button variant="secondary" disabled>Đánh giá đổi tuyến</Button>
        </div>
      </Card>
    )
  }

  if (!p) {
    return (
      <Card title={<div className="row"><span className="icon-wrap tone-info"><Route size={18} /></span><div className="col"><h3 className="h4">Điều chỉnh tuyến còn lại</h3><span className="caption muted">So sánh thứ tự hiện tại với phương án mới trên cùng ma trận thời gian vừa cập nhật.</span></div></div>}>
        <p className="secondary">Chỉ đổi thứ tự các điểm sau điểm kế tiếp; xe, các điểm đã xử lý và điểm kế tiếp được giữ nguyên. Phương án mới chỉ được đề xuất khi tiết kiệm ít nhất max(60 giây, 5%).</p>
        {isStale(trip.position, now) && <Alert tone="warning" title="Vị trí xe cũ hơn 30 giây">Cần vị trí mới để đánh giá đổi tuyến.</Alert>}
        <ErrorBox error={evaluate.error} />
        <div className="row end"><Button icon={Route} onClick={runEvaluate} loading={evaluate.busy} disabled={isStale(trip.position, now)}>Đánh giá đổi tuyến</Button></div>
      </Card>
    )
  }

  const pos = [p.position.lat, p.position.lon]
  const depot = [trip.depot.lat, trip.depot.lon]
  const pts = ids => ids.map(id => byId.get(id)).map(s => [s.order.lat, s.order.lon])
  const color = routeHex(trip.vehicle.id)
  const done = trip.stops.filter(s => s.status !== 'pending').sort((a, b) => a.seq - b.seq)
  const proposedSeq = new Map(p.proposedStopIds.map((id, i) => [id, done.length + i + 1]))
  const stops = trip.stops.map(s => ({
    lat: s.order.lat, lon: s.order.lon, color, label: proposedSeq.get(s.id) ?? s.seq,
    state: s.status === 'delivered' ? 'done' : s.status === 'failed' ? 'failed' : 'pending', title: s.order.code,
  }))
  const routes = [
    { points: [depot, ...done.map(s => [s.order.lat, s.order.lon]), pos], color: '#94a3b8' },
    { points: [pos, ...pts(p.currentStopIds), depot], color, dashed: true, opacity: 0.5 },
    ...(p.meetsThreshold ? [{ points: [pos, ...pts(p.proposedStopIds), depot], color, weight: 5 }] : []),
  ]
  const next = byId.get(p.nextStopId)
  const incident = p.matrix?.incident

  return (
    <Card tone="brand" title={<div className="row"><span className="icon-wrap tone-info"><Route size={18} /></span><div className="col"><h3 className="h4">Đề xuất đổi tuyến</h3><span className="caption muted">{p.auto ? `Kiểm tra định kỳ: thời gian các chặng còn lại tăng ${duration(p.increase.increase)} so với lúc lập tuyến. ` : ''}{p.meetsThreshold ? 'Hệ thống đề xuất thứ tự giao mới cho các điểm còn lại.' : 'Phương án mới không tiết kiệm đủ, hệ thống giữ tuyến hiện tại.'}</span></div></div>}>
      {!p.valid ? <Alert tone="warning" title="Chưa lấy được dữ liệu tuyến">{p.reason}. Hệ thống đang giữ tuyến hiện tại và không tạo chặng có thời gian bằng 0.</Alert> : (
        <>
          <MapView height={320} depot={trip.depot} routes={routes} stops={stops} vehicles={[{ lat: pos[0], lon: pos[1], color, label: ago(p.position.observedAt, now) }]} fitKey={`p${p.eventId}`}>
            <MapOverlay><Legend items={[{ color, label: 'Tuyến hiện tại', line: true, dashed: true, opacity: 0.5 }, ...(p.meetsThreshold ? [{ color, label: 'Tuyến đề xuất', line: true }] : []), { color: '#94a3b8', label: 'Đã đi qua', line: true }]} /></MapOverlay>
          </MapView>
          <div className="row top">
            <div className="tile grow"><span className="caption muted">Hiện tại</span><span className="h3">{duration(p.currentSeconds)}</span></div>
            <div className="tile info grow"><span className="caption secondary">Đề xuất</span><span className="h3 brand">{duration(p.proposedSeconds)}</span></div>
            <div className={`tile grow ${p.savingSeconds > 0 ? 'success' : ''}`}><span className="caption secondary">Tiết kiệm</span><span className={`h3 ${p.savingSeconds > 0 ? 'success' : ''}`}>{duration(p.savingSeconds)} ({percent(p.savingRatio)})</span></div>
          </div>
          <div className="stack-sm">
            <div className="row" style={{ gap: 8 }}><Lock size={16} className="muted" /><span>Giữ nguyên: {done.length ? `điểm 1–${done.length} đã xử lý, ` : ''}điểm {next?.seq} ({next?.order.code}) kế tiếp đang khóa. Chỉ đổi thứ tự {p.currentStopIds.length - 1} điểm còn lại.</span></div>
            <div className="row" style={{ gap: 8 }}><Clock size={16} className="muted" /><span className="caption muted">
              Tính trên cùng ma trận thời gian lúc {time(p.createdAt)} · {p.evaluations} phép đánh giá
              {p.increase?.legs > 0 && ` · thời gian các chặng chung ${p.increase.increase >= 0 ? 'tăng' : 'giảm'} ${duration(Math.abs(p.increase.increase))}`}
            </span></div>
            {incident > 0 && <Alert tone="warning" title="Dữ liệu có sự cố giả định">Ma trận dùng một đợt "sự cố giả định" do công cụ mô phỏng tạo, không phải giao thông thật.</Alert>}
          </div>
        </>
      )}
      <ErrorBox error={err && err.code !== 'STALE' ? err : null} />
      <div className="row between">
        <span className="caption muted">{p.meetsThreshold ? 'Driver sẽ xác nhận tuyến mới trên ứng dụng.' : 'Ngưỡng áp dụng: tiết kiệm ít nhất max(60 giây, 5%).'}</span>
        <div className="row">
          <Button variant="secondary" onClick={dismiss} disabled={decide.busy}>{p.meetsThreshold ? 'Bỏ qua' : 'Đóng'}</Button>
          {p.meetsThreshold && <Button onClick={approve} loading={decide.busy}>Duyệt tuyến mới</Button>}
        </div>
      </div>
      {staleError && (
        <Dialog title="Dữ liệu đã thay đổi" confirmLabel="Đánh giá lại" cancelLabel="Đóng" onCancel={() => decide.setError(null)}
          onConfirm={async () => { decide.setError(null); await dismiss(); await runEvaluate() }}>
          <p>Chuyến {trip.code} vừa được cập nhật (phiên bản tuyến {trip.routeVersion.versionNo}). {staleError.message}.</p>
        </Dialog>
      )}
    </Card>
  )
}

export default function TripDetailPage() {
  const { id } = useParams()
  const { data, error, loading, reload } = useLoad(() => api(`/trips/${id}`), [id], { interval: 10_000 })
  const now = useNow()
  const [revoke, setRevoke] = useState(false)
  const [goodsBack, setGoodsBack] = useState(false)
  const action = useAction()
  if (loading && !data) return <Loading />
  const t = data?.trip
  if (!t) return <ErrorBox error={error} onRetry={reload} />
  const byId = new Map(t.stops.map(s => [s.id, s]))
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
      {t.status === 'assigned' && !t.loadingMismatch && <Alert tone="info" title="Driver chưa bắt đầu chuyến">Chuyến được giao lúc {time(t.createdAt)}, chưa có điểm nào được giao. Hàng cần bàn giao tại kho: {t.stops.length} kiện.</Alert>}
      {t.loadingMismatch && (
        <Alert tone="danger" title="Hàng thực nhận không khớp danh sách">
          Driver báo thiếu {t.loadingMismatch.missingOrderIds.map(oid => t.stops.find(s => s.order.id === oid)?.order.code).join(', ')} lúc {time(t.loadingMismatch.reportedAt)}. Kiểm tra lại hàng tại kho hoặc thu hồi chuyến.
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
          {t.status === 'in_progress' && <ProposalCard trip={t} now={now} onChanged={reload} />}
          <Card compact title="Tuyến dự kiến" extra={<span className="caption muted">{duration(t.routeVersion?.objectiveSeconds)} · {km(t.routeVersion?.distanceM)}{t.etaReturn ? ` · về kho ${time(t.etaReturn)}` : ''}</span>}>
            <MapView height={360} depot={t.depot} routes={layers.routes} stops={layers.stops} vehicles={layers.vehicles} fitKey={`${t.id}-${t.routeVersion?.id}`} />
          </Card>
        </div>
      </div>

      <Card title="Nhật ký thao tác" extra={<span className="caption muted">Người thực hiện, thời điểm và nội dung</span>}>
        <div className="stack-sm">
          {t.events.map(e => (
            <div key={e.id} className="row top" style={{ gap: 16 }}>
              <span className="caption muted tabular" style={{ width: 130 }}>{dateTime(e.createdAt)}</span>
              <span className="strong" style={{ width: 210 }}>{EVENT_LABEL[e.type] ?? e.type}</span>
              <span className="secondary grow">{eventDetail(e, byId)}</span>
              <span className="caption muted">{e.actorName ?? 'Hệ thống'}</span>
            </div>
          ))}
        </div>
      </Card>

      {revoke && (
        <Dialog tone="danger" title={`Thu hồi chuyến ${t.code}?`} confirmLabel="Thu hồi chuyến" busy={action.busy} confirmDisabled={!goodsBack}
          onCancel={() => setRevoke(false)} onConfirm={doRevoke}>
          <p>Đơn, xe và Driver của chuyến sẽ được giải phóng. Hàng đã bàn giao phải được đối chiếu lại tại kho trước khi thu hồi.</p>
          <div className="stack-sm">
            <KeyValue label="Hàng đã bàn giao" value={`${t.stops.length} kiện · ${kg(t.loadKg)}`} />
            <Checkbox label="Đã nhận lại đủ hàng tại kho" checked={goodsBack} onChange={setGoodsBack} />
          </div>
          <ErrorBox error={action.error} />
        </Dialog>
      )}
      {t.status === 'revoked' && <Alert tone="info" title="Chuyến đã thu hồi">Các đơn của chuyến đã trở về danh sách chờ xếp.</Alert>}
    </>
  )
}
