// D03 Tạo đơn / sửa đơn (UC02). Vị trí giao chọn bằng cách bấm trên bản đồ hoặc tìm theo địa chỉ.
// Sửa địa chỉ thì bỏ vị trí đã chọn; đơn trùng (cùng người nhận, địa chỉ, số điện thoại đang chờ xếp) hỏi lại trước khi lưu.
import { Copy, ExternalLink, MapPin, Search, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api } from '../../api.js'
import MapView from '../../components/MapView.jsx'
import { Alert, Button, Card, Checkbox, Dialog, ErrorBox, Field, Loading, LoadError, PageHeader, StatusBadge } from '../../components/ui.jsx'
import { appointment, geocodeMatch, ORDER_STATUS, streetLevelOnly } from '../../format.js'
import { useAction, useLoad } from '../../hooks.js'

const EMPTY = { code: '', recipientName: '', phone: '', address: '', weightKg: '', parcels: '1', note: '', lat: null, lon: null, vehicleTypes: ['motorcycle', 'small_truck'] }

export default function OrderFormPage() {
  const { id } = useParams()
  const depot = useLoad(() => api('/depots'))
  const existing = useLoad(() => (id ? api(`/orders/${id}`) : Promise.resolve(null)), [id])
  if (id && (existing.loading || !existing.data)) {
    return existing.error ? <LoadError error={existing.error} onRetry={existing.reload} notFound="Không tìm thấy đơn" back="/dispatcher/orders" /> : <Loading />
  }
  const order = existing.data?.order
  const initial = order ? { ...order, weightKg: String(order.weightKg).replace('.', ','), parcels: String(order.parcels ?? 1), note: order.note ?? '' } : EMPTY
  return <OrderForm key={id ?? 'new'} id={id} order={order} initial={initial} depot={depot.data?.depots[0]} />
}

function OrderForm({ id, order, initial, depot: d }) {
  const navigate = useNavigate()
  const [form, setForm] = useState(initial)
  const [touched, setTouched] = useState(false)
  const [results, setResults] = useState(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  // Mức khớp của kết quả tìm địa chỉ đã chọn (null: chọn trên bản đồ hoặc vị trí cũ)
  const [match, setMatch] = useState(null)
  const save = useAction()
  const search = useAction()
  const readOnly = order && order.status !== 'pending'
  const set = k => e => setForm({ ...form, [k]: e.target.value })
  // Địa chỉ đổi thì vị trí đã chọn không còn đúng: bỏ để chọn lại
  const setAddress = e => { setForm({ ...form, address: e.target.value, lat: null, lon: null }); setMatch(null); setResults(null) }
  const weight = Number(String(form.weightKg).replace(',', '.'))
  const weightError = touched && !(weight > 0) ? 'Khối lượng phải lớn hơn 0' : null
  const pieces = Number(form.parcels)
  const parcelsError = touched && !(Number.isInteger(pieces) && pieces >= 1) ? 'Số kiện là số nguyên từ 1' : null
  // Đường dẫn theo dõi đơn gửi cho khách (khách mở không cần đăng nhập)
  const trackingUrl = order?.trackingToken ? `${window.location.origin}/theo-doi/${order.trackingToken}` : null
  const [copied, setCopied] = useState(false)
  const copyLink = () => navigator.clipboard?.writeText(trackingUrl).then(() => setCopied(true)).catch(() => {})
  const typeError = touched && !form.vehicleTypes.length ? 'Chọn ít nhất một loại xe' : null
  const pinError = touched && form.lat == null ? 'Bấm vào bản đồ để chọn vị trí giao' : null
  const toggleType = (t, on) => setForm({ ...form, vehicleTypes: on ? [...new Set([...form.vehicleTypes, t])] : form.vehicleTypes.filter(x => x !== t) })

  async function submit(e, allowDuplicate = false) {
    e?.preventDefault()
    setTouched(true)
    if (!(weight > 0) || parcelsError || !form.vehicleTypes.length || form.lat == null) return
    const body = { ...form, weightKg: weight, parcels: pieces, allowDuplicate }
    const ok = await save.run(() => (id ? api(`/orders/${id}`, { method: 'PUT', body }) : api('/orders', { method: 'POST', body })))
    if (ok) navigate('/dispatcher/orders')
  }
  const dupError = save.error?.code === 'DUPLICATE_ORDER' ? save.error : null

  async function geocode() {
    const d = await search.run(() => api(`/map/geocode?q=${encodeURIComponent(form.address)}`))
    if (d) setResults(d)
  }

  async function cancelOrder() {
    if (await save.run(() => api(`/orders/${id}/cancel`, { method: 'POST' }))) navigate('/dispatcher/orders')
  }

  return (
    <form className="stack-lg" onSubmit={submit}>
      <PageHeader title={id ? (readOnly ? `Đơn ${order?.code ?? ''}` : `Sửa đơn ${order?.code ?? ''}`) : 'Tạo đơn hàng'}
        badge={order && <StatusBadge map={ORDER_STATUS} value={order.status} />}
        actions={<>
          {id && !readOnly && <Button variant="secondary" onClick={() => { save.setError(null); setConfirmCancel(true) }} disabled={save.busy}>Hủy đơn</Button>}
          <Button variant="secondary" onClick={() => navigate('/dispatcher/orders')}>Quay lại</Button>
          {!readOnly && <Button type="submit" loading={save.busy}>Lưu đơn</Button>}
        </>} />
      {readOnly && (
        <Alert tone="info" title={order.trip ? `Chuyến ${order.trip.code}` : 'Đơn không còn chờ xếp'}
          action={order.trip && <Link className="btn secondary" to={`/dispatcher/trips/${order.trip.id}`}>Xem chuyến</Link>}>
          {order.notBeforeAt ? appointment(order.notBeforeAt) : undefined}
        </Alert>
      )}
      {!readOnly && order?.notBeforeAt && <Alert tone="info" title={appointment(order.notBeforeAt)} />}
      {trackingUrl && (
        <Card compact title="Đường dẫn theo dõi đơn">
          <div className="row" style={{ gap: 8 }}>
            <input className="input grow" value={trackingUrl} readOnly onFocus={e => e.target.select()} />
            <Button variant="secondary" icon={Copy} onClick={copyLink}>{copied ? 'Đã sao chép' : 'Sao chép'}</Button>
            <a className="btn ghost icon-only" href={trackingUrl} target="_blank" rel="noreferrer" title="Mở trang theo dõi"><ExternalLink size={18} /></a>
          </div>
        </Card>
      )}
      <ErrorBox error={dupError ? null : save.error} />
      <div className="grid-2">
        <Card title="Thông tin đơn">
          <fieldset disabled={readOnly} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <Field label="Mã đơn"><input className="input" value={form.code} onChange={set('code')} required maxLength={20} placeholder="DH-1050" /></Field>
            <Field label="Người nhận"><input className="input" value={form.recipientName} onChange={set('recipientName')} required maxLength={100} /></Field>
            <Field label="Số điện thoại"><input className="input" value={form.phone} onChange={set('phone')} required maxLength={20} inputMode="tel" /></Field>
            <Field label="Địa chỉ">
              <div className="row" style={{ gap: 8 }}>
                <input className="input" value={form.address} onChange={setAddress} required maxLength={255} placeholder="Số nhà, đường, phường" />
                <Button variant="secondary" icon={Search} onClick={geocode} loading={search.busy} disabled={form.address.trim().length < 3} title="Tìm vị trí theo địa chỉ" />
              </div>
            </Field>
            {search.error && <span className="field-error">{search.error.message}</span>}
            {results && (
              <div className="stack-sm">
                {results.message && <span className="caption muted">{results.message}</span>}
                {results.results.map(r => (
                  <button key={`${r.lat},${r.lon}`} type="button" className="todo" style={{ border: 0, cursor: 'pointer', textAlign: 'left' }}
                    onClick={() => { setForm({ ...form, lat: r.lat, lon: r.lon }); setMatch(r.type); setResults(null) }}>
                    <MapPin size={16} className="brand" /><span className="grow">{r.address}</span>
                    <span className={`caption ${streetLevelOnly(r.type) ? 'warning' : 'muted'}`}>{geocodeMatch(r.type)}</span>
                  </button>
                ))}
              </div>
            )}
            <Field label="Khối lượng (kg)" error={weightError}>
              <input className={`input${weightError ? ' invalid' : ''}`} value={form.weightKg} onChange={set('weightKg')} inputMode="decimal" required />
            </Field>
            <Field label="Số kiện" error={parcelsError}>
              <input className={`input${parcelsError ? ' invalid' : ''}`} value={form.parcels} onChange={set('parcels')} inputMode="numeric" required />
            </Field>
            <Field label="Loại xe được phép" error={typeError}>
              <div className="row" style={{ gap: 24 }}>
                <Checkbox label="Xe máy" checked={form.vehicleTypes.includes('motorcycle')} onChange={v => toggleType('motorcycle', v)} />
                <Checkbox label="Xe tải nhỏ" checked={form.vehicleTypes.includes('small_truck')} onChange={v => toggleType('small_truck', v)} />
              </div>
            </Field>
            <Field label="Ghi chú cho tài xế"><textarea className="textarea" value={form.note} onChange={set('note')} maxLength={255} placeholder="Ví dụ: gọi trước 10 phút" /></Field>
          </fieldset>
        </Card>
        <Card title="Vị trí giao hàng">
          <MapView height={520} depot={d && { ...d, name: d.name }} pin={form.lat != null ? { lat: form.lat, lon: form.lon } : null}
            onClick={readOnly ? undefined : p => { setForm(f => ({ ...f, lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) })); setMatch(null) }}
            fitKey={form.lat != null ? `${form.lat}` : 'depot'} />
          <div className="row">
            <MapPin size={16} className="brand" />
            <span className="secondary">Toạ độ đã chọn:</span>
            <span className="strong tabular">{form.lat != null ? `${form.lat.toFixed(4)}, ${form.lon.toFixed(4)}` : 'chưa chọn'}</span>
          </div>
          {pinError && <span className="field-error">{pinError}</span>}
          {match && streetLevelOnly(match) && form.lat != null && (
            <span className="row caption warning" style={{ gap: 6 }}><TriangleAlert size={14} /> {geocodeMatch(match)}, chưa khớp số nhà</span>
          )}
        </Card>
      </div>
      {dupError && (
        <Dialog tone="warning" title={dupError.message} confirmLabel="Vẫn lưu" cancelLabel="Quay lại" busy={save.busy}
          onCancel={() => save.setError(null)} onConfirm={() => submit(null, true)} />
      )}
      {confirmCancel && (
        <Dialog tone="danger" title={`Hủy đơn ${order?.code ?? ''}?`} confirmLabel="Hủy đơn" cancelLabel="Không" busy={save.busy}
          onCancel={() => setConfirmCancel(false)} onConfirm={cancelOrder}>
          <ErrorBox error={save.error} />
        </Dialog>
      )}
    </form>
  )
}
