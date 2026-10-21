// R03 Ghi kết quả giao và R04 Chưa giao được, chọn lý do (UC13, UC13.1, UC13.2).
// Kết quả được lưu vào hàng đợi trên máy trước rồi mới gửi, nên mất mạng vẫn ghi được; mã thao tác giúp máy chủ
// không ghi trùng khi thiết bị gửi lại.
import { Check, ChevronLeft, Info, Phone, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { newEventId } from '../../api.js'
import { DriverScreen } from '../../layouts/DriverLayout.jsx'
import { useDriver } from '../../layouts/driverContext.js'
import { Alert, Badge, Button, Field, KeyValue, Loading } from '../../components/ui.jsx'
import { FAIL_REASONS, kg } from '../../format.js'
import { enqueue, flush } from '../../offline.js'

export default function StopResultPage() {
  const { stopId } = useParams()
  const navigate = useNavigate()
  const { trip, sync } = useDriver()
  const [mode, setMode] = useState('view')
  const [reason, setReason] = useState(FAIL_REASONS[0])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  if (trip === undefined) return <DriverScreen title="Điểm dừng"><Loading /></DriverScreen>
  const stop = trip?.stops.find(s => s.id === Number(stopId))
  const back = <button type="button" className="btn ghost icon-only" onClick={() => (mode === 'fail' ? setMode('view') : navigate('/driver'))} title="Quay lại"><ChevronLeft size={22} /></button>
  if (!stop) {
    return <DriverScreen title="Điểm dừng" back={back}><Alert tone="warning" title="Không tìm thấy điểm dừng trong chuyến hiện tại" /></DriverScreen>
  }
  const o = stop.order
  const total = trip.stops.length

  async function submit(result) {
    if (result === 'failed' && reason === 'Khác' && !note.trim()) return setError('Ghi chú bắt buộc khi chọn “Khác”')
    setBusy(true)
    setError(null)
    const clientEventId = newEventId()
    const body = {
      clientEventId, result, occurredAt: new Date().toISOString(),
      ...(result === 'failed' ? { reason, note: note.trim() || undefined } : {}),
    }
    try {
      await enqueue({
        clientEventId, kind: 'attempt', tripId: trip.id, stopId: stop.id, body,
        path: `/driver/trips/${trip.id}/stops/${stop.id}/attempts`, label: `Điểm ${stop.seq} (${o.code})`,
      })
      // Gửi ngay nếu có mạng; mất mạng thì kết quả vẫn nằm trong hàng đợi và tự gửi sau
      flush().then(sync)
      navigate('/driver')
    } catch (e) {
      setError(`Không lưu được trên máy: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  if (stop.status !== 'pending') {
    return (
      <DriverScreen title={`Điểm ${stop.seq}/${total}`} subtitle={`${o.recipientName}`} back={back}>
        <Alert tone="info" title="Điểm dừng đã có kết quả">{stop.status === 'delivered' ? 'Giao thành công' : `Chưa giao được: ${stop.attempt?.reason}`}{stop.queued ? ' · đang chờ gửi' : ''}</Alert>
      </DriverScreen>
    )
  }

  if (mode === 'fail') {
    return (
      <DriverScreen title={`Điểm ${stop.seq}/${total}`} subtitle={`${o.recipientName} · ${o.address.split(',')[0]}`} back={back}
        footer={<Button size="large" block loading={busy} onClick={() => submit('failed')}>Gửi kết quả</Button>}>
        <span className="driver-title">Lý do chưa giao được</span>
        <p className="secondary">Kiện {o.code} sẽ được mang về kho để Dispatcher đối chiếu.</p>
        <div className="stack-sm" role="radiogroup">
          {FAIL_REASONS.map(r => (
            <label key={r} className={`option${reason === r ? ' selected' : ''}`}>
              <input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} /> {r}
            </label>
          ))}
        </div>
        <Field label="Ghi chú" helper="Bắt buộc khi chọn “Khác”" error={error}>
          <textarea className="textarea" value={note} onChange={e => setNote(e.target.value)} maxLength={255} placeholder="Ví dụ: đã gọi 2 lần, không nghe máy" />
        </Field>
      </DriverScreen>
    )
  }

  return (
    <DriverScreen title={`Điểm ${stop.seq}/${total}`} subtitle={`${o.recipientName} · ${o.address.split(',')[0]}`} back={back}
      footer={<>
        <Button size="large" block icon={Check} loading={busy} onClick={() => submit('delivered')}>Giao thành công</Button>
        <Button size="large" block variant="danger" icon={X} onClick={() => setMode('fail')} disabled={busy}>Chưa giao được</Button>
      </>}>
      <section className="card" style={{ gap: 16 }}>
        <div className="row between"><span className="h3">{o.code}</span><Badge tone="purple" large>Đang giao</Badge></div>
        <div className="stack">
          <KeyValue label="Người nhận" value={o.recipientName} large />
          <KeyValue label="Địa chỉ" value={o.address} large />
          <div className="row top">
            <div className="grow"><KeyValue label="Số điện thoại" value={o.phone} large /></div>
            <div className="grow"><KeyValue label="Khối lượng" value={kg(o.weightKg)} large /></div>
          </div>
        </div>
        {o.note && (
          <div className="row top" style={{ padding: 12, borderRadius: 8, background: 'var(--bg-warning-subtle)', gap: 8 }}>
            <Info size={18} className="warning" />
            <div className="col"><span className="caption strong warning">Ghi chú của người nhận</span><span className="body-large">{o.note}</span></div>
          </div>
        )}
        <a className="btn secondary large block" href={`tel:${o.phone.replace(/\s/g, '')}`}><Phone size={18} /> Gọi người nhận</a>
      </section>
      {error && <Alert tone="danger" title={error} />}
    </DriverScreen>
  )
}
