// D04 Đơn chưa giao được (UC08): đơn chỉ quay về danh sách chờ, chuyển hoàn hoặc ghi thất lạc sau khi đối chiếu và chốt chuyến.
// Chưa quá số lần giao tối đa thì mặc định giao lại, khách từ chối nhận thì mặc định chuyển hoàn; quá số lần thì Dispatcher phải quyết định.
import { useNavigate } from 'react-router'
import { api } from '../../api.js'
import { Alert, Badge, Button, ErrorBox, PageHeader, Table, TableSkeleton } from '../../components/ui.jsx'
import { REFUSED_REASON, time } from '../../format.js'
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
      attempt: o => `${o.attemptNo}/${data.maxDeliveryAttempts}`,
      reason: o => <div className="col"><span className="strong">{o.reason}</span>{o.note && <span className="caption muted">{o.note}</span>}</div>,
      time: o => time(o.occurredAt),
      status: o => (o.attemptNo >= data.maxDeliveryAttempts ? <Badge tone="warning">Cần quyết định</Badge>
        : o.reason === REFUSED_REASON ? <Badge>Chuyển hoàn</Badge> : <Badge>Giao lại</Badge>),
      actions: o => o.trip.status === 'awaiting_reconciliation'
        ? <Button variant="ghost" onClick={() => navigate(`/dispatcher/trips/${o.trip.id}/reconcile`)}>Đối chiếu chuyến</Button>
        : <span className="caption muted">Chờ tài xế về kho</span>,
    }[c.key],
  }))

  return (
    <>
      <PageHeader title="Đơn chưa giao được" />
      {orders.length > 0 && (
        <Alert tone="info" title={`${orders.length} đơn chưa giao được`}>
          Chuyến {trips.join(', ')}
        </Alert>
      )}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <TableSkeleton columns={COLUMNS} /> : <Table columns={columns} rows={orders} empty="Không có đơn nào chưa giao được" />}
    </>
  )
}
