// D07 Kho (UC03.3): kho xuất phát dùng làm điểm đầu và điểm cuối của mọi chuyến giao.
import { Warehouse } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api.js'
import MapView from '../../components/MapView.jsx'
import { Button, Card, ErrorBox, Field, Loading, PageHeader } from '../../components/ui.jsx'
import { useAction, useLoad } from '../../hooks.js'

export default function DepotPage() {
  const { data, error, loading, reload } = useLoad(() => api('/depots'))
  const [edit, setEdit] = useState(null)
  const action = useAction()
  if (loading && !data) return <Loading />
  const d = data?.depots[0]
  const c = data?.counts

  async function save() {
    if (await action.run(() => api(`/depots/${d.id}`, { method: 'PUT', body: edit }))) { setEdit(null); reload() }
  }

  const view = edit || d
  const lines = d && [
    ['Địa chỉ', d.address],
    ['Toạ độ', `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`],
    ['Giờ mở cửa', d.openingHours || '—'],
    ['Phương tiện', `${c.vehicles} xe (${c.motorcycles} xe máy, ${c.vehicles - c.motorcycles} xe tải nhỏ)`],
    ['Driver', `${c.drivers} Driver`],
  ]
  return (
    <>
      <PageHeader title="Kho" subtitle="Kho xuất phát dùng làm điểm đầu và điểm cuối của mọi chuyến giao." />
      <ErrorBox error={error} onRetry={reload} />
      {d && (
        <div className="grid-2">
          <Card>
            <div className="row">
              <span className="icon-wrap tone-info"><Warehouse size={18} /></span>
              <div className="col"><h3 className="h3">{d.name}</h3><span className="caption muted">Kho duy nhất của hệ thống</span></div>
            </div>
            {!edit ? (
              <>
                <div className="stack-sm">
                  {lines.map(([k, v], i) => (
                    <div key={k} className="stack-sm">
                      {i > 0 && <hr className="divider" />}
                      <div className="row between"><span className="secondary">{k}</span><span className="strong" style={{ textAlign: 'right' }}>{v}</span></div>
                    </div>
                  ))}
                </div>
                <p className="caption muted">Toạ độ kho là điểm xuất phát khi lấy ma trận thời gian từ TomTom. Đổi toạ độ sẽ áp dụng cho các kế hoạch tạo sau đó.</p>
                <div><Button variant="secondary" onClick={() => { action.setError(null); setEdit({ name: d.name, address: d.address, lat: d.lat, lon: d.lon, openingHours: d.openingHours ?? '' }) }}>Sửa thông tin</Button></div>
              </>
            ) : (
              <div className="stack">
                <Field label="Tên kho"><input className="input" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
                <Field label="Địa chỉ"><input className="input" value={edit.address} onChange={e => setEdit({ ...edit, address: e.target.value })} /></Field>
                <Field label="Giờ mở cửa"><input className="input" value={edit.openingHours} onChange={e => setEdit({ ...edit, openingHours: e.target.value })} /></Field>
                <p className="caption muted">Bấm vào bản đồ để đổi toạ độ: {edit.lat.toFixed(5)}, {edit.lon.toFixed(5)}</p>
                <ErrorBox error={action.error} />
                <div className="row end">
                  <Button variant="secondary" onClick={() => setEdit(null)}>Hủy</Button>
                  <Button onClick={save} loading={action.busy}>Lưu</Button>
                </div>
              </div>
            )}
          </Card>
          <Card compact title="Vị trí trên bản đồ" extra={<span className="caption muted">{view.lat.toFixed(4)}, {view.lon.toFixed(4)}</span>}>
            <MapView height={520} depot={{ ...view }} onClick={edit ? p => setEdit(x => ({ ...x, lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) })) : undefined} fitKey="depot" />
          </Card>
        </div>
      )}
    </>
  )
}
