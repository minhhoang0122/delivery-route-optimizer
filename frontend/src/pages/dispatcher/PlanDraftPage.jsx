// D09 Bản nháp kế hoạch và UC05 Duyệt, giao chuyến.
// Bản nháp chưa giữ chỗ đơn, xe và Driver; bấm Giao chuyến thì Backend kiểm tra lại và ghi trong một transaction.
import { ChevronRight, Clock, RefreshCw, TriangleAlert } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, newEventId } from '../../api.js'
import MapView, { Legend, MapOverlay } from '../../components/MapView.jsx'
import { geoToLatLngs, NO_ROAD_LEGEND, noRoadRoute } from '../../components/tripMap.js'
import { Alert, Badge, Button, Card, Dialog, Dot, ErrorBox, Loading, LoadError, PageHeader, Progress, Stat } from '../../components/ui.jsx'
import { dateTime, duration, kg, km, PLAN_STATUS, routeHex, time, VEHICLE_TYPE } from '../../format.js'
import { useAction, useLoad } from '../../hooks.js'

export default function PlanDraftPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useLoad(() => api(`/planning/runs/${id}`), [id])
  const [confirm, setConfirm] = useState(false)
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
      pts.forEach((o, i) => stops.push({ lat: o.lat, lon: o.lon, label: i + 1, color, title: `Xe ${r.vehicleId} · ${i + 1}. ${o.code} · ${o.recipientName}` }))
    }
    return { routes, stops }
  }, [result, snap, byOrder])

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
    : `Thời gian từ TomTom · lấy lúc ${at(m.newest)}${m.estimated ? ` · ${m.estimated} chặng ước lượng` : ''}`

  return (
    <>
      <PageHeader title={`Bản nháp kế hoạch #${run.code}`} badge={<Badge tone={PLAN_STATUS[run.status][1]}>{PLAN_STATUS[run.status][0]}</Badge>}
        subtitle={`Tạo lúc ${time(run.createdAt)} bởi ${run.createdBy}`}
        actions={<>
          <Button variant="secondary" icon={RefreshCw} onClick={() => navigate(`/dispatcher/planning?from=${run.id}`)}>Tính lại</Button>
          {run.status === 'draft' && <Button onClick={() => { action.setError(null); setConfirm(true) }} disabled={!routes.length}>Giao chuyến</Button>}
          {run.status === 'committed' && <Link className="btn primary" to="/dispatcher/trips">Xem chuyến đã giao</Link>}
        </>} />
      {run.status === 'failed' && <ErrorBox error={{ message: result?.error || 'Lần tính thất bại' }} />}
      {run.status === 'superseded' && (
        <Alert tone="warning" title="Bản nháp đã có bản mới hơn"
          action={<Link className="btn secondary" to="/dispatcher/planning">Về lập kế hoạch</Link>} />
      )}
      <div className="row top wrap" style={{ gap: 24 }}>
        <div style={{ flex: '1 1 560px', minWidth: 0 }}>
          <MapView height={720} depot={{ ...snap.depot }} routes={layers.routes} stops={layers.stops} fitKey={run.id}>
            <MapOverlay><Legend items={[...routes.map(r => ({ color: routeHex(r.vehicleId), label: `Xe ${r.vehicleId}` })), { color: '#0f172a', label: snap.depot.name }, ...(routes.some(r => !r.geometry) ? [NO_ROAD_LEGEND] : [])]} /></MapOverlay>
            {matrixNote && <MapOverlay position="bottom-left"><span className="map-chip"><Clock size={16} /> {matrixNote}</span></MapOverlay>}
          </MapView>
        </div>
        <div className="stack" style={{ flex: '0 1 452px', minWidth: 320 }}>
          <Card compact>
            <div className="row top" style={{ gap: 16 }}>
              <div style={{ flex: '1 1 170px' }}><Stat label="Tổng thời gian di chuyển" value={duration(total)} /></div>
              <Stat sep label="Quãng đường" value={km(distance)} />
              <Stat sep label="Đơn đã xếp" value={`${placed}/${snap.orders.length}`} sub={unassigned.length ? `${unassigned.length} chưa xếp` : undefined} subTone="warning" />
            </div>
          </Card>
          <Card compact title="Tổng thời gian di chuyển" extra={saved > 0 && <Badge tone="success">−{duration(saved)}</Badge>}>
            <div className="row">
              <div className="tile grow" style={{ border: '1px solid var(--line)' }}><span className="caption muted">Ban đầu</span><span className="body-large strong secondary">{duration(result?.stats?.insertionSeconds)}</span></div>
              <ChevronRight size={20} className="muted" />
              <div className="tile success grow"><span className="caption secondary">Sau tối ưu</span><span className="body-large strong success">{duration(total)}</span></div>
            </div>
          </Card>
          <Card compact title="Tuyến theo xe" extra={<span className="caption muted">{routes.length} xe · {placed} điểm</span>}>
            <div>
              {routes.map((r, i) => {
                const v = byVehicle.get(r.vehicleId)
                return (
                  <div key={r.vehicleId} className="row" style={{ padding: '6px 0', borderBottom: i < routes.length - 1 ? '1px solid var(--line)' : 0 }}>
                    <Dot color={routeHex(r.vehicleId)} size={12} />
                    <div className="col grow">
                      <span className="strong">Xe {r.vehicleId} · {v.driverName}</span>
                      <span className="caption muted">{VEHICLE_TYPE[v.type]} {v.plate}</span>
                    </div>
                    <div className="col" style={{ width: 198, gap: 6 }}>
                      <div className="row between"><span className="medium">{r.orderIds.length} đơn · {duration(r.seconds)}</span><span className="caption muted">{km(r.distanceM)}</span></div>
                      <div className="row between"><Progress value={r.loadKg / v.capacityKg} color={routeHex(r.vehicleId)} /><span className="caption strong secondary">{kg(r.loadKg)}/{kg(v.capacityKg)}</span></div>
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
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
        <Dialog title={`Giao ${routes.length} chuyến cho Driver?`} confirmLabel="Giao chuyến" busy={action.busy} onCancel={() => setConfirm(false)} onConfirm={commit}>
          {unassigned.length > 0 && <p>{unassigned.length} đơn chưa xếp vẫn chờ xếp.</p>}
          <ErrorBox error={action.error} />
        </Dialog>
      )}
    </>
  )
}
