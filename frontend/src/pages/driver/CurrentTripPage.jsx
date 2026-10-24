// R01 Chuyến hiện tại, R02 Bắt đầu chuyến (kiểm hàng), R02b Hàng không khớp, R05 Mất mạng (UC10, UC10.1, UC11, UC12).
import { CircleCheck, Clock, Info, LocateFixed, Navigation, Package, PackageX, Phone, RefreshCw, Undo2, WifiOff } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, newEventId } from '../../api.js'
import { DriverScreen } from '../../layouts/DriverLayout.jsx'
import { useDriver } from '../../layouts/driverContext.js'
import { Alert, Button, Empty, ErrorBox, Loading, StatusBadge, StopItem } from '../../components/ui.jsx'
import { stopState } from '../../components/tripMap.js'
import { ago, appointment, kg, parcels, time, TRIP_STATUS, VEHICLE_TYPE } from '../../format.js'
import { useAction, useNow } from '../../hooks.js'
import { isHeld, removeItem } from '../../offline.js'

const mapsLink = o => `https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lon}`
// Phiên bản tuyến do hệ thống tạo (đổi tuyến, đi theo tài xế, khách hẹn lại): ứng dụng báo ngắn "Tuyến đã cập nhật"
const SYSTEM_ROUTE = ['replan', 'out_of_order', 'off_route', 'customer']
/** Thẻ giờ khách hẹn trên điểm dừng. */
const Appointment = ({ stop }) => (stop.order.notBeforeAt ? <span className="tag-time"><Clock size={12} />{appointment(stop.order.notBeforeAt)}</span> : null)

function NextStopCard({ stop, total }) {
  const o = stop.order
  return (
    <section className="card" style={{ padding: 12, gap: 8 }}>
      <span className="medium brand">Điểm kế tiếp · {stop.seq}/{total}</span>
      <div className="col">
        <span className="driver-title">{o.recipientName}</span>
        <span className="body-large secondary">{o.address}</span>
        <span className="row wrap secondary" style={{ gap: 8 }}><Package size={16} className="muted" />{kg(o.weightKg)} · {parcels(o.parcels)}{stop.eta ? ` · Dự kiến ${time(stop.eta)}` : ''}{stop.deferred ? ' · Giao sau' : ''}<Appointment stop={stop} /></span>
      </div>
      {o.note && (
        <div className="row top" style={{ padding: 8, borderRadius: 3, background: 'var(--warn-bg)', gap: 8 }}>
          <Info size={16} className="warning" /><span className="body-large">{o.note}</span>
        </div>
      )}
      <div className="row">
        <a className="btn secondary large" href={`tel:${o.phone.replace(/\s/g, '')}`}><Phone size={18} /> Gọi</a>
        <a className="btn secondary large grow" href={mapsLink(o)} target="_blank" rel="noreferrer"><Navigation size={18} /> Chỉ đường</a>
      </div>
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
  // Kiện thiếu theo lần bấm vừa rồi; mở lại ứng dụng thì lấy theo lần báo thiếu đã lưu trên máy chủ
  const missing = action.error?.details?.missingOrderIds ?? trip.loadingMismatch?.missingOrderIds

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
        <Button variant="secondary" block onClick={start} loading={action.busy}>Báo thiếu hàng cho điều phối viên</Button>
      )}
      {missing?.some(id => !checked.has(id)) && (
        <Alert tone="danger" title="Hàng không khớp danh sách">
          Thiếu kiện {missing.map(id => trip.stops.find(s => s.order.id === id)?.order.code).join(', ')} · đã báo điều phối viên
        </Alert>
      )}
      {action.error && !missing && <ErrorBox error={action.error} />}
    </DriverScreen>
  )
}

export default function CurrentTripPage() {
  const { trip, setTrip, online, outbox, location, reload, retry, error } = useDriver()
  const navigate = useNavigate()
  const now = useNow()

  if (trip === undefined) return <DriverScreen title="Chuyến hiện tại">{error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />}</DriverScreen>
  if (!trip) {
    return (
      <DriverScreen title="Chuyến hiện tại" subtitle="Chưa có chuyến">
        <ErrorBox error={error} />
        <Empty icon={Navigation} title="Chưa có chuyến được giao" action={<Button variant="secondary" icon={RefreshCw} onClick={reload}>Tải lại</Button>} />
      </DriverScreen>
    )
  }

  const total = trip.stops.length
  const vehicle = `${VEHICLE_TYPE[trip.vehicle.type]} ${trip.vehicle.plate}`
  const queued = outbox.filter(x => x.tripId === trip.id && x.kind === 'attempt')
  // Kết quả bị từ chối của mọi chuyến (kể cả chuyến cũ) đều hiện ở đây để Driver gửi lại hoặc bỏ
  const failedSync = outbox.filter(x => x.kind === 'attempt' && x.state === 'failed')
  // Kết quả bị máy chủ từ chối không chặn báo về kho; máy chủ vẫn kiểm tra mọi điểm đã có kết quả
  const waiting = queued.filter(x => x.state !== 'failed').length

  if (trip.status === 'assigned') return <AssignedScreen trip={trip} vehicle={vehicle} onStarted={setTrip} />

  if (trip.status === 'awaiting_reconciliation') {
    return (
      <DriverScreen title={`Chuyến ${trip.code}`} subtitle={`${vehicle} · ${trip.progress.done}/${total} điểm`}>
        <Alert tone="info" title={trip.returnReport?.aborted ? 'Chuyến đã kết thúc do sự cố, chờ điều phối viên chốt chuyến' : 'Đã báo về kho, chờ điều phối viên chốt chuyến'} />
        <section className="card" style={{ gap: 8 }}>
          <div className="row between"><span className="h4">Kết quả chuyến</span><StatusBadge map={TRIP_STATUS} value={trip.status} large /></div>
          <span className="secondary">{trip.progress.delivered} giao thành công · {trip.progress.failed} chưa giao được · {trip.returnReport?.aborted ? 'kết thúc' : 'về kho'} lúc {time(trip.returnedAt)}</span>
        </section>
      </DriverScreen>
    )
  }

  const next = trip.stops.find(s => s.id === trip.nextStopId)
  const rest = trip.stops.filter(s => s.status === 'pending' && s.id !== trip.nextStopId)
  const allDone = !trip.stops.some(s => s.status === 'pending')

  // Tuyến vừa được hệ thống đổi: báo ngắn cho đến 1 phút sau khi thiết bị đã nhận; danh sách điểm đã theo thứ tự mới
  const rv = trip.routeVersion
  const routeUpdated = rv && SYSTEM_ROUTE.includes(rv.reason)
    && (trip.needsAck || (trip.routeReceivedAt && now - new Date(trip.routeReceivedAt).getTime() < 60_000))
  const removed = trip.removedStops ?? []

  const locationNote = {
    sharing: [LocateFixed, 'success', `Đang chia sẻ vị trí · cập nhật ${ago(location.lastSentAt, now)}`],
    denied: [LocateFixed, 'warning', 'Bật quyền vị trí cho trình duyệt'],
    unavailable: [LocateFixed, 'warning', 'Thiết bị không lấy được vị trí'],
    failed: [WifiOff, 'warning', `Chưa gửi được vị trí${location.lastSentAt ? ` · lần cuối lúc ${time(location.lastSentAt)}` : ''}`],
    idle: [LocateFixed, 'muted', trip.position ? `Vị trí gần nhất ${ago(trip.position.observedAt, now)}` : 'Đang chờ vị trí'],
  }[online ? location.status : 'failed']
  const [LocIcon, locTone, locText] = locationNote

  return (
    <DriverScreen title={`Chuyến ${trip.code}`} subtitle={`${vehicle} · ${trip.progress.done}/${total} điểm`}
      footer={<>
        {allDone
          ? <>
            <Button size="large" block disabled={waiting > 0} onClick={() => navigate('/driver/return')}>Báo về kho</Button>
            {waiting > 0 && <span className="caption warning" style={{ textAlign: 'center' }}>Còn {waiting} kết quả chờ gửi</span>}
          </>
          : next && <Button size="large" block onClick={() => navigate(`/driver/stops/${next.id}`)}>Ghi kết quả giao</Button>}
        <span className={`row caption ${locTone}`} style={{ justifyContent: 'center', gap: 8 }}><LocIcon size={16} />{locText}</span>
      </>}>
      {!online && (
        <div className="banner danger">
          <div className="row" style={{ gap: 8 }}><WifiOff size={20} className="danger" /><span className="body-large strong">Đang ngoại tuyến · kết quả sẽ tự gửi</span></div>
        </div>
      )}
      {routeUpdated && (
        <div className="banner info">
          <div className="row" style={{ gap: 8 }}><RefreshCw size={20} className="brand" /><span className="body-large strong">Tuyến đã cập nhật · {time(rv.createdAt)}</span></div>
        </div>
      )}
      {removed.length > 0 && (
        <div className="banner">
          <div className="row top" style={{ gap: 8 }}>
            <PackageX size={20} className="warning" />
            <div className="col">
              <span className="body-large strong">Mang về kho {removed.length} kiện</span>
              {removed.map(r => <span key={r.stopId} className="caption secondary">{r.orderCode} · {r.reason}</span>)}
            </div>
          </div>
        </div>
      )}
      {failedSync.length > 0 && (
        <Alert tone="danger" title="Có kết quả không gửi được" action={<Button variant="secondary" onClick={retry}>Thử lại</Button>}>
          {failedSync.map(x => (
            <span key={x.clientEventId} className="row between" style={{ gap: 8 }}>
              <span>{x.label}: {x.error}</span>
              <Button variant="ghost" onClick={() => removeItem(x.clientEventId).catch(() => {})}>Bỏ</Button>
            </span>
          ))}
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
                {isHeld(x, now) ? (
                  <div className="row between" style={{ paddingLeft: 12, gap: 8 }}>
                    <span className="sync pending">Gửi sau {Math.ceil((Date.parse(x.sendAfter) - now) / 1000)} giây</span>
                    <Button variant="secondary" icon={Undo2} onClick={() => removeItem(x.clientEventId).catch(() => {})}>Hoàn tác</Button>
                  </div>
                ) : (
                  <div className="row" style={{ paddingLeft: 12, gap: 8 }}>
                    <span className={`sync ${x.state === 'sending' ? 'sending' : 'pending'}`}>{x.state === 'sending' ? 'Đang gửi' : 'Chờ gửi'}</span>
                    <span className="caption muted">Lưu trên máy lúc {time(x.createdAt)}</span>
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}
      {next && <NextStopCard stop={next} total={total} />}
      {allDone && <Alert tone="success" title="Đã xử lý hết các điểm" />}
      {rest.length > 0 && (
        <>
          <div className="row between"><span className="h4">Các điểm còn lại</span><span className="caption muted">{rest.length} điểm</span></div>
          {rest.map(s => <StopItem key={s.id} state="pending" seq={s.seq} name={s.order.recipientName} address={s.order.address}
            meta={`${s.eta ? `Dự kiến ${time(s.eta)} · ` : ''}${kg(s.order.weightKg)} · ${parcels(s.order.parcels)}${s.deferred ? ' · Giao sau' : ''}`}
            right={<Appointment stop={s} />} onClick={() => navigate(`/driver/stops/${s.id}`)} />)}
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
