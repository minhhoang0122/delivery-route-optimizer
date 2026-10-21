// R07 Lịch sử chuyến (UC15): Driver chỉ xem lại chuyến của mình, kể cả chuyến đã chốt.
import { ChevronLeft, ChevronRight, History } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api } from '../../api.js'
import { useAuth } from '../../auth.jsx'
import { DriverScreen } from '../../layouts/DriverLayout.jsx'
import { Chips, Empty, ErrorBox, Loading, StatusBadge, StopItem } from '../../components/ui.jsx'
import { stopState } from '../../components/tripMap.js'
import { kg, longDate, time, TRIP_STATUS, VEHICLE_TYPE } from '../../format.js'
import { useLoad } from '../../hooks.js'

export default function HistoryPage() {
  const { user } = useAuth()
  const { data, error, loading, reload } = useLoad(() => api('/driver/trips'))
  const [filter, setFilter] = useState('all')
  const trips = (data?.trips ?? []).filter(t => filter === 'all' || t.status === filter)
  return (
    <DriverScreen title="Lịch sử chuyến" subtitle={`${user.fullName} · ${data?.trips.length ?? 0} chuyến gần nhất`}>
      <Chips value={filter} onChange={setFilter} items={[
        { value: 'all', label: 'Tất cả' }, { value: 'awaiting_reconciliation', label: 'Chờ đối chiếu' }, { value: 'closed', label: 'Đã chốt' },
      ]} />
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data && <Loading />}
      {data && trips.length === 0 && <Empty icon={History} title="Chưa có chuyến nào" />}
      {trips.map(t => (
        <Link key={t.id} to={`/driver/history/${t.id}`} className="card" style={{ padding: 16, gap: 8, color: 'inherit', textDecoration: 'none' }}>
          <div className="row between"><span className="caption muted">{longDate(t.createdAt)}</span><StatusBadge map={TRIP_STATUS} value={t.status} large /></div>
          <div className="row">
            <div className="col grow">
              <span className="body-large strong">{t.code}</span>
              <span className="secondary">{t.total} điểm · {t.delivered} giao thành công{t.failed ? ` · ${t.failed} chưa giao được` : ''}</span>
            </div>
            <ChevronRight size={20} className="muted" />
          </div>
        </Link>
      ))}
    </DriverScreen>
  )
}

export function HistoryDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, error, loading } = useLoad(() => api(`/driver/trips/${id}`), [id])
  const t = data?.trip
  const back = <button type="button" className="btn ghost icon-only" onClick={() => navigate('/driver/history')} title="Quay lại"><ChevronLeft size={22} /></button>
  return (
    <DriverScreen title={t ? `Chuyến ${t.code}` : 'Chuyến'} subtitle={t && `${VEHICLE_TYPE[t.vehicle.type]} ${t.vehicle.plate} · ${t.progress.done}/${t.progress.total} điểm`} back={back}>
      <ErrorBox error={error} />
      {loading && !t && <Loading />}
      {t && (
        <>
          <section className="card" style={{ gap: 8 }}>
            <div className="row between"><span className="h4">Tóm tắt</span><StatusBadge map={TRIP_STATUS} value={t.status} large /></div>
            <span className="secondary">Xuất phát {time(t.startedAt)} · về kho {time(t.returnedAt)}{t.closedAt ? ` · chốt ${time(t.closedAt)}` : ''}</span>
            <span className="secondary">{t.progress.delivered} giao thành công · {t.progress.failed} chưa giao được · {kg(t.loadKg)}</span>
          </section>
          {t.stops.map(s => (
            <StopItem key={s.id} state={stopState(s, t.nextStopId)} seq={s.seq} name={s.order.recipientName} address={s.order.address}
              meta={s.attempt ? `${s.attempt.result === 'delivered' ? 'Đã giao' : s.attempt.reason} ${time(s.attempt.occurredAt)} · ${s.order.code}` : `${s.order.code} · chưa có kết quả`} />
          ))}
        </>
      )}
    </DriverScreen>
  )
}
