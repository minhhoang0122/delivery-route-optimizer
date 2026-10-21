// D04 Đơn chưa giao được (UC08): đơn chỉ quay về danh sách chờ hoặc bị hủy sau khi đối chiếu và chốt chuyến.
import { useNavigate } from 'react-router'
import { api } from '../../api.js'
import { Alert, Badge, Button, Card, ErrorBox, PageHeader, Table, TableSkeleton } from '../../components/ui.jsx'
import { time } from '../../format.js'
import { useLoad } from '../../hooks.js'

const COLUMNS = [
  { key: 'code', title: 'Mã đơn', width: 100 },
  { key: 'recipient', title: 'Người nhận', width: 174 },
  { key: 'trip', title: 'Chuyến', width: 100 },
  { key: 'attempt', title: 'Lần giao', width: 96 },
  { key: 'reason', title: 'Lý do', width: 198 },
  { key: 'time', title: 'Thời điểm', width: 120 },
  { key: 'status', title: 'Trạng thái', width: 140 },
  { key: 'actions', title: 'Thao tác', width: 200 },
]

const STEPS = [
  ['Driver báo về kho', 'Driver gửi kết quả từng điểm và mang hàng chưa giao được về kho.'],
  ['Đối chiếu chuyến', 'Dispatcher kiểm hàng thực tế tại kho với báo cáo của Driver.'],
  ['Quyết định và chốt chuyến', 'Chọn chuyển đơn sang kế hoạch sau hoặc hủy đơn, rồi chốt chuyến.'],
]

export default function FailedOrdersPage() {
  const navigate = useNavigate()
  const { data, error, loading, reload } = useLoad(() => api('/orders/needs-action'), [], { interval: 15_000 })
  const orders = data?.orders ?? []
  const trips = [...new Set(orders.map(o => o.trip.code))]

  const columns = COLUMNS.map(c => ({
    ...c,
    render: {
      code: o => <span className="strong">{o.code}</span>,
      recipient: o => <div className="col"><span className="strong">{o.recipientName}</span><span className="caption muted">{o.phone}</span></div>,
      trip: o => o.trip.code,
      attempt: o => o.attemptNo,
      reason: o => <div className="col"><span className="strong">{o.reason}</span>{o.note && <span className="caption muted">{o.note}</span>}</div>,
      time: o => time(o.occurredAt),
      status: () => <Badge tone="warning">Cần xử lý</Badge>,
      actions: o => o.trip.status === 'awaiting_reconciliation'
        ? <Button variant="ghost" onClick={() => navigate(`/dispatcher/trips/${o.trip.id}/reconcile`)}>Đối chiếu chuyến</Button>
        : <span className="caption muted">Hàng còn trên xe, chờ Driver về kho</span>,
    }[c.key],
  }))

  return (
    <>
      <PageHeader title="Đơn chưa giao được" subtitle="Đơn chỉ quay về danh sách chờ hoặc bị hủy sau khi đối chiếu và chốt chuyến." />
      {orders.length > 0 && (
        <Alert tone="info" title={`${orders.length} đơn đang chờ quyết định`}>
          Thuộc chuyến {trips.join(', ')}. Mở đối chiếu chuyến để chọn chuyển sang kế hoạch sau hoặc hủy đơn.
        </Alert>
      )}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <TableSkeleton columns={COLUMNS} /> : <Table columns={columns} rows={orders} empty="Không có đơn nào chưa giao được" />}
      <Card title="Cách xử lý đơn chưa giao được">
        <div className="row top wrap" style={{ gap: 16 }}>
          {STEPS.map(([title, desc], i) => (
            <div key={title} className="step" style={{ minWidth: 240 }}>
              <span className="step-no">{i + 1}</span>
              <div className="col"><span className="strong">{title}</span><span className="caption secondary">{desc}</span></div>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}
