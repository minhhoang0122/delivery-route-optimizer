// D09 Bản nháp kế hoạch và UC05 Duyệt, giao chuyến.
// Bản nháp chưa giữ chỗ đơn, xe và Driver; bấm Phân chuyến thì Backend kiểm tra lại và ghi trong một transaction.
import { ChevronDown, ChevronRight, Clock, RefreshCw, Split, TriangleAlert } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, newEventId } from '../../api.js'
import MapView, { Legend, MapOverlay } from '../../components/MapView.jsx'
import { geoToLatLngs, NO_ROAD_LEGEND, noRoadRoute } from '../../components/tripMap.js'
import { Alert, Badge, Button, Card, Dialog, Dot, ErrorBox, Loading, LoadError, PageHeader, Progress, Stat } from '../../components/ui.jsx'
import { dateTime, duration, kg, km, parcels, PLAN_STATUS, routeHex, time, VEHICLE_TYPE } from '../../format.js'
import { useAction, useLoad } from '../../hooks.js'

export default function PlanDraftPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useLoad(() => api(`/planning/runs/${id}`), [id])
  const [confirm, setConfirm] = useState(false)
  // Tuyến đang mở danh sách giờ dự kiến từng điểm
  const [open, setOpen] = useState(() => new Set())
  const action = useAction()
  // Một mã thao tác cho mỗi lần mở trang: bấm lại hoặc mạng chập chờn gửi lặp cũng không tạo chuyến trùng
  const commitId = useRef(newEventId())

  const run = data?.run
  const snap = run?.snapshot
  const result = run?.result
  const byOrder = useMemo(() => new Map((snap?.orders ?? []).map(o => [o.id, o])), [snap])
  const byVehicle = useMemo(() => new Map((snap?.vehicles ?? []).map(v => [v.id, v])), [snap])
  const layers = useMemo(() => {
    if (!result?.routes) return { routes: [], stops: [] }
    const depot = [snap.depot.lat, snap.depot.lon]
    const routes = []
    const stops = []
    for (const r of result.routes) {
      const color = routeHex(r.vehicleId)
      const pts = r.orderIds.map(oid => byOrder.get(oid))
      routes.push(r.geometry ? { points: geoToLatLngs(r.geometry), color } : noRoadRoute([depot, ...pts.map(o => [o.lat, o.lon]), depot]))
      pts.forEach((o, i) => stops.push({ lat: o.lat, lon: o.lon, label: i + 1, color, title: `${byVehicle.get(r.vehicleId)?.plate ?? ''} · ${i + 1}. ${o.code} · ${o.recipientName}` }))
    }
    return { routes, stops }
  }, [result, snap, byOrder, byVehicle])

  if (loading && !data) return <Loading />
  if (!run) return <LoadError error={error} onRetry={reload} notFound="Không tìm thấy bản nháp" back="/dispatcher/planning" />
  if (run.status === 'running') return <Loading label="Đang tính phương án…" />

  async function commit() {
    const out = await action.run(() => api(`/planning/runs/${id}/commit`, { method: 'POST', body: { clientEventId: commitId.current } }))
    if (out) navigate('/dispatcher/trips?status=assigned')
  }

  const routes = result?.routes ?? []
  const unassigned = result?.unassigned ?? []
  const total = routes.reduce((s, r) => s + r.seconds, 0)
  const distance = routes.reduce((s, r) => s + (r.distanceM || 0), 0)
  const saved = (result?.stats?.insertionSeconds ?? total) - total
  const placed = routes.reduce((s, r) => s + r.orderIds.length, 0)
  const m = result?.matrix
  // Lấy trong ngày thì chỉ ghi giờ, dữ liệu cũ hơn thì ghi cả ngày
  const at = t => (new Date(t).toDateString() === new Date().toDateString() ? time(t) : dateTime(t))
  const matrixNote = !m ? '' : m.source === 'mock'
    ? 'Thời gian ước lượng, chưa có TomTom'
    : `Thời gian từ TomTom${m.slots?.length ? ` theo giờ ${m.slots.join(', ')}` : ''} · lấy lúc ${at(m.newest)}${m.estimated ? ` · ${m.estimated} chặng ước lượng` : ''}`
  const stats = result?.stats ?? {}
  const shift = result?.shift
  const splits = result?.splitPoints ?? []
  const earlier = stats.finishAt && stats.insertionFinishAt ? (new Date(stats.insertionFinishAt) - new Date(stats.finishAt)) / 1000 : 0
  const toggle = vid => setOpen(o => { const n = new Set(o); if (n.has(vid)) n.delete(vid); else n.add(vid); return n })

  return (
    <>
      <PageHeader title={`Bản nháp kế hoạch #${run.code}`} badge={<Badge tone={PLAN_STATUS[run.status][1]}>{PLAN_STATUS[run.status][0]}</Badge>}
        subtitle={`Tạo lúc ${time(run.createdAt)} bởi ${run.createdBy}`}
        actions={<>
          <Button variant="secondary" icon={RefreshCw} onClick={() => navigate(`/dispatcher/planning?from=${run.id}`)}>Tính lại</Button>
          {run.status === 'draft' && <Button onClick={() => { action.setError(null); setConfirm(true) }} disabled={!routes.length}>Phân chuyến</Button>}
          {run.status === 'committed' && <Link className="btn primary" to="/dispatcher/trips">Xem chuyến đã phân</Link>}
        </>} />
      {run.status === 'failed' && <ErrorBox error={{ message: result?.error || 'Lần tính thất bại' }} />}
      {run.status === 'superseded' && (
        <Alert tone="warning" title="Bản nháp đã có bản mới hơn"
          action={<Link className="btn secondary" to="/dispatcher/planning">Về lập kế hoạch</Link>} />
      )}
      <div className="row top wrap" style={{ gap: 24 }}>
        <div style={{ flex: '1 1 560px', minWidth: 0 }}>
          <MapView height={720} depot={{ ...snap.depot }} routes={layers.routes} stops={layers.stops} fitKey={run.id}>
            <MapOverlay><Legend items={[...routes.map(r => ({ color: routeHex(r.vehicleId), label: byVehicle.get(r.vehicleId)?.plate ?? '' })), { color: '#0f172a', label: snap.depot.name }, ...(routes.some(r => !r.geometry) ? [NO_ROAD_LEGEND] : [])]} /></MapOverlay>
            {matrixNote && <MapOverlay position="bottom-left"><span className="map-chip"><Clock size={16} /> {matrixNote}</span></MapOverlay>}
          </MapView>
        </div>
        <div className="stack" style={{ flex: '0 1 452px', minWidth: 320 }}>
          <Card compact>
            <div className="row top" style={{ gap: 16 }}>
              {stats.finishAt
                ? <div style={{ flex: '1 1 150px' }}><Stat label="Xe cuối về kho" value={time(stats.finishAt)} sub={shift ? `Ca ${time(shift.startAt)}–${time(shift.endAt)}` : undefined} /></div>
                : <div style={{ flex: '1 1 150px' }}><Stat label="Tổng thời gian di chuyển" value={duration(total)} /></div>}
              <Stat sep label="Quãng đường" value={km(distance)} />
              <Stat sep label="Đơn đã xếp" value={`${placed}/${snap.orders.length}`} sub={unassigned.length ? `${unassigned.length} chưa xếp` : undefined} subTone="warning" />
            </div>
          </Card>
          {stats.finishAt ? (
            <Card compact title="Giờ xe cuối về kho" extra={earlier >= 60 && <Badge tone="success">Sớm hơn {duration(earlier)}</Badge>}>
              <div className="row">
                <div className="tile grow" style={{ border: '1px solid var(--line)' }}><span className="caption muted">Xếp lần đầu</span><span className="body-large strong secondary">{time(stats.insertionFinishAt)}</span></div>
                <ChevronRight size={20} className="muted" />
                <div className="tile success grow"><span className="caption secondary">Sau khi sắp xếp lại</span><span className="body-large strong success">{time(stats.finishAt)}</span></div>
              </div>
            </Card>
          ) : (
            <Card compact title="Tổng thời gian di chuyển" extra={saved > 0 && <Badge tone="success">−{duration(saved)}</Badge>}>
              <div className="row">
                <div className="tile grow" style={{ border: '1px solid var(--line)' }}><span className="caption muted">Xếp lần đầu</span><span className="body-large strong secondary">{duration(result?.stats?.insertionSeconds)}</span></div>
                <ChevronRight size={20} className="muted" />
                <div className="tile success grow"><span className="caption secondary">Sau khi sắp xếp lại</span><span className="body-large strong success">{duration(total)}</span></div>
              </div>
            </Card>
          )}
          <Card compact title="Tuyến theo xe" extra={<span className="caption muted">{routes.length} xe · {placed} đơn</span>}>
            <div>
              {routes.map((r, i) => {
                const v = byVehicle.get(r.vehicleId)
                const loadParcels = r.loadParcels ?? r.orderIds.reduce((s, oid) => s + (byOrder.get(oid)?.parcels ?? 1), 0)
                const expanded = open.has(r.vehicleId)
                return (
                  <div key={r.vehicleId} className="col" style={{ padding: '6px 0', gap: 6, borderBottom: i < routes.length - 1 ? '1px solid var(--line)' : 0 }}>
                    <div className="row">
                      <Dot color={routeHex(r.vehicleId)} size={12} />
                      <div className="col grow">
                        <span className="strong">{v.plate} · {v.driverName}</span>
                        <span className="caption muted">{VEHICLE_TYPE[v.type]}{r.returnAt ? ` · về kho ${time(r.returnAt)}` : ''}</span>
                      </div>
                      <div className="col" style={{ width: 198, gap: 4 }}>
                        <div className="row between"><span className="medium">{r.orderIds.length} đơn · {duration(r.seconds)}</span><span className="caption muted">{km(r.distanceM)}</span></div>
                        <div className="row between"><Progress value={r.loadKg / v.capacityKg} color={routeHex(r.vehicleId)} /><span className="caption strong secondary">{kg(r.loadKg)}/{kg(v.capacityKg)}</span></div>
                        <div className="row between">
                          <Progress value={v.capacityParcels ? loadParcels / v.capacityParcels : 0} color={routeHex(r.vehicleId)} />
                          <span className="caption strong secondary">{v.capacityParcels ? `${loadParcels}/${parcels(v.capacityParcels)}` : parcels(loadParcels)}</span>
                        </div>
                      </div>
                      {r.arrivals && <Button variant="ghost" icon={expanded ? ChevronDown : ChevronRight} title="Giờ dự kiến từng điểm" onClick={() => toggle(r.vehicleId)} />}
                    </div>
                    {expanded && (
                      <div className="stack-sm" style={{ paddingLeft: 22 }}>
                        {r.arrivals.map((a, k) => {
                          const o = byOrder.get(a.orderId)
                          return (
                            <div key={a.orderId} className="row between" style={{ gap: 8 }}>
                              <span className="caption"><span className="strong">{k + 1}.</span> {o?.code} · {o?.recipientName} · {o?.address}</span>
                              <span className="caption strong tabular">{time(a.at)}</span>
                            </div>
                          )
                        })}
                        <div className="row between"><span className="caption muted">Về kho</span><span className="caption strong tabular">{time(r.returnAt)}</span></div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
          {splits.length > 0 && (
            <Card compact tone="warning" title={<span className="row" style={{ gap: 8 }}><Split size={18} className="warning" /><span className="h4">Đơn cùng địa chỉ phải tách ({splits.length})</span></span>}>
              {splits.map(sp => (
                <div key={sp.orderIds.join('-')} className="col" style={{ paddingLeft: 12, borderLeft: '1px solid var(--warn)' }}>
                  <span className="strong">{sp.address} · {sp.orderCodes.join(', ')}</span>
                  <span className="caption secondary">{sp.reason} · {sp.parts.map(pt => `${pt.vehicleId ? byVehicle.get(pt.vehicleId)?.plate : 'chưa xếp'}: ${pt.orderIds.length} đơn`).join(' · ')}</span>
                </div>
              ))}
            </Card>
          )}
          {unassigned.length > 0 && (
            <Card compact tone="warning" title={<span className="row" style={{ gap: 8 }}><TriangleAlert size={18} className="warning" /><span className="h4">Đơn chưa xếp ({unassigned.length})</span></span>}>
              {unassigned.map(u => {
                const o = byOrder.get(u.orderId)
                return (
                  <div key={u.orderId} className="col" style={{ paddingLeft: 12, borderLeft: '1px solid var(--warn)' }}>
                    <span className="strong">{o.code} · {o.recipientName} · {kg(o.weightKg)}</span>
                    <span className="caption secondary">{u.reason}</span>
                  </div>
                )
              })}
            </Card>
          )}
        </div>
      </div>
      {confirm && (
        <Dialog title={`Phân ${routes.length} chuyến cho tài xế?`} confirmLabel="Phân chuyến" busy={action.busy} onCancel={() => setConfirm(false)} onConfirm={commit}>
          {unassigned.length > 0 && <p>{unassigned.length} đơn chưa xếp vẫn chờ xếp.</p>}
          <ErrorBox error={action.error} />
        </Dialog>
      )}
    </>
  )
}
