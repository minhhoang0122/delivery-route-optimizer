// Trang theo dõi đơn của khách (không đăng nhập), mở từ đường dẫn có mã theo dõi. Điện thoại là chính.
// Hiện trạng thái đơn, khung giờ dự kiến, số điểm dừng trước điểm của khách, vị trí xe khi còn tối đa 2 điểm dừng,
// kết quả giao; khách tự hẹn "giao sau HH:MM" hoặc hẹn ngày khác trước khi tài xế đến.
import { CalendarX, Clock, MapPin, PackageCheck, Truck } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router'
import { api } from '../api.js'
import MapView from '../components/MapView.jsx'
import { Alert, Badge, Button, Dialog, ErrorBox, Field, KeyValue, Loading } from '../components/ui.jsx'
import { ago, CUSTOMER_STATUS, time } from '../format.js'
import { useAction, useLoad, useNow } from '../hooks.js'

const TONE = { delivered: 'success', needs_action: 'danger', in_delivery: 'purple', assigned: 'info', pending: 'neutral' }

export default function CustomerTrackingPage() {
  const { token } = useParams()
  const { data, error, loading, reload, setData } = useLoad(() => api(`/public/tracking/${token}`), [token], { interval: 30_000 })
  const now = useNow(15_000)
  const [ask, setAsk] = useState(null)
  const action = useAction()
  const t = data?.tracking

  async function send(path, body) {
    const d = await action.run(() => api(`/public/tracking/${token}/${path}`, { method: 'POST', body }))
    if (d) { setData(d); setAsk(null) }
  }

  if (loading && !data) return <div className="mobile"><Loading /></div>
  if (!t) {
    return (
      <div className="mobile">
        <header className="topbar"><span className="topbar-title grow">Theo dõi đơn</span></header>
        <main className="mobile-body">
          {error?.status === 404 ? <Alert tone="warning" title="Không tìm thấy đơn" /> : <ErrorBox error={error} onRetry={reload} />}
        </main>
      </div>
    )
  }

  const open = t.actions && ['assigned', 'in_delivery'].includes(t.status)
  return (
    <div className="mobile">
      <header className="topbar">
        <span className="topbar-title grow">Đơn {t.code}</span>
        <Badge tone={TONE[t.status] ?? 'neutral'}>{CUSTOMER_STATUS[t.status] ?? t.status}</Badge>
      </header>
      <main className="mobile-body">
        <ErrorBox error={error} onRetry={reload} />
        {t.result?.result === 'delivered' && (
          <section className="card" style={{ gap: 8 }}>
            <span className="row strong success" style={{ gap: 8 }}><PackageCheck size={22} /> Đã giao lúc {time(t.result.at)}</span>
          </section>
        )}
        {t.result?.result === 'failed' && t.status !== 'pending' && (
          <Alert tone="danger" title={`Chưa giao được lúc ${time(t.result.at)}`}>{t.result.reason}</Alert>
        )}
        {t.eta && (
          <section className="card" style={{ gap: 12 }}>
            <div className="col">
              <span className="caption muted">Dự kiến giao</span>
              <span className="driver-title tabular">{time(t.eta.from)} – {time(t.eta.to)}</span>
            </div>
            <div className="row top" style={{ gap: 16 }}>
              {t.stopsBefore != null && <div className="grow"><KeyValue label="Điểm dừng trước bạn" value={t.stopsBefore} large /></div>}
              {t.driverName && <div className="grow"><KeyValue label="Tài xế" value={t.driverName} large /></div>}
            </div>
            {t.notBeforeAt && <span className="tag-time" style={{ alignSelf: 'flex-start', fontSize: 14 }}><Clock size={14} />Giao sau {time(t.notBeforeAt)}</span>}
          </section>
        )}
        {!t.eta && t.notBeforeAt && t.status !== 'delivered' && <Alert tone="info" title={`Giao sau ${time(t.notBeforeAt)}`} />}
        {t.vehicle && t.destination && (
          <section className="card" style={{ gap: 8, padding: 0, overflow: 'hidden' }}>
            <MapView height={280} pin={t.destination} vehicles={[{ key: 'xe', lat: t.vehicle.lat, lon: t.vehicle.lon, color: '#1f5fae', label: ago(t.vehicle.observedAt, now) }]}
              fitKey={`${t.code}-${t.stopsBefore}`} />
            <span className="row caption muted" style={{ gap: 6, padding: '0 12px 12px' }}><Truck size={14} /> Xe đang đến · <MapPin size={14} /> Điểm giao của bạn</span>
          </section>
        )}
        {open && (
          <div className="stack-sm">
            <Button size="large" block variant="secondary" icon={Clock} onClick={() => { action.setError(null); setAsk({ kind: 'defer', time: t.actions.deferTimes[0] ?? '' }) }}
              disabled={!t.actions.deferTimes.length}>Tôi không có nhà, giao sau…</Button>
            <Button size="large" block variant="secondary" icon={CalendarX} onClick={() => { action.setError(null); setAsk({ kind: 'reschedule' }) }}>Hẹn ngày khác</Button>
          </div>
        )}
      </main>
      {ask?.kind === 'defer' && (
        <Dialog title="Giao sau" confirmLabel="Xác nhận" busy={action.busy} confirmDisabled={!ask.time}
          onCancel={() => setAsk(null)} onConfirm={() => send('defer', { time: ask.time })}>
          <Field label="Nhận hàng từ">
            <select className="select" value={ask.time} onChange={e => setAsk({ ...ask, time: e.target.value })}>
              {t.actions.deferTimes.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
          <ErrorBox error={action.error} />
        </Dialog>
      )}
      {ask?.kind === 'reschedule' && (
        <Dialog tone="danger" title="Hẹn ngày khác?" confirmLabel="Hẹn ngày khác" busy={action.busy}
          onCancel={() => setAsk(null)} onConfirm={() => send('reschedule', {})}>
          <ErrorBox error={action.error} />
        </Dialog>
      )}
    </div>
  )
}
