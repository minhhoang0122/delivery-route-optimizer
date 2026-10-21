// Khung ứng dụng Driver trên điện thoại. Giữ chuyến hiện tại, hàng đợi thao tác chờ gửi và việc chia sẻ vị trí
// ở một chỗ để mọi màn hình Driver dùng chung (React Context).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { History, LogOut, Navigation } from 'lucide-react'
import { NavLink, Outlet } from 'react-router'
import { api, newEventId } from '../api.js'
import { useAuth } from '../auth.jsx'
import { cacheGet, cacheSet, flush, listOutbox, subscribe } from '../offline.js'
import { DriverContext, useDriver } from './driverContext.js'


const POSITION_EVERY_MS = 10_000

/** Gửi vị trí thiết bị theo chu kỳ khi chuyến đang giao (UC12). Vị trí chỉ cần giá trị mới nhất nên không xếp hàng đợi. */
function useShareLocation(trip) {
  const [state, setState] = useState({ status: 'idle', lastSentAt: null })
  const lastSent = useRef(0)
  const tripId = trip?.status === 'in_progress' ? trip.id : null
  useEffect(() => {
    if (!tripId) return undefined
    if (!('geolocation' in navigator)) return undefined
    const watch = navigator.geolocation.watchPosition(async pos => {
      if (Date.now() - lastSent.current < POSITION_EVERY_MS) return
      lastSent.current = Date.now()
      try {
        await api(`/driver/trips/${tripId}/positions`, {
          method: 'POST',
          body: {
            clientEventId: newEventId(), lat: pos.coords.latitude, lon: pos.coords.longitude,
            observedAt: new Date(pos.timestamp).toISOString(), accuracyM: pos.coords.accuracy, source: 'device',
          },
        })
        setState({ status: 'sharing', lastSentAt: new Date() })
      } catch {
        setState(s => ({ ...s, status: 'failed' }))
      }
    }, err => setState(s => ({ ...s, status: err.code === 1 ? 'denied' : 'unavailable' })), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 })
    return () => navigator.geolocation.clearWatch(watch)
  }, [tripId])
  return 'geolocation' in navigator ? state : { ...state, status: 'unavailable' }
}

function DriverProvider({ children }) {
  const [trip, setTrip] = useState(undefined)
  const [serverTime, setServerTime] = useState(null)
  const [fromCache, setFromCache] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [outbox, setOutbox] = useState([])
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    try {
      const d = await api('/driver/current-trip')
      setTrip(d.trip)
      setServerTime(d.serverTime)
      setFromCache(false)
      setError(null)
      cacheSet('currentTrip', d.trip ?? null).catch(() => {})
    } catch (e) {
      // Mất mạng: dùng chuyến đã tải trước đó để Driver vẫn xem được điểm kế tiếp
      if (e.status === 0 || e.status >= 500) {
        const cached = await cacheGet('currentTrip').catch(() => undefined)
        if (cached !== undefined) { setTrip(t => (t === undefined ? cached : t)); setFromCache(true) }
      } else setError(e)
    }
  }, [])

  const refreshOutbox = useCallback(() => listOutbox().then(setOutbox).catch(() => {}), [])

  const sync = useCallback(async () => {
    await flush()
    await refreshOutbox()
    await reload()
  }, [refreshOutbox, reload])

  useEffect(() => {
    // reload và refreshOutbox chỉ đặt state sau khi chờ mạng hoặc IndexedDB, không gây render dây chuyền
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload()
    refreshOutbox()
    const off = subscribe(refreshOutbox)
    const up = () => { setOnline(true); sync() }
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    const id = setInterval(() => { if (navigator.onLine) sync() }, 10_000)
    return () => { off(); window.removeEventListener('online', up); window.removeEventListener('offline', down); clearInterval(id) }
  }, [reload, refreshOutbox, sync])

  const location = useShareLocation(trip)

  // Kết quả đã lưu trên máy nhưng chưa được máy chủ xác nhận: hiển thị tạm trên điểm dừng, kèm trạng thái chờ gửi
  const view = useMemo(() => {
    if (!trip) return trip
    const queued = new Map(outbox.filter(x => x.kind === 'attempt' && x.tripId === trip.id).map(x => [x.stopId, x]))
    if (!queued.size) return trip
    const stops = trip.stops.map(s => {
      const q = queued.get(s.id)
      if (!q || s.status !== 'pending') return s
      return { ...s, status: q.body.result, attempt: { result: q.body.result, reason: q.body.reason, note: q.body.note, occurredAt: q.body.occurredAt }, queued: q }
    })
    const next = stops.find(s => s.status === 'pending')
    return { ...trip, stops, nextStopId: trip.status === 'in_progress' ? next?.id ?? null : null }
  }, [trip, outbox])

  const value = { trip: view, rawTrip: trip, reload, sync, outbox, online, fromCache, serverTime, location, error, setTrip }
  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>
}

export function SyncIndicator() {
  const { online, outbox } = useDriver()
  const waiting = outbox.filter(x => x.state !== 'failed').length
  const sending = outbox.some(x => x.state === 'sending')
  if (!online) return <span className="sync offline">Mất mạng{waiting ? ` · ${waiting} chờ gửi` : ''}</span>
  if (sending) return <span className="sync sending">Đang gửi</span>
  if (waiting) return <span className="sync pending">Chờ gửi {waiting}</span>
  return <span className="sync saved">Đã ghi</span>
}

/** Màn hình Driver: thanh trên, nội dung cuộn, nút lớn ở chân màn hình. */
export function DriverScreen({ title, subtitle, back, footer, children }) {
  const { logout } = useAuth()
  return (
    <>
      <header className="topbar">
        {back}
        <div className="col grow">
          <span className="topbar-title">{title}</span>
          {subtitle && <span className="caption muted">{subtitle}</span>}
        </div>
        <SyncIndicator />
        <button type="button" className="btn ghost icon-only" title="Đăng xuất" onClick={logout}><LogOut size={18} /></button>
      </header>
      <main className="mobile-body">{children}</main>
      <footer className="mobile-footer">
        {footer}
        <nav className="mobile-nav">
          <NavLink to="/driver" end><Navigation size={20} />Chuyến hiện tại</NavLink>
          <NavLink to="/driver/history"><History size={20} />Lịch sử chuyến</NavLink>
        </nav>
      </footer>
    </>
  )
}

export default function DriverLayout() {
  return (
    <DriverProvider>
      <div className="mobile"><Outlet /></div>
    </DriverProvider>
  )
}
