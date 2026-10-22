// R06 Báo về kho (UC14): Driver khai báo hàng còn lại. Báo cáo chỉ được nhận khi mọi kết quả đã được máy chủ xác nhận,
// và không tự chốt chuyến; Dispatcher đối chiếu rồi mới chốt.
import { ChevronLeft, Warehouse } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, newEventId } from '../../api.js'
import { DriverScreen } from '../../layouts/DriverLayout.jsx'
import { useDriver } from '../../layouts/driverContext.js'
import { Alert, Button, ErrorBox, Loading } from '../../components/ui.jsx'
import { kg, time, VEHICLE_TYPE } from '../../format.js'
import { useAction } from '../../hooks.js'

export default function ReturnPage() {
  const navigate = useNavigate()
  const { trip, rawTrip, outbox, setTrip } = useDriver()
  const [checked, setChecked] = useState(() => new Set())
  const action = useAction()
  const eventId = useRef(newEventId())
  if (trip === undefined) return <DriverScreen title="Báo về kho"><Loading /></DriverScreen>
  const back = <button type="button" className="btn ghost icon-only" onClick={() => navigate('/driver')} title="Quay lại"><ChevronLeft size={22} /></button>
  if (!trip || trip.status !== 'in_progress') {
    return <DriverScreen title="Báo về kho" back={back}><Alert tone="info" title="Không có chuyến đang giao để báo về kho" /></DriverScreen>
  }
  const failed = trip.stops.filter(s => s.status === 'failed')
  const delivered = trip.stops.filter(s => s.status === 'delivered')
  // Kết quả máy chủ đã từ chối không còn chờ gửi; điểm đó vẫn được tính vào serverPending
  const waiting = outbox.filter(x => x.tripId === trip.id && x.state !== 'failed').length
  const serverPending = rawTrip.stops.filter(s => s.status === 'pending').length

  async function send() {
    const res = await action.run(() => api(`/driver/trips/${trip.id}/return`, { method: 'POST', body: { clientEventId: eventId.current, returnedOrderIds: [...checked] } }))
    if (res) { setTrip(res.trip); navigate('/driver') }
  }

  return (
    <DriverScreen title={`Chuyến ${trip.code}`} subtitle={`${VEHICLE_TYPE[trip.vehicle.type]} ${trip.vehicle.plate} · ${trip.progress.done}/${trip.stops.length} điểm`} back={back}
      footer={<Button size="large" block loading={action.busy} disabled={waiting > 0 || serverPending > 0} onClick={send}>Gửi báo cáo về kho</Button>}>
      <section className="card" style={{ gap: 12 }}>
        <div className="row between"><span className="h4">Kết quả chuyến</span><span className="caption muted">{trip.stops.length - serverPending}/{trip.stops.length} điểm</span></div>
        <div className="row top">
          <div className="tile success grow" style={{ border: 0, padding: 12 }}><span className="metric-value success">{delivered.length}</span><span className="medium secondary">Giao thành công</span></div>
          <div className="tile danger grow" style={{ padding: 12 }}><span className="metric-value danger">{failed.length}</span><span className="medium secondary">Chưa giao được</span></div>
        </div>
        <span className="row caption muted" style={{ gap: 8 }}><Warehouse size={16} /> {trip.depot.name} · bây giờ {time(new Date())}</span>
      </section>
      {(waiting > 0 || serverPending > 0) && (
        <Alert tone="warning" title="Còn kết quả chưa gửi xong" />
      )}
      {failed.length > 0 && (
        <section className="card" style={{ gap: 8 }}>
          <span className="h4">Hàng mang về kho ({failed.length} kiện)</span>
          <p className="secondary">Đánh dấu từng kiện đã mang về đủ.</p>
          <div>
            {failed.map(s => (
              <label key={s.id} className="check-row" style={{ cursor: 'pointer' }}>
                <span className="check" style={{ fontSize: 15 }}>
                  <input type="checkbox" checked={checked.has(s.order.id)} onChange={e => {
                    const n = new Set(checked)
                    if (e.target.checked) n.add(s.order.id); else n.delete(s.order.id)
                    setChecked(n)
                  }} />
                  <span>{s.order.code} · {s.order.recipientName}</span>
                </span>
                <span className="medium secondary">{kg(s.order.weightKg)}</span>
              </label>
            ))}
          </div>
        </section>
      )}
      <ErrorBox error={action.error} />
    </DriverScreen>
  )
}
