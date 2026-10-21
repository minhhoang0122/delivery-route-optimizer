// D09 Bản nháp kế hoạch và UC05 Duyệt, giao chuyến.
// Bản nháp chưa giữ chỗ đơn, xe và Driver; bấm Giao chuyến thì Backend kiểm tra lại và ghi trong một transaction.
import { ChevronRight, Clock, RefreshCw, TriangleAlert } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, newEventId } from '../../api.js'
import MapView, { Legend, MapOverlay } from '../../components/MapView.jsx'
import { geoToLatLngs } from '../../components/tripMap.js'
import { Badge, Button, Card, Dialog, Dot, ErrorBox, Loading, PageHeader, Progress, Stat } from '../../components/ui.jsx'
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
      routes.push({ points: geoToLatLngs(r.geometry) || [depot, ...pts.map(o => [o.lat, o.lon]), depot], color, dashed: !r.geometry })
      pts.forEach((o, i) => stops.push({ lat: o.lat, lon: o.lon, label: i + 1, color, title: `Xe ${r.vehicleId} · ${i + 1}. ${o.code} · ${o.recipientName}` }))
    }
    return { routes, stops }
  }, [result, snap, byOrder])

  if (loading && !data) return <Loading />
  if (!run) return <ErrorBox error={error} onRetry={reload} />
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
  const matrixNote = !m ? '' : m.source === 'mock'
    ? 'Thời gian ước lượng theo khoảng cách (chạy thử, không phải TomTom)'
    : m.estimated ? `TomTom (ghi lúc ${dateTime(m.newest)}), ${m.estimated} chặng ước lượng do chưa có khóa`
      : m.fetched ? `Thời gian di chuyển từ TomTom · lấy lúc ${time(m.newest)}` : `Ma trận TomTom đã ghi lúc ${dateTime(m.newest)}`

  return (
    <>
      <PageHeader title={`Bản nháp kế hoạch #${run.code}`} badge={<Badge tone={PLAN_STATUS[run.status][1]}>{PLAN_STATUS[run.status][0]}</Badge>}
        subtitle={`Tạo lúc ${time(run.createdAt)} bởi ${run.createdBy}${run.status === 'draft' ? ' · chưa giữ chỗ đơn, xe và Driver' : ''}`}
        actions={<>
          <Button variant="secondary" icon={RefreshCw} onClick={() => navigate(`/dispatcher/planning?from=${run.id}`)}>Tính lại</Button>
          {run.status === 'draft' && <Button onClick={() => { action.setError(null); setConfirm(true) }} disabled={!routes.length}>Giao chuyến</Button>}
          {run.status === 'committed' && <Link className="btn primary" to="/dispatcher/trips">Xem chuyến đã giao</Link>}
        </>} />
      {run.status === 'failed' && <ErrorBox error={{ message: result?.error || 'Lần tính thất bại' }} />}
      {run.status === 'superseded' && <ErrorBox error={{ message: 'Bản nháp này đã hết hiệu lực vì đã có bản nháp mới hơn. Hãy tính lại nếu muốn dùng.' }} />}
      <div className="row top wrap" style={{ gap: 24 }}>
        <div style={{ flex: '1 1 560px', minWidth: 0 }}>
          <MapView height={720} depot={{ ...snap.depot }} routes={layers.routes} stops={layers.stops} fitKey={run.id}>
            <MapOverlay><Legend items={[...routes.map(r => ({ color: routeHex(r.vehicleId), label: `Xe ${r.vehicleId}` })), { color: '#0f172a', label: snap.depot.name }]} /></MapOverlay>
            {matrixNote && <MapOverlay position="bottom-left"><span className="map-chip"><Clock size={16} /> {matrixNote}</span></MapOverlay>}
          </MapView>
        </div>
        <div className="stack" style={{ flex: '0 1 452px', minWidth: 320 }}>
          <Card compact>
            <div className="row top" style={{ gap: 16 }}>
              <div style={{ flex: '1 1 170px' }}><Stat label="Tổng thời gian di chuyển" value={duration(total)} sub={saved > 0 ? `−${duration(saved)} sau cải thiện` : 'Không cải thiện thêm được'} subTone={saved > 0 ? 'success' : 'muted'} /></div>
              <Stat sep label="Quãng đường" value={km(distance)} sub={`${routes.length} tuyến`} />
              <Stat sep label="Đơn đã xếp" value={`${placed}/${snap.orders.length}`} sub={unassigned.length ? `${unassigned.length} chưa xếp` : 'Xếp hết'} subTone={unassigned.length ? 'warning' : 'success'} />
            </div>
          </Card>
          <Card compact title="So sánh trước và sau cải thiện" extra={saved > 0 && <Badge tone="success">−{duration(saved)}</Badge>}>
            <div className="row">
              <div className="tile grow" style={{ border: '1px solid var(--line)' }}><span className="caption muted">Insertion Heuristic</span><span className="body-large strong secondary">{duration(result?.stats?.insertionSeconds)}</span></div>
              <ChevronRight size={20} className="muted" />
              <div className="tile success grow"><span className="caption secondary">Sau Relocate và Swap</span><span className="body-large strong success">{duration(total)}</span></div>
            </div>
            <span className="caption muted">{result?.stats?.evaluations?.toLocaleString('vi-VN')} phép đánh giá · {result?.stats?.stopReason} · tính trong {Math.round(result?.stats?.ms ?? 0)} ms</span>
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
            <Card compact tone="warning" title={<span className="row" style={{ gap: 8 }}><TriangleAlert size={18} className="warning" /><span className="h4">Đơn chưa xếp ({unassigned.length})</span></span>}
              extra={<span className="caption muted">Vẫn ở trạng thái Chờ xếp</span>}>
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
          <p>Hệ thống kiểm tra lại đơn, xe và Driver rồi ghi chuyến, điểm dừng và tuyến đầu tiên trong một giao dịch. Nếu có thay đổi so với bản nháp thì không chuyến nào được lưu.</p>
          {unassigned.length > 0 && <p>{unassigned.length} đơn chưa xếp vẫn ở trạng thái Chờ xếp.</p>}
          <ErrorBox error={action.error} />
        </Dialog>
      )}
    </>
  )
}
