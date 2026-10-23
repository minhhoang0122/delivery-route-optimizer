// D06 Phương tiện (UC03.2): xe của kho và cấu hình định tuyến dùng khi lấy dữ liệu từ TomTom.
import { Bike, Plus, Truck } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api.js'
import { Badge, Button, Chips, Dialog, ErrorBox, Field, PageHeader, Table, TableSkeleton } from '../../components/ui.jsx'
import { kg, VEHICLE_TYPE } from '../../format.js'
import { useAction, useLoad } from '../../hooks.js'

const COLUMNS = [
  { key: 'plate', title: 'Biển số', width: 180 },
  { key: 'type', title: 'Loại xe', width: 170 },
  { key: 'capacity', title: 'Tải trọng', width: 120 },
  { key: 'status', title: 'Trạng thái', width: 200 },
  { key: 'actions', title: 'Thao tác', width: 268 },
]

export default function VehiclesPage() {
  const { data, error, loading, reload } = useLoad(() => api('/vehicles'))
  const [filter, setFilter] = useState('all')
  const [edit, setEdit] = useState(null)
  const action = useAction()
  const vehicles = data?.vehicles ?? []
  const shown = vehicles.filter(v => filter === 'all' || v.type === filter)

  async function save() {
    const body = { ...edit, capacityKg: Number(String(edit.capacityKg).replace(',', '.')) }
    const ok = await action.run(() => (edit.id ? api(`/vehicles/${edit.id}`, { method: 'PUT', body }) : api('/vehicles', { method: 'POST', body })))
    if (ok) { setEdit(null); reload() }
  }
  async function setStatus(v, status) {
    if (await action.run(() => api(`/vehicles/${v.id}/status`, { method: 'PATCH', body: { status } }))) reload()
  }

  const columns = COLUMNS.map(c => ({
    ...c,
    render: {
      plate: v => <div className="col"><span className="strong">{v.plate}</span><span className="caption muted">{v.driver?.name ?? 'Chưa có Driver'}</span></div>,
      type: v => <div className="row" style={{ gap: 8 }}>{v.type === 'motorcycle' ? <Bike size={18} /> : <Truck size={18} />}{VEHICLE_TYPE[v.type]}</div>,
      capacity: v => kg(v.capacityKg),
      status: v => v.status !== 'active' ? <Badge tone="warning">Bảo trì</Badge> : v.activeTrip ? <Badge tone="purple">Đang chạy chuyến</Badge> : <Badge tone="success">Sẵn sàng</Badge>,
      actions: v => (
        <div className="row" style={{ gap: 4 }}>
          <Button variant="ghost" onClick={() => { action.setError(null); setEdit({ id: v.id, plate: v.plate, type: v.type, capacityKg: v.capacityKg }) }}>Sửa</Button>
          {v.status === 'active'
            ? <Button variant="ghost" disabled={Boolean(v.activeTrip) || action.busy} title={v.activeTrip ? 'Xe đang chạy chuyến' : ''} onClick={() => setStatus(v, 'inactive')}>Báo bảo trì</Button>
            : <Button variant="ghost" disabled={action.busy} onClick={() => setStatus(v, 'active')}>Kết thúc bảo trì</Button>}
        </div>
      ),
    }[c.key],
  }))

  return (
    <>
      <PageHeader title="Phương tiện"
        actions={<Button icon={Plus} onClick={() => { action.setError(null); setEdit({ plate: '', type: 'motorcycle', capacityKg: '' }) }}>Thêm phương tiện</Button>} />
      <Chips value={filter} onChange={setFilter} items={[
        { value: 'all', label: 'Tất cả', count: vehicles.length },
        { value: 'motorcycle', label: 'Xe máy', count: vehicles.filter(v => v.type === 'motorcycle').length },
        { value: 'small_truck', label: 'Xe tải nhỏ', count: vehicles.filter(v => v.type === 'small_truck').length },
      ]} />
      <ErrorBox error={error || (!edit && action.error)} onRetry={reload} />
      {loading && !data ? <TableSkeleton columns={COLUMNS} /> : <Table columns={columns} rows={shown} empty="Chưa có phương tiện" />}

      {edit && (
        <Dialog title={edit.id ? `Sửa xe ${edit.plate}` : 'Thêm phương tiện'} confirmLabel="Lưu" busy={action.busy} onCancel={() => setEdit(null)} onConfirm={save}>
          <Field label="Biển số"><input className="input" value={edit.plate} onChange={e => setEdit({ ...edit, plate: e.target.value })} maxLength={20} /></Field>
          <Field label="Loại xe">
            <select className="select" value={edit.type} onChange={e => setEdit({ ...edit, type: e.target.value })}>
              <option value="motorcycle">Xe máy</option>
              <option value="small_truck">Xe tải nhỏ</option>
            </select>
          </Field>
          <Field label="Tải trọng (kg)"><input className="input" value={edit.capacityKg} onChange={e => setEdit({ ...edit, capacityKg: e.target.value })} inputMode="decimal" /></Field>
          <ErrorBox error={action.error} />
        </Dialog>
      )}
    </>
  )
}
