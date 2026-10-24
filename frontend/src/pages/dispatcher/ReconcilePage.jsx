// D12 Đối chiếu và chốt chuyến (UC08, UC09). Chuyến có kiện chưa giao được chỉ được chốt sau khi đối chiếu;
// đối chiếu hợp lệ mới giải phóng đơn, xe và Driver. Kiện đã mang về và chưa quá số lần giao tối đa mặc định giao lại,
// Dispatcher chỉ chọn cho ngoại lệ; kiện không có trong báo cáo hàng mang về chỉ chọn được Thất lạc.
import { CircleCheck, Package, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, newEventId } from '../../api.js'
import { Alert, Badge, Button, Card, Checkbox, ErrorBox, Loading, LoadError, Metric, PageHeader, Radio, StatusBadge, StopItem, Table } from '../../components/ui.jsx'
import { DECISION, kg, time, TRIP_STATUS } from '../../format.js'
import { LIVE_MS, useAction, useLoad } from '../../hooks.js'

export default function ReconcilePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useLoad(() => api(`/trips/${id}`), [id])
  const [decisions, setDecisions] = useState({})
  const [matched, setMatched] = useState(false)
  const action = useAction()
  const closeId = useRef(newEventId())
  // Chờ đối chiếu thì tải lại theo chu kỳ để thấy kết quả Driver gửi muộn; lựa chọn đang làm dở được giữ nguyên
  const live = data?.trip?.status === 'awaiting_reconciliation'
  useEffect(() => {
    if (!live) return undefined
    const timer = setInterval(reload, LIVE_MS)
    return () => clearInterval(timer)
  }, [live, reload])
  if (loading && !data) return <Loading />
  const t = data?.trip
  if (!t) return <LoadError error={error} onRetry={reload} notFound="Không tìm thấy chuyến" back="/dispatcher/trips" />

  const failed = t.stops.filter(s => s.status === 'failed')
  const pending = t.stops.filter(s => s.status === 'pending')
  const returned = new Set(t.returnReport?.returnedOrderIds ?? [])
  const aborted = Boolean(t.returnReport?.aborted)
  const max = t.maxDeliveryAttempts
  const defaultOf = s => (returned.has(s.order.id) && s.order.failedAttempts < max ? 'requeue' : null)
  const decisionOf = s => decisions[s.order.id] ?? defaultOf(s)
  const undecided = failed.filter(s => !decisionOf(s))
  const unreturned = failed.filter(s => !returned.has(s.order.id))
  // Còn kiện không có trong báo cáo hàng mang về mà chưa ghi Thất lạc thì chưa xác nhận được hàng khớp
  const unresolved = unreturned.filter(s => decisionOf(s) !== 'lost')
  const goods = matched && !unresolved.length
  const blockers = [
    t.status !== 'awaiting_reconciliation' && (t.status === 'closed' ? null : 'Tài xế chưa báo về kho'),
    pending.length > 0 && `Còn ${pending.length} đơn chưa có kết quả`,
    undecided.length > 0 && `Chưa chọn xử lý cho ${undecided.length} đơn`,
    !goods && failed.length > 0 && 'Chưa xác nhận hàng khớp',
    !goods && failed.length === 0 && 'Chưa xác nhận không có sai lệch',
  ].filter(Boolean)

  async function close() {
    const body = {
      clientEventId: closeId.current, stateVersion: t.stateVersion, goodsMatched: goods,
      decisions: failed.map(s => ({ orderId: s.order.id, decision: decisionOf(s) })),
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
        <Alert tone="success" title="Chuyến đã được chốt"><Link to={`/dispatcher/trips/${t.id}`}>Xem chi tiết chuyến</Link></Alert>
      </>
    )
  }

  return (
    <>
      <PageHeader title={`Đối chiếu chuyến ${t.code}`} badge={<StatusBadge map={TRIP_STATUS} value={t.status} />}
        subtitle={`${t.driver.name}${t.returnedAt ? ` · về kho lúc ${time(t.returnedAt)}` : ''}`} />
      <ErrorBox error={error} onRetry={reload} />
      <div className="grid-metrics">
        <Metric label="Đã giao" value={t.progress.delivered} icon={CircleCheck} />
        <Metric label="Chưa giao được" value={failed.length} hint={[...new Set(failed.map(s => s.attempt?.reason))].join(', ') || 'Không có'} icon={TriangleAlert} tone={failed.length ? 'warning' : undefined} />
        <Metric label="Hàng mang về" value={`${returned.size} kiện`} hint={!t.returnedAt ? 'Chưa có báo cáo về kho' : aborted ? `Kết thúc do sự cố lúc ${time(t.returnedAt)}` : `Tài xế báo về kho lúc ${time(t.returnedAt)}`} icon={Package} />
      </div>
      <div className="row top wrap" style={{ gap: 16 }}>
        <div className="stack-sm" style={{ flex: '1 1 560px', minWidth: 0 }}>
          <div className="section-title"><h3 className="h4">Kết quả từng điểm</h3></div>
          <Table columns={columns} rows={t.stops} />
        </div>
        <div className="stack" style={{ flex: '0 1 472px', minWidth: 320 }}>
          {failed.length > 0 ? (
            <Card title="Quyết định cho đơn chưa giao được">
              {failed.map(s => {
                const d = decisionOf(s)
                const back = returned.has(s.order.id)
                const pick = v => setDecisions({ ...decisions, [s.order.id]: v })
                return (
                  <div key={s.id} className="stack-sm" style={{ padding: 12, borderRadius: 3, border: `1px solid ${d ? 'var(--line)' : 'var(--warn)'}`, background: d ? 'var(--surface)' : 'var(--warn-bg)' }}>
                    <div className="row between">
                      <div className="col"><span className="strong">{s.order.code} · {s.order.recipientName}</span><span className="caption muted">{s.attempt?.reason} · lần giao {s.order.failedAttempts}/{max} · {s.order.address}</span></div>
                      {!back ? <span className="row caption strong danger" style={{ gap: 4 }}><TriangleAlert size={14} /> Không có trong hàng mang về</span>
                        : !d && <span className="row caption strong warning" style={{ gap: 4 }}><TriangleAlert size={14} /> Chưa chọn</span>}
                    </div>
                    <div className="row" style={{ gap: 24 }}>
                      {Object.entries(DECISION).map(([v, label]) => (
                        <Radio key={v} name={`d${s.id}`} label={label} checked={d === v} disabled={v !== 'lost' && !back} onChange={() => pick(v)} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </Card>
          ) : (
            <Card title="Không có đơn chưa giao được" />
          )}
          <Card title="Kiểm hàng mang về">
            {unresolved.length > 0 && (
              <Alert tone="warning" title={`Báo cáo về kho thiếu kiện ${unresolved.map(s => s.order.code).join(', ')}`} />
            )}
            <Checkbox label={!failed.length ? 'Xác nhận không có sai lệch' : aborted ? 'Hàng thực tế tại kho khớp với danh sách hàng mang về' : 'Hàng thực tế tại kho khớp với báo cáo của tài xế'}
              checked={goods} disabled={unresolved.length > 0} onChange={setMatched} />
          </Card>
        </div>
      </div>
      {pending.length > 0 && (
        <Card title="Đơn chưa có kết quả" extra={<span className="caption muted">{t.progress.done}/{t.progress.total} đơn đã có kết quả</span>}>
          {pending.map(s => <StopItem key={s.id} state="pending" seq={s.seq} name={s.order.recipientName} address={s.order.address} meta={`${s.order.code} · ${kg(s.order.weightKg)} · chưa có kết quả`} />)}
        </Card>
      )}
      <ErrorBox error={action.error} />
      <div className="row">
        <div className="grow">{blockers.length > 0
          ? <Alert tone="danger" title="Chưa thể chốt chuyến">{blockers.join(' · ')}</Alert>
          : <Alert tone="success" title="Đủ điều kiện chốt chuyến" />}</div>
        <Button onClick={close} disabled={blockers.length > 0} loading={action.busy}>Chốt chuyến</Button>
      </div>
    </>
  )
}
