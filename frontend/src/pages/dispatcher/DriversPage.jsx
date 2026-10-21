// D05 Driver (UC03.1): hồ sơ Driver và phương tiện thường dùng. Tài khoản đăng nhập do Administrator cấp.
import { Bike, Plus, Truck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../api.js'
import { Avatar, Badge, Button, Chips, Dialog, ErrorBox, Field, PageHeader, Table, TableSkeleton } from '../../components/ui.jsx'
import { kg, VEHICLE_TYPE } from '../../format.js'
import { useAction, useLoad } from '../../hooks.js'

const COLUMNS = [
  { key: 'name', title: 'Họ tên', width: 230 },
  { key: 'phone', title: 'Số điện thoại', width: 140 },
  { key: 'vehicle', title: 'Phương tiện thường dùng', width: 218 },
  { key: 'trip', title: 'Chuyến hiện tại', width: 190 },
  { key: 'status', title: 'Trạng thái', width: 190 },
  { key: 'actions', title: 'Thao tác', width: 160 },
]

const driverState = d => (d.status !== 'active' ? 'inactive' : d.activeTrip ? 'busy' : 'ready')
const STATE = { ready: ['Sẵn sàng', 'success'], busy: ['Đang chạy chuyến', 'purple'], inactive: ['Ngừng hoạt động', 'neutral'] }

export default function DriversPage() {
  const { data, error, loading, reload } = useLoad(() => Promise.all([api('/drivers'), api('/vehicles')]).then(([d, v]) => ({ ...d, vehicles: v.vehicles })))
  const [filter, setFilter] = useState('all')
  const [edit, setEdit] = useState(null)
  const action = useAction()
  const drivers = data?.drivers ?? []
  const shown = drivers.filter(d => filter === 'all' || driverState(d) === filter)

  async function save() {
    const body = { ...edit, defaultVehicleId: edit.defaultVehicleId ? Number(edit.defaultVehicleId) : null, userId: Number(edit.userId) }
    const ok = await action.run(() => (edit.id ? api(`/drivers/${edit.id}`, { method: 'PUT', body }) : api('/drivers', { method: 'POST', body })))
    if (ok) { setEdit(null); reload() }
  }

  const columns = COLUMNS.map(c => ({
    ...c,
    render: {
      name: d => <div className="row" style={{ gap: 12 }}><Avatar name={d.fullName} muted={d.status !== 'active'} /><div className="col"><span className="strong">{d.fullName}</span><span className="caption muted">{d.username}{d.accountStatus === 'locked' && ' · tài khoản đã khóa'}</span></div></div>,
      phone: d => d.phone || '—',
      vehicle: d => d.defaultVehicle
        ? <div className="row" style={{ gap: 8 }}>{d.defaultVehicle.type === 'motorcycle' ? <Bike size={18} /> : <Truck size={18} />}<div className="col"><span className="strong">{d.defaultVehicle.plate}</span><span className="caption muted">{VEHICLE_TYPE[d.defaultVehicle.type]} · {kg(d.defaultVehicle.capacityKg)}</span></div></div>
        : <span className="muted">Chưa gán</span>,
      trip: d => d.activeTrip
        ? <Link to={`/dispatcher/trips/${d.activeTrip.id}`} className="col" style={{ color: 'inherit' }}><span className="strong">{d.activeTrip.code}</span><span className="caption muted">{d.activeTrip.status === 'awaiting_reconciliation' ? 'Chờ đối chiếu' : `${d.activeTrip.done}/${d.activeTrip.total} điểm`}</span></Link>
        : <span className="muted">Không có</span>,
      status: d => { const [l, t] = STATE[driverState(d)]; return <Badge tone={t}>{l}</Badge> },
      actions: d => <Button variant="ghost" onClick={() => { action.setError(null); setEdit({ id: d.id, userId: d.userId, fullName: d.fullName, phone: d.phone ?? '', defaultVehicleId: d.defaultVehicle?.id ?? '', status: d.status }) }}>Sửa hồ sơ</Button>,
    }[c.key],
  }))

  const takenBy = new Map(drivers.filter(d => d.defaultVehicle).map(d => [d.defaultVehicle.id, d.id]))
  return (
    <>
      <PageHeader title="Driver" subtitle="Hồ sơ Driver và phương tiện thường dùng. Tài khoản đăng nhập do Administrator cấp."
        actions={<Button icon={Plus} disabled={!data?.availableAccounts.length}
          title={data?.availableAccounts.length ? '' : 'Không còn tài khoản Driver nào chưa có hồ sơ'}
          onClick={() => { action.setError(null); setEdit({ userId: data.availableAccounts[0].id, fullName: data.availableAccounts[0].fullName ?? '', phone: '', defaultVehicleId: '', status: 'active' }) }}>Thêm Driver</Button>} />
      <Chips value={filter} onChange={setFilter} items={[
        { value: 'all', label: 'Tất cả', count: drivers.length },
        { value: 'ready', label: 'Sẵn sàng', count: drivers.filter(d => driverState(d) === 'ready').length },
        { value: 'busy', label: 'Đang chạy chuyến', count: drivers.filter(d => driverState(d) === 'busy').length },
        { value: 'inactive', label: 'Ngừng hoạt động', count: drivers.filter(d => driverState(d) === 'inactive').length },
      ]} />
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <TableSkeleton columns={COLUMNS} /> : <Table columns={columns} rows={shown} />}
      <p className="caption muted">Driver ngừng hoạt động không xuất hiện trong danh sách chọn khi lập kế hoạch.</p>

      {edit && (
        <Dialog title={edit.id ? 'Sửa hồ sơ Driver' : 'Thêm Driver'} confirmLabel="Lưu" busy={action.busy} onCancel={() => setEdit(null)} onConfirm={save}>
          {!edit.id && (
            <Field label="Tài khoản Driver" helper="Tài khoản vai trò Driver chưa có hồ sơ">
              <select className="select" value={edit.userId} onChange={e => {
                const a = data.availableAccounts.find(x => x.id === Number(e.target.value))
                setEdit({ ...edit, userId: e.target.value, fullName: a?.fullName ?? edit.fullName })
              }}>
                {data.availableAccounts.map(a => <option key={a.id} value={a.id}>{a.username}{a.fullName ? ` · ${a.fullName}` : ''}</option>)}
              </select>
            </Field>
          )}
          <Field label="Họ tên"><input className="input" value={edit.fullName} onChange={e => setEdit({ ...edit, fullName: e.target.value })} /></Field>
          <Field label="Số điện thoại"><input className="input" value={edit.phone} onChange={e => setEdit({ ...edit, phone: e.target.value })} inputMode="tel" /></Field>
          <Field label="Phương tiện thường dùng" helper="Khi lập kế hoạch, mỗi xe đi cùng Driver thường dùng của xe đó">
            <select className="select" value={edit.defaultVehicleId} onChange={e => setEdit({ ...edit, defaultVehicleId: e.target.value })}>
              <option value="">Chưa gán</option>
              {data.vehicles.map(v => (
                <option key={v.id} value={v.id} disabled={takenBy.has(v.id) && takenBy.get(v.id) !== edit.id}>
                  {v.plate} · {VEHICLE_TYPE[v.type]} {takenBy.has(v.id) && takenBy.get(v.id) !== edit.id ? '(đã có Driver)' : ''}
                </option>
              ))}
            </select>
          </Field>
          {edit.id && (
            <Field label="Trạng thái">
              <select className="select" value={edit.status} onChange={e => setEdit({ ...edit, status: e.target.value })}>
                <option value="active">Hoạt động</option>
                <option value="inactive">Ngừng hoạt động</option>
              </select>
            </Field>
          )}
          <ErrorBox error={action.error} />
        </Dialog>
      )}
    </>
  )
}
