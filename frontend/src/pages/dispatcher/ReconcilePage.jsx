// D12 Đối chiếu và chốt chuyến (UC08, UC09). Báo về kho của Driver không tự chốt chuyến;
// chỉ đối chiếu hợp lệ mới giải phóng đơn, xe và Driver.
import { CircleCheck, Package, TriangleAlert } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, newEventId } from '../../api.js'
import { Alert, Badge, Button, Card, Checkbox, ErrorBox, Loading, Metric, PageHeader, Radio, StatusBadge, StopItem, Table } from '../../components/ui.jsx'
import { kg, time, TRIP_STATUS } from '../../format.js'
import { useAction, useLoad } from '../../hooks.js'

export default function ReconcilePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useLoad(() => api(`/trips/${id}`), [id])
  const [decisions, setDecisions] = useState({})
  const [matched, setMatched] = useState(false)
  const action = useAction()
  const closeId = useRef(newEventId())
  if (loading && !data) return <Loading />
  const t = data?.trip
  if (!t) return <ErrorBox error={error} onRetry={reload} />

  const failed = t.stops.filter(s => s.status === 'failed')
  const pending = t.stops.filter(s => s.status === 'pending')
  const returned = new Set(t.returnReport?.returnedOrderIds ?? [])
  const undecided = failed.filter(s => !decisions[s.order.id])
  const blockers = [
    t.status !== 'awaiting_reconciliation' && (t.status === 'closed' ? null : 'Driver chưa báo về kho, chuyến chưa ở trạng thái chờ đối chiếu.'),
    pending.length > 0 && `Điểm ${pending.map(s => `${s.seq} (${s.order.code})`).join(', ')} chưa có kết quả giao. Driver cần đồng bộ kết quả trước khi đối chiếu.`,
    undecided.length > 0 && `Còn ${undecided.length} đơn chưa có quyết định (${undecided.map(s => s.order.code).join(', ')}).`,
    !matched && failed.length > 0 && 'Chưa xác nhận hàng thực tế tại kho khớp với báo cáo của Driver.',
    !matched && failed.length === 0 && 'Chưa xác nhận không có sai lệch.',
  ].filter(Boolean)

  async function close() {
    const body = {
      clientEventId: closeId.current, stateVersion: t.stateVersion, goodsMatched: matched,
      decisions: failed.map(s => ({ orderId: s.order.id, decision: decisions[s.order.id] })),
    }
    if (await action.run(() => api(`/trips/${t.id}/close`, { method: 'POST', body }))) navigate(`/dispatcher/trips/${t.id}`)
  }

  const columns = [
    { key: 'seq', title: 'STT', width: 56, render: s => s.seq },
    { key: 'code', title: 'Mã đơn', width: 104, render: s => s.order.code },
    { key: 'name', title: 'Người nhận', width: 168, render: s => s.order.recipientName },
    { key: 'result', title: 'Kết quả', width: 184, render: s => s.status === 'delivered' ? <Badge tone="success">Giao thành công</Badge> : s.status === 'failed' ? <Badge tone="danger">Chưa giao được</Badge> : <Badge>Chưa có kết quả</Badge> },
    { key: 'reason', title: 'Lý do', width: 128, render: s => s.attempt?.reason ?? <span className="muted">—</span> },
  ]

  if (t.status === 'closed') {
    return (
      <>
        <PageHeader title={`Đối chiếu chuyến ${t.code}`} badge={<StatusBadge map={TRIP_STATUS} value={t.status} />} subtitle={`Chốt lúc ${time(t.closedAt)}`} />
        <Alert tone="success" title="Chuyến đã được chốt">Đơn, xe và Driver đã được giải phóng. <Link to={`/dispatcher/trips/${t.id}`}>Xem chi tiết chuyến</Link></Alert>
      </>
    )
  }

  return (
    <>
      <PageHeader title={`Đối chiếu chuyến ${t.code}`} badge={<StatusBadge map={TRIP_STATUS} value={t.status} />}
        subtitle={`${t.driver.name}${t.returnedAt ? ` · về kho lúc ${time(t.returnedAt)}` : ''}`} />
      <ErrorBox error={error} onRetry={reload} />
      <div className="grid-metrics">
        <Metric label="Đã giao" value={t.progress.delivered} hint={`${t.progress.delivered}/${t.progress.total} điểm giao thành công`} icon={CircleCheck} />
        <Metric label="Chưa giao được" value={failed.length} hint={[...new Set(failed.map(s => s.attempt?.reason))].join(', ') || 'Không có'} icon={TriangleAlert} tone={failed.length ? 'warning' : undefined} />
        <Metric label="Hàng mang về" value={`${returned.size} kiện`} hint={t.returnedAt ? `Driver báo về kho lúc ${time(t.returnedAt)}` : 'Chưa có báo cáo về kho'} icon={Package} />
      </div>
      <div className="row top wrap" style={{ gap: 16 }}>
        <div className="stack-sm" style={{ flex: '1 1 560px', minWidth: 0 }}>
          <div className="section-title"><h3 className="h4">Kết quả từng điểm</h3><span className="caption muted">Theo dữ liệu đồng bộ từ ứng dụng Driver</span></div>
          <Table columns={columns} rows={t.stops} />
        </div>
        <div className="stack" style={{ flex: '0 1 472px', minWidth: 320 }}>
          {failed.length > 0 ? (
            <Card title="Quyết định cho đơn chưa giao được">
              <p className="caption muted">Đơn chuyển sang kế hoạch sau sẽ về lại danh sách chờ xếp khi chuyến được chốt.</p>
              {failed.map(s => {
                const d = decisions[s.order.id]
                return (
                  <div key={s.id} className="stack-sm" style={{ padding: 12, borderRadius: 3, border: `1px solid ${d ? 'var(--line)' : 'var(--warn)'}`, background: d ? 'var(--surface)' : 'var(--warn-bg)' }}>
                    <div className="row between">
                      <div className="col"><span className="strong">{s.order.code} · {s.order.recipientName}</span><span className="caption muted">{s.attempt?.reason} · {s.order.address}</span></div>
                      {!d && <span className="row caption strong warning" style={{ gap: 4 }}><TriangleAlert size={14} /> Chưa chọn</span>}
                    </div>
                    <div className="row" style={{ gap: 24 }}>
                      <Radio name={`d${s.id}`} label="Chuyển sang kế hoạch sau" checked={d === 'requeue'} onChange={() => setDecisions({ ...decisions, [s.order.id]: 'requeue' })} />
                      <Radio name={`d${s.id}`} label="Hủy đơn" checked={d === 'cancel'} onChange={() => setDecisions({ ...decisions, [s.order.id]: 'cancel' })} />
                    </div>
                  </div>
                )
              })}
            </Card>
          ) : (
            <Card title="Không có đơn chưa giao được"><p className="secondary">Mọi điểm đều giao thành công và không có hàng mang về.</p></Card>
          )}
          <Card title="Kiểm hàng mang về">
            <p className="caption muted">
              {failed.length ? `${returned.size} kiện theo báo cáo của Driver: ${[...returned].map(oid => t.stops.find(s => s.order.id === oid)?.order.code).join(', ') || 'không có'}.` : 'Không có kiện nào phải mang về.'}
            </p>
            {failed.some(s => !returned.has(s.order.id)) && (
              <Alert tone="warning" title="Báo cáo của Driver thiếu kiện">
                {failed.filter(s => !returned.has(s.order.id)).map(s => `${s.order.code} (${kg(s.order.weightKg)})`).join(', ')} chưa được Driver đánh dấu mang về. Kiểm tra hàng thực tế trước khi chốt.
              </Alert>
            )}
            <Checkbox label={failed.length ? 'Hàng thực tế tại kho khớp với báo cáo của Driver' : 'Xác nhận không có sai lệch'} checked={matched} onChange={setMatched} />
          </Card>
        </div>
      </div>
      {pending.length > 0 && (
        <Card title="Điểm chưa có kết quả" extra={<span className="caption muted">{t.progress.done}/{t.progress.total} điểm đã có kết quả</span>}>
          {pending.map(s => <StopItem key={s.id} state="pending" seq={s.seq} name={s.order.recipientName} address={s.order.address} meta={`${s.order.code} · ${kg(s.order.weightKg)} · chưa có kết quả`} />)}
        </Card>
      )}
      <ErrorBox error={action.error} />
      <div className="row">
        <div className="grow">{blockers.length > 0
          ? <Alert tone="danger" title="Chưa thể chốt chuyến">{blockers.join(' ')}</Alert>
          : <Alert tone="success" title="Đủ điều kiện chốt chuyến">Chốt chuyến sẽ cập nhật đơn, giải phóng xe và Driver trong cùng một giao dịch.</Alert>}</div>
        <Button onClick={close} disabled={blockers.length > 0} loading={action.busy}>Chốt chuyến</Button>
      </div>
    </>
  )
}
