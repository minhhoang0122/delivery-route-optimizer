// D02 Đơn hàng: danh sách đơn kèm trạng thái, lọc và tìm kiếm.
import { Plus, Search, Truck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '../../api.js'
import { Chips, ErrorBox, Field, PageHeader, StatusBadge, Table, TableSkeleton } from '../../components/ui.jsx'
import { kg, ORDER_STATUS, truckOnly, vehicleTypes } from '../../format.js'
import { useLoad } from '../../hooks.js'

const COLUMNS = [
  { key: 'code', title: 'Mã đơn', width: 120 },
  { key: 'recipient', title: 'Người nhận', width: 220 },
  { key: 'address', title: 'Địa chỉ', width: 300 },
  { key: 'weight', title: 'Khối lượng', width: 120 },
  { key: 'types', title: 'Loại xe được phép', width: 200 },
  { key: 'status', title: 'Trạng thái', width: 168 },
]

const FILTERS = [
  ['all', 'Tất cả'], ['pending', 'Chờ xếp'], ['assigned', 'Đã phân công'], ['in_delivery', 'Đang giao'],
  ['needs_action', 'Cần xử lý'], ['delivered', 'Đã giao'], ['cancelled', 'Đã hủy'],
]

export default function OrdersPage() {
  const navigate = useNavigate()
  const { data, error, loading, reload } = useLoad(() => api('/orders'), [], { interval: 30_000 })
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const orders = useMemo(() => data?.orders ?? [], [data])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders.filter(o => (filter === 'all' || o.status === filter)
      && (!q || o.code.toLowerCase().includes(q) || o.recipientName.toLowerCase().includes(q) || o.phone.replace(/\s/g, '').includes(q.replace(/\s/g, ''))))
  }, [orders, filter, search])

  const columns = COLUMNS.map(c => ({
    ...c,
    render: {
      code: o => <span className="strong">{o.code}</span>,
      recipient: o => <div className="col"><span className="strong">{o.recipientName}</span><span className="caption muted">{o.phone}</span></div>,
      address: o => o.address,
      weight: o => <span className="tabular">{kg(o.weightKg)}</span>,
      types: o => truckOnly(o.vehicleTypes) ? <span className="tag-truck"><Truck size={12} /> Chỉ xe tải nhỏ</span> : vehicleTypes(o.vehicleTypes),
      status: o => (
        <div className="col">
          <StatusBadge map={ORDER_STATUS} value={o.status} />
          {o.trip && <span className="caption muted">{o.trip.code}</span>}
        </div>
      ),
    }[c.key],
  }))

  return (
    <>
      <PageHeader title="Đơn hàng"
        actions={<Link className="btn primary" to="/dispatcher/orders/new"><Plus size={18} /> Tạo đơn</Link>} />
      <div className="row between wrap" style={{ alignItems: 'flex-end' }}>
        <Chips value={filter} onChange={setFilter}
          items={FILTERS.map(([v, l]) => ({ value: v, label: l, count: v === 'all' ? orders.length : orders.filter(o => o.status === v).length }))} />
        <Field label="Tìm kiếm">
          <div className="input-icon" style={{ width: 340 }}>
            <Search size={16} />
            <input className="input" placeholder="Mã đơn, người nhận hoặc số điện thoại" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </Field>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <TableSkeleton columns={COLUMNS} /> : (
        <Table columns={columns} rows={shown} empty="Không có đơn phù hợp"
          onRowClick={o => (o.status === 'pending' ? navigate(`/dispatcher/orders/${o.id}/edit`) : o.trip && navigate(`/dispatcher/trips/${o.trip.id}`))} />
      )}
    </>
  )
}
