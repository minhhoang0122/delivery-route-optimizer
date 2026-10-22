// D08 Lập kế hoạch và D08b Đang tính phương án (UC04).
// Dispatcher chọn đơn chờ, xe và Driver; hệ thống lập ma trận, chạy Insertion Heuristic rồi Relocate và Swap.
import { Bike, CircleCheck, LoaderCircle, Package, Route, Truck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, newEventId } from '../../api.js'
import { Badge, Button, Card, Checkbox, Chips, Dot, Empty, ErrorBox, Field, Loading, PageHeader, Progress, Stat } from '../../components/ui.jsx'
import { kg, PLAN_STATUS, routeHex, time, truckOnly, VEHICLE_TYPE } from '../../format.js'
import { useLoad } from '../../hooks.js'

const STEPS = [
  ['validate', 'Kiểm tra dữ liệu đơn'],
  ['matrix', 'Lập ma trận thời gian'],
  ['optimize', 'Insertion Heuristic, Relocate và Swap'],
  ['geometry', 'Lấy đường đi để vẽ bản đồ'],
]

function StepLine({ state, label }) {
  const icon = state === 'done' ? <CircleCheck size={18} className="success" />
    : state === 'active' ? <LoaderCircle size={18} className="spin brand" />
      : <span style={{ width: 14, height: 14, margin: 2, borderRadius: '50%', border: '1.5px solid var(--line-strong)', display: 'inline-block' }} />
  return <div className="row" style={{ gap: 8 }}>{icon}<span className={state === 'active' ? 'strong brand' : state === 'todo' ? 'muted' : ''}>{label}</span></div>
}

export default function PlanningPage() {
  const [params] = useSearchParams()
  const from = params.get('from')
  const options = useLoad(() => api('/planning/options'))
  const previous = useLoad(() => (from ? api(`/planning/runs/${from}`) : Promise.resolve(null)), [from])
  const runs = useLoad(() => api('/planning/runs'))
  const opt = options.data
  if (!opt || (from && !previous.data && !previous.error)) return options.error ? <ErrorBox error={options.error} /> : <Loading />

  // Lựa chọn mặc định: mọi đơn hợp lệ và mọi xe sẵn sàng; "Tính lại" từ bản nháp thì lấy lại lựa chọn cũ
  const prevSnap = previous.data?.run?.snapshot
  const okOrders = opt.orders.filter(o => !o.problem).map(o => o.id)
  const okVehicles = opt.vehicles.filter(v => !v.problem).map(v => v.id)
  const initial = {
    orders: new Set(prevSnap ? prevSnap.orders.map(o => o.id).filter(id => okOrders.includes(id)) : okOrders),
    vehicles: new Set(prevSnap ? prevSnap.vehicles.map(v => v.id).filter(id => okVehicles.includes(id)) : okVehicles),
    maxMinutes: String(prevSnap ? prevSnap.params.maxRouteMinutes ?? 0 : opt.defaults.maxRouteMinutes || 0),
  }
  return <PlanningForm key={from ?? 'new'} opt={opt} runs={runs.data?.runs ?? []} initial={initial} />
}

function PlanningForm({ opt, runs, initial }) {
  const navigate = useNavigate()
  const [orders, setOrders] = useState(initial.orders)
  const [vehicles, setVehicles] = useState(initial.vehicles)
  const [maxMinutes, setMaxMinutes] = useState(initial.maxMinutes)
  const [filter, setFilter] = useState('all')
  const [run, setRun] = useState(null)
  const [error, setError] = useState(null)
  // Chặn bấm đúp: mỗi lần bấm tạo một lần tính và tốn hạn mức TomTom
  const [submitting, setSubmitting] = useState(false)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  const selected = useMemo(() => {
    const os = opt.orders.filter(o => orders.has(o.id))
    const vs = opt.vehicles.filter(v => vehicles.has(v.id))
    return {
      orders: os, vehicles: vs,
      weight: os.reduce((s, o) => s + o.weightKg, 0),
      capacity: vs.reduce((s, v) => s + v.capacityKg, 0),
      motorcycles: vs.filter(v => v.type === 'motorcycle').length,
    }
  }, [opt, orders, vehicles])

  const computing = run?.status === 'running'

  function poll(id) {
    timer.current = setTimeout(async () => {
      try {
        const d = await api(`/planning/runs/${id}`)
        setRun(d.run)
        if (d.run.status === 'running') poll(id)
        else if (d.run.status === 'draft') navigate(`/dispatcher/planning/runs/${id}`)
        else setError({ message: d.run.result?.error || 'Không lập được phương án', details: (d.run.result?.unassigned || []).map(u => ({ id: u.orderId, reason: u.reason })) })
      } catch (e) {
        setError(e)
      }
    }, 700)
  }

  async function compute() {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const d = await api('/planning/runs', {
        method: 'POST',
        body: { clientEventId: newEventId(), orderIds: [...orders], vehicleIds: [...vehicles], maxRouteMinutes: Number(maxMinutes) || 0 },
      })
      setRun(d.run)
      poll(d.run.id)
    } catch (e) {
      setError(e)
    } finally {
      setSubmitting(false)
    }
  }

  const toggle = (set, setter, id, on) => { const n = new Set(set); if (on) n.add(id); else n.delete(id); setter(n) }
  const validOrders = opt.orders.filter(o => !o.problem)
  const shownOrders = opt.orders.filter(o => filter === 'all' || truckOnly(o.vehicleTypes))
  const step = run?.progress?.step || (computing ? 'validate' : null)
  const stepIndex = STEPS.findIndex(s => s[0] === step)
  const draft = runs.find(r => r.status === 'draft')

  return (
    <>
      <PageHeader title="Lập kế hoạch giao hàng"
        actions={draft && <Link className="btn secondary" to={`/dispatcher/planning/runs/${draft.id}`}>Mở bản nháp {draft.code}</Link>} />
      <ErrorBox error={error} />
      {validOrders.length === 0 ? (
        <Card><Empty icon={Package} title="Chưa có đơn chờ xếp" action={<Link className="btn primary" to="/dispatcher/orders/new">Tạo đơn</Link>}>Đơn mới sẽ xuất hiện ở đây sau khi tạo.</Empty></Card>
      ) : (
        <div className="row top wrap" style={{ gap: 16 }}>
          <Card title={`Đơn chờ xếp (${validOrders.length})`} style={{ flex: '1 1 456px', maxWidth: 560 }}
            extra={<Button variant="ghost" disabled={computing} onClick={() => setOrders(orders.size === validOrders.length ? new Set() : new Set(validOrders.map(o => o.id)))}>
              {orders.size === validOrders.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}</Button>}>
            <Chips value={filter} onChange={setFilter} items={[
              { value: 'all', label: 'Tất cả', count: opt.orders.length },
              { value: 'truck', label: 'Chỉ xe tải', count: opt.orders.filter(o => truckOnly(o.vehicleTypes)).length },
            ]} />
            <div style={{ maxHeight: 520, overflowY: 'auto' }}>
              {shownOrders.map((o, i) => (
                <div key={o.id} className="col" style={{ padding: '8px 0', borderBottom: i < shownOrders.length - 1 ? '1px solid var(--line)' : 0 }}>
                  <div className="row between">
                    <Checkbox label={`${o.code} · ${o.recipientName}`} checked={orders.has(o.id)} disabled={computing || Boolean(o.problem)} onChange={v => toggle(orders, setOrders, o.id, v)} />
                    <span className={`medium tabular ${orders.has(o.id) ? '' : 'muted'}`}>{kg(o.weightKg)}</span>
                  </div>
                  <div className="row" style={{ paddingLeft: 26, gap: 8 }}>
                    <span className="caption muted">{o.address}</span>
                    {truckOnly(o.vehicleTypes) && <span className="tag-truck"><Truck size={12} /> Chỉ xe tải</span>}
                  </div>
                  {o.problem && <span className="caption danger" style={{ paddingLeft: 26 }}>{o.problem}</span>}
                </div>
              ))}
            </div>
            <div className="row between" style={{ padding: '12px 16px', background: 'var(--subtle)', borderRadius: 3 }}>
              <span className="strong">Đã chọn {orders.size}/{validOrders.length} đơn · {kg(selected.weight)}</span>
              <span className="caption muted">Hiển thị {shownOrders.length}/{opt.orders.length}</span>
            </div>
          </Card>

          <Card title="Xe và Driver" extra={<span className="caption muted">Đã chọn {vehicles.size}/{opt.vehicles.length}</span>} style={{ flex: '0 1 360px' }}>
            <div className="stack-sm">
              {opt.vehicles.map(v => {
                const on = vehicles.has(v.id)
                return (
                  <div key={v.id} className="col" style={{ padding: 12, borderRadius: 3, border: `1px solid ${on ? 'var(--ink)' : 'var(--line)'}`, background: v.problem ? 'var(--subtle)' : 'var(--surface)' }}>
                    <div className="row between">
                      <Checkbox label={v.driver?.name ?? 'Chưa có Driver'} checked={on} disabled={computing || Boolean(v.problem)} onChange={x => toggle(vehicles, setVehicles, v.id, x)} />
                      {v.problem ? <Badge tone="warning">{v.status !== 'active' ? 'Bảo trì' : 'Không sẵn sàng'}</Badge>
                        : <span className="row caption strong secondary" style={{ gap: 6 }}><Dot color={routeHex(v.id)} size={8} /> Xe {v.id}</span>}
                    </div>
                    <div className="row muted" style={{ paddingLeft: 26, gap: 6, opacity: v.problem ? 0.7 : 1 }}>
                      {v.type === 'motorcycle' ? <Bike size={16} /> : <Truck size={16} />}
                      <span className="caption">{VEHICLE_TYPE[v.type]} {v.plate} · {kg(v.capacityKg)}</span>
                    </div>
                    {v.problem && <span className="caption warning" style={{ paddingLeft: 26 }}>{v.problem}</span>}
                  </div>
                )
              })}
            </div>
          </Card>

          {!computing ? (
            <Card title="Tóm tắt" style={{ flex: '0 1 280px' }}>
              <div className="row top" style={{ gap: 16 }}>
                <div className="grow"><Stat label="Đơn" value={orders.size} /></div>
                <div className="grow"><Stat label="Tổng khối lượng" value={kg(selected.weight)} /></div>
              </div>
              <div className="row top" style={{ gap: 16 }}>
                <div className="grow"><Stat label="Xe" value={vehicles.size} sub={`${selected.motorcycles} xe máy, ${vehicles.size - selected.motorcycles} xe tải nhỏ`} /></div>
                <div className="grow"><Stat label="Tổng tải" value={kg(selected.capacity)} /></div>
              </div>
              <hr className="divider" />
              <div className="col" style={{ gap: 6 }}>
                <div className="row between"><span className="caption muted">Khối lượng so với tổng tải</span><span className="caption strong secondary">{selected.capacity ? Math.round((selected.weight / selected.capacity) * 100) : 0}%</span></div>
                <Progress value={selected.capacity ? selected.weight / selected.capacity : 0} width="100%" />
              </div>
              <Field label="Giới hạn thời lượng mỗi chuyến (phút)" helper="0 là không giới hạn">
                <input className="input" type="number" min={0} max={1440} value={maxMinutes} onChange={e => setMaxMinutes(e.target.value)} />
              </Field>
              <Button icon={Route} block onClick={compute} loading={submitting} disabled={!orders.size || !vehicles.size}>Tính phương án</Button>
            </Card>
          ) : (
            <Card style={{ flex: '0 1 280px' }}>
              <span className="icon-wrap tone-info" style={{ width: 48, height: 48 }}><LoaderCircle size={24} className="spin" /></span>
              <div className="col">
                <h3 className="h4">Đang tính phương án…</h3>
                <span className="caption muted">{orders.size} đơn · {vehicles.size} xe · Kho Hải Châu</span>
              </div>
              {step === 'matrix' && run.progress.total > 0 && (
                <div className="col" style={{ gap: 6 }}>
                  <Progress value={run.progress.done / run.progress.total} width="100%" />
                  <span className="caption secondary">Lấy dữ liệu TomTom: {run.progress.done}/{run.progress.total} chặng</span>
                </div>
              )}
              <hr className="divider" />
              <div className="stack-sm">
                {STEPS.map(([key, label], i) => <StepLine key={key} label={label} state={i < stepIndex ? 'done' : i === stepIndex ? 'active' : 'todo'} />)}
              </div>
              <Button variant="secondary" block disabled>Đang tính…</Button>
            </Card>
          )}
        </div>
      )}
      {runs.length > 0 && (
        <Card title="Các lần lập kế hoạch gần đây">
          <div className="stack-sm">
            {runs.slice(0, 6).map(r => (
              <div key={r.id} className="row between">
                <span className="strong">{r.code}</span>
                <span className="secondary grow">{time(r.createdAt)} · {r.createdBy} · {r.orderCount} đơn{r.routeCount ? ` · ${r.routeCount} tuyến` : ''}</span>
                <Badge tone={PLAN_STATUS[r.status][1]}>{PLAN_STATUS[r.status][0]}</Badge>
                {['draft', 'committed', 'superseded'].includes(r.status) && <Link to={`/dispatcher/planning/runs/${r.id}`} className="strong">Xem</Link>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  )
}
