// D03 Tạo đơn / sửa đơn (UC02). Vị trí giao chọn bằng cách bấm trên bản đồ hoặc tìm theo địa chỉ.
import { MapPin, Search } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api } from '../../api.js'
import MapView from '../../components/MapView.jsx'
import { Button, Card, Checkbox, ErrorBox, Field, Loading, PageHeader } from '../../components/ui.jsx'
import { useAction, useLoad } from '../../hooks.js'

const EMPTY = { code: '', recipientName: '', phone: '', address: '', weightKg: '', note: '', lat: null, lon: null, vehicleTypes: ['motorcycle', 'small_truck'] }

export default function OrderFormPage() {
  const { id } = useParams()
  const depot = useLoad(() => api('/depots'))
  const existing = useLoad(() => (id ? api(`/orders/${id}`) : Promise.resolve(null)), [id])
  if (id && (existing.loading || !existing.data)) return existing.error ? <ErrorBox error={existing.error} /> : <Loading />
  const order = existing.data?.order
  const initial = order ? { ...order, weightKg: String(order.weightKg).replace('.', ','), note: order.note ?? '' } : EMPTY
  return <OrderForm key={id ?? 'new'} id={id} order={order} initial={initial} depot={depot.data?.depots[0]} />
}

function OrderForm({ id, order, initial, depot: d }) {
  const navigate = useNavigate()
  const [form, setForm] = useState(initial)
  const [touched, setTouched] = useState(false)
  const [results, setResults] = useState(null)
  const save = useAction()
  const search = useAction()
  const readOnly = order && order.status !== 'pending'
  const set = k => e => setForm({ ...form, [k]: e.target.value })
  const weight = Number(String(form.weightKg).replace(',', '.'))
  const weightError = touched && !(weight > 0) ? 'Khối lượng phải lớn hơn 0' : null
  const typeError = touched && !form.vehicleTypes.length ? 'Chọn ít nhất một loại xe' : null
  const pinError = touched && form.lat == null ? 'Bấm vào bản đồ để chọn vị trí giao' : null
  const toggleType = (t, on) => setForm({ ...form, vehicleTypes: on ? [...new Set([...form.vehicleTypes, t])] : form.vehicleTypes.filter(x => x !== t) })

  async function submit(e) {
    e.preventDefault()
    setTouched(true)
    if (!(weight > 0) || !form.vehicleTypes.length || form.lat == null) return
    const body = { ...form, weightKg: weight }
    const ok = await save.run(() => (id ? api(`/orders/${id}`, { method: 'PUT', body }) : api('/orders', { method: 'POST', body })))
    if (ok) navigate('/dispatcher/orders')
  }

  async function geocode() {
    const d = await search.run(() => api(`/map/geocode?q=${encodeURIComponent(form.address)}`))
    if (d) setResults(d)
  }

  async function cancelOrder() {
    if (await save.run(() => api(`/orders/${id}/cancel`, { method: 'POST' }))) navigate('/dispatcher/orders')
  }

  return (
    <form className="stack-lg" onSubmit={submit}>
      <PageHeader title={id ? `Sửa đơn ${order?.code ?? ''}` : 'Tạo đơn hàng'}
        actions={<>
          {id && !readOnly && <Button variant="secondary" onClick={cancelOrder} disabled={save.busy}>Hủy đơn</Button>}
          <Button variant="secondary" onClick={() => navigate('/dispatcher/orders')}>Quay lại</Button>
          {!readOnly && <Button type="submit" loading={save.busy}>Lưu đơn</Button>}
        </>} />
      {readOnly && <ErrorBox error={{ message: 'Đơn đã vào kế hoạch nên không sửa được. Chỉ sửa đơn đang chờ xếp.' }} />}
      <ErrorBox error={save.error} />
      <div className="grid-2">
        <Card title="Thông tin đơn">
          <fieldset disabled={readOnly} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <Field label="Mã đơn"><input className="input" value={form.code} onChange={set('code')} required maxLength={20} placeholder="DH-1050" /></Field>
            <Field label="Người nhận"><input className="input" value={form.recipientName} onChange={set('recipientName')} required maxLength={100} /></Field>
            <Field label="Số điện thoại"><input className="input" value={form.phone} onChange={set('phone')} required maxLength={20} inputMode="tel" /></Field>
            <Field label="Địa chỉ" helper="Ghi số nhà, đường và phường để tìm vị trí chính xác">
              <div className="row" style={{ gap: 8 }}>
                <input className="input" value={form.address} onChange={set('address')} required maxLength={255} />
                <Button variant="secondary" icon={Search} onClick={geocode} loading={search.busy} disabled={form.address.trim().length < 3} title="Tìm vị trí theo địa chỉ" />
              </div>
            </Field>
            {search.error && <span className="field-error">{search.error.message}</span>}
            {results && (
              <div className="stack-sm">
                {results.message && <span className="caption muted">{results.message}</span>}
                {results.results.map(r => (
                  <button key={`${r.lat},${r.lon}`} type="button" className="todo" style={{ border: 0, cursor: 'pointer', textAlign: 'left' }}
                    onClick={() => { setForm({ ...form, lat: r.lat, lon: r.lon }); setResults(null) }}>
                    <MapPin size={16} className="brand" /><span className="grow">{r.address}</span><span className="caption muted">độ khớp {r.score?.toFixed(2)}</span>
                  </button>
                ))}
              </div>
            )}
            <Field label="Khối lượng (kg)" error={weightError}>
              <input className={`input${weightError ? ' invalid' : ''}`} value={form.weightKg} onChange={set('weightKg')} inputMode="decimal" required />
            </Field>
            <Field label="Loại xe được phép" error={typeError}>
              <div className="row" style={{ gap: 24 }}>
                <Checkbox label="Xe máy" checked={form.vehicleTypes.includes('motorcycle')} onChange={v => toggleType('motorcycle', v)} />
                <Checkbox label="Xe tải nhỏ" checked={form.vehicleTypes.includes('small_truck')} onChange={v => toggleType('small_truck', v)} />
              </div>
            </Field>
            <Field label="Ghi chú cho Driver"><textarea className="textarea" value={form.note} onChange={set('note')} maxLength={255} placeholder="Ví dụ: gọi trước 10 phút" /></Field>
          </fieldset>
        </Card>
        <Card title={<div className="col"><h3 className="h4">Vị trí giao hàng</h3><span className="secondary">Bấm vào bản đồ để chọn toạ độ</span></div>}>
          <MapView height={520} depot={d && { ...d, name: d.name }} pin={form.lat != null ? { lat: form.lat, lon: form.lon } : null}
            onClick={readOnly ? undefined : p => setForm(f => ({ ...f, lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) }))}
            fitKey={form.lat != null ? `${form.lat}` : 'depot'} />
          <div className="row">
            <MapPin size={16} className="brand" />
            <span className="secondary">Toạ độ đã chọn:</span>
            <span className="strong tabular">{form.lat != null ? `${form.lat.toFixed(4)}, ${form.lon.toFixed(4)}` : 'chưa chọn'}</span>
          </div>
          {pinError && <span className="field-error">{pinError}</span>}
        </Card>
      </div>
    </form>
  )
}
