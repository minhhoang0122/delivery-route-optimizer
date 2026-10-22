// R01 Chuyến hiện tại, R02 Bắt đầu chuyến (kiểm hàng), R02b Hàng không khớp, R05 Mất mạng (UC10, UC10.1, UC11, UC12).
import { CircleCheck, Info, LocateFixed, Navigation, Package, Phone, RefreshCw, WifiOff } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, newEventId } from '../../api.js'
import { DriverScreen } from '../../layouts/DriverLayout.jsx'
import { useDriver } from '../../layouts/driverContext.js'
import { Alert, Button, Empty, ErrorBox, Loading, StatusBadge, StopItem } from '../../components/ui.jsx'
import { stopState } from '../../components/tripMap.js'
import { ago, duration, kg, time, TRIP_STATUS, VEHICLE_TYPE } from '../../format.js'
import { useAction, useNow } from '../../hooks.js'

const mapsLink = o => `https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lon}`

function NextStopCard({ stop, total, actions }) {
  const o = stop.order
  return (
    <section className="card" style={{ padding: 12, gap: 8 }}>
      <span className="medium brand">Điểm kế tiếp · {stop.seq}/{total}</span>
      <div className="col">
        <span className="driver-title">{o.recipientName}</span>
        <span className="body-large secondary">{o.address}</span>
        <span className="row secondary" style={{ gap: 8 }}><Package size={16} className="muted" />{kg(o.weightKg)}{stop.eta ? ` · Dự kiến ${time(stop.eta)}` : ''}</span>
      </div>
      {actions && (
        <div className="row">
          <a className="btn secondary large" href={`tel:${o.phone.replace(/\s/g, '')}`}><Phone size={18} /> Gọi</a>
          <a className="btn secondary large grow" href={mapsLink(o)} target="_blank" rel="noreferrer"><Navigation size={18} /> Chỉ đường</a>
        </div>
      )}
    </section>
  )
}

/** R02 Bắt đầu chuyến: kiểm từng kiện tại kho; R02b khi hàng không khớp thì không cho xuất phát. */
function AssignedScreen({ trip, vehicle, onStarted }) {
  const [checked, setChecked] = useState(() => new Set())
  const action = useAction()
  const startId = useRef(null)
  const all = trip.stops.length
  const ok = checked.size === all
  const missing = action.error?.details?.missingOrderIds

  async function start() {
    const ids = [...checked].sort((a, b) => a - b)
    // Cùng danh sách kiện thì dùng lại mã thao tác: bấm lặp không tạo hai lần xuất phát
    const key = ids.join(',')
    if (startId.current?.key !== key) startId.current = { key, id: newEventId() }
    const res = await action.run(() => api(`/driver/trips/${trip.id}/start`, { method: 'POST', body: { clientEventId: startId.current.id, checkedOrderIds: ids } }))
    if (res) onStarted(res.trip)
  }
  const toggle = (id, on) => {
    const n = new Set(checked)
    if (on) n.add(id); else n.delete(id)
    setChecked(n)
  }

  return (
    <DriverScreen title={`Chuyến ${trip.code}`} subtitle={`${vehicle} · ${all} điểm`}
      footer={<Button size="large" block icon={Navigation} disabled={!ok} loading={action.busy} onClick={start}>Bắt đầu chuyến</Button>}>
      <div className="alert info"><Info size={18} className="alert-icon" /><span className="alert-message">Chuyến được giao lúc {time(trip.createdAt)}. Kiểm hàng rồi bấm Bắt đầu chuyến khi xuất phát.</span></div>
      <section className="card" style={{ gap: 8 }}>
        <div className="row between">
          <span className="h4">Kiểm hàng tại kho</span>
          <span className={`strong ${ok ? 'success' : missing ? 'danger' : 'muted'}`}>{checked.size}/{all} kiện</span>
        </div>
        <div>
          {trip.stops.map(s => (
            <label key={s.id} className="check-row" style={{ cursor: 'pointer' }}>
              <span className="check" style={{ fontSize: 15 }}>
                <input type="checkbox" checked={checked.has(s.order.id)} onChange={e => toggle(s.order.id, e.target.checked)} />
                <span>{s.order.code} · {s.order.recipientName}</span>
              </span>
              <span className={`medium ${missing?.includes(s.order.id) && !checked.has(s.order.id) ? 'danger' : 'secondary'}`}>
                {missing?.includes(s.order.id) && !checked.has(s.order.id) ? 'Thiếu' : kg(s.order.weightKg)}
              </span>
            </label>
          ))}
        </div>
      </section>
      {ok && <div className="alert success"><CircleCheck size={20} className="alert-icon" /><span className="strong">{all}/{all} kiện khớp với danh sách</span></div>}
      {!ok && checked.size > 0 && (
        <Button variant="secondary" block onClick={start} loading={action.busy}>Báo thiếu hàng cho Dispatcher</Button>
      )}
      {missing && (
        <Alert tone="danger" title="Hàng không khớp danh sách">
          Thiếu kiện {missing.map(id => trip.stops.find(s => s.order.id === id)?.order.code).join(', ')}. Đã báo cho Dispatcher, liên hệ trước khi xuất phát.
        </Alert>
      )}
      {action.error && !missing && <ErrorBox error={action.error} />}
    </DriverScreen>
  )
}

export default function CurrentTripPage() {
  const { trip, setTrip, online, fromCache, outbox, location, reload, retry, error } = useDriver()
  const navigate = useNavigate()
  const now = useNow()
  const ack = useAction()

  if (trip === undefined) return <DriverScreen title="Chuyến hiện tại"><Loading /></DriverScreen>
  if (!trip) {
    return (
      <DriverScreen title="Chuyến hiện tại" subtitle="Chưa có chuyến">
        <ErrorBox error={error} />
        <Empty icon={Navigation} title="Chưa có chuyến được giao" action={<Button variant="secondary" icon={RefreshCw} onClick={reload}>Tải lại</Button>}>
          Khi Dispatcher giao chuyến, nhiệm vụ sẽ hiện ở đây.
        </Empty>
      </DriverScreen>
    )
  }

  const total = trip.stops.length
  const vehicle = `${VEHICLE_TYPE[trip.vehicle.type]} ${trip.vehicle.plate}`
  const queued = outbox.filter(x => x.tripId === trip.id && x.kind === 'attempt')
  const failedSync = queued.filter(x => x.state === 'failed')
  // Kết quả bị máy chủ từ chối không chặn báo về kho; máy chủ vẫn kiểm tra mọi điểm đã có kết quả
  const waiting = queued.length - failedSync.length

  if (trip.status === 'assigned') return <AssignedScreen trip={trip} vehicle={vehicle} onStarted={setTrip} />

  if (trip.status === 'awaiting_reconciliation') {
    return (
      <DriverScreen title={`Chuyến ${trip.code}`} subtitle={`${vehicle} · ${trip.progress.done}/${total} điểm`}>
        <Alert tone="info" title="Đã báo về kho, chờ Dispatcher chốt chuyến" />
        <section className="card" style={{ gap: 8 }}>
          <div className="row between"><span className="h4">Kết quả chuyến</span><StatusBadge map={TRIP_STATUS} value={trip.status} large /></div>
          <span className="secondary">{trip.progress.delivered} giao thành công · {trip.progress.failed} chưa giao được · về kho lúc {time(trip.returnedAt)}</span>
        </section>
      </DriverScreen>
    )
  }

  const next = trip.stops.find(s => s.id === trip.nextStopId)
  const rest = trip.stops.filter(s => s.status === 'pending' && s.id !== trip.nextStopId)
  const allDone = !trip.stops.some(s => s.status === 'pending')
  const lastReplan = trip.routeVersion

  async function acknowledge() {
    const res = await ack.run(() => api(`/driver/trips/${trip.id}/route-ack`, { method: 'POST', body: { clientEventId: newEventId(), routeVersionId: trip.routeVersion.id } }))
    if (res) setTrip(res.trip)
  }

  const locationNote = {
    sharing: [LocateFixed, 'success', `Đang chia sẻ vị trí · cập nhật ${ago(location.lastSentAt, now)}`],
    denied: [LocateFixed, 'warning', 'Chưa được phép lấy vị trí. Bật quyền vị trí cho trình duyệt.'],
    unavailable: [LocateFixed, 'warning', 'Thiết bị không lấy được vị trí'],
    failed: [WifiOff, 'warning', `Chưa gửi được vị trí${location.lastSentAt ? ` · lần cuối lúc ${time(location.lastSentAt)}` : ''}`],
    idle: [LocateFixed, 'muted', trip.position ? `Vị trí gần nhất ${ago(trip.position.observedAt, now)}` : 'Đang chờ vị trí'],
  }[online ? location.status : 'failed']
  const [LocIcon, locTone, locText] = locationNote

  return (
    <DriverScreen title={`Chuyến ${trip.code}`} subtitle={`${vehicle} · ${trip.progress.done}/${total} điểm`}
      footer={<>
        {allDone
          ? <Button size="large" block disabled={waiting > 0} onClick={() => navigate('/driver/return')}>{waiting ? 'Chờ gửi hết kết quả để báo về kho' : 'Báo về kho'}</Button>
          : next && <Button size="large" block onClick={() => navigate(`/driver/stops/${next.id}`)}>Ghi kết quả giao</Button>}
        <span className={`row caption ${locTone}`} style={{ justifyContent: 'center', gap: 8 }}><LocIcon size={16} />{locText}</span>
      </>}>
      {!online && (
        <div className="banner danger">
          <div className="row" style={{ gap: 8 }}><WifiOff size={20} className="danger" /><span className="body-large strong">Mất mạng</span></div>
          <span className="secondary">Kết quả được lưu trên máy và sẽ tự gửi khi có mạng.{fromCache ? ' Đang hiển thị chuyến đã tải trước đó.' : ''}</span>
        </div>
      )}
      {trip.needsAck && (
        <div className="banner info">
          <div className="row" style={{ gap: 8 }}><RefreshCw size={20} className="brand" /><span className="body-large strong">Tuyến đã được điều chỉnh</span></div>
          <span className="secondary">Phiên bản tuyến {lastReplan.versionNo}: các điểm sau điểm kế tiếp đổi thứ tự, dự kiến {duration(lastReplan.objectiveSeconds)} cho phần còn lại.</span>
          <ErrorBox error={ack.error} />
          <Button block onClick={acknowledge} loading={ack.busy}>Xác nhận tuyến mới</Button>
        </div>
      )}
      {failedSync.length > 0 && (
        <Alert tone="danger" title="Có kết quả không gửi được" action={<Button variant="secondary" onClick={retry}>Thử lại</Button>}>
          {failedSync.map(x => `${x.label}: ${x.error}`).join(' · ')}
        </Alert>
      )}
      {queued.filter(x => x.state !== 'failed').length > 0 && (
        <>
          <div className="row between"><span className="h4">Kết quả chờ gửi</span><span className="caption muted">{waiting} điểm</span></div>
          {queued.filter(x => x.state !== 'failed').map(x => {
            const s = trip.stops.find(y => y.id === x.stopId)
            return s && (
              <div key={x.clientEventId} className="stack-sm">
                <StopItem state={stopState(s)} seq={s.seq} name={s.order.recipientName} address={s.order.address}
                  meta={x.body.result === 'delivered' ? `Giao lúc ${time(x.body.occurredAt)} · ${kg(s.order.weightKg)}` : `${x.body.reason} · ${kg(s.order.weightKg)}`} />
                <div className="row" style={{ paddingLeft: 12, gap: 8 }}>
                  <span className={`sync ${x.state === 'sending' ? 'sending' : 'pending'}`}>{x.state === 'sending' ? 'Đang gửi' : 'Chờ gửi'}</span>
                  <span className="caption muted">Lưu trên máy lúc {time(x.createdAt)}</span>
                </div>
              </div>
            )
          })}
        </>
      )}
      {next && <NextStopCard stop={next} total={total} actions={!trip.needsAck} />}
      {allDone && <Alert tone="success" title="Đã xử lý hết các điểm" />}
      {rest.length > 0 && (
        <>
          <div className="row between"><span className="h4">Các điểm còn lại</span><span className="caption muted">{rest.length} điểm</span></div>
          {rest.map(s => <StopItem key={s.id} state="pending" seq={s.seq} name={s.order.recipientName} address={s.order.address}
            meta={`${s.eta ? `Dự kiến ${time(s.eta)} · ` : ''}${kg(s.order.weightKg)}`} onClick={() => navigate(`/driver/stops/${s.id}`)} />)}
        </>
      )}
      {trip.stops.some(s => s.status !== 'pending' && !s.queued) && (
        <>
          <div className="row between"><span className="h4">Đã xử lý</span></div>
          {trip.stops.filter(s => s.status !== 'pending' && !s.queued).map(s => (
            <StopItem key={s.id} state={stopState(s)} seq={s.seq} name={s.order.recipientName} address={s.order.address}
              meta={s.status === 'delivered' ? `Đã giao ${time(s.attempt?.occurredAt)}` : `${s.attempt?.reason} · ${time(s.attempt?.occurredAt)}`} />
          ))}
        </>
      )}
    </DriverScreen>
  )
}
