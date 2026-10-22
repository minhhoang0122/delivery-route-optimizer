// Hook dùng chung: tải dữ liệu, tự làm mới theo chu kỳ và đồng hồ giây cho nhãn "x giây trước".
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Tải dữ liệu bằng hàm loader. interval (ms) thì tự tải lại theo chu kỳ (HTTP theo chu kỳ, mục 2.5.4).
 * Kết quả đến muộn của lần tải cũ không ghi đè kết quả mới hơn.
 */
/** Chu kỳ tải lại các màn hình theo dõi; đặt VITE_LIVE_POLL_MS nhỏ hơn khi chạy demo mô phỏng. */
export const LIVE_MS = Number(import.meta.env.VITE_LIVE_POLL_MS) || 10_000

export function useLoad(loader, deps = [], { interval } = {}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const loaderRef = useRef(loader)
  useEffect(() => { loaderRef.current = loader })

  const reload = useCallback(async () => {
    const my = ++seq.current
    try {
      const d = await loaderRef.current()
      if (my === seq.current) { setData(d); setError(null) }
    } catch (e) {
      if (my === seq.current) setError(e)
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
    if (!interval) return undefined
    const id = setInterval(reload, interval)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, interval, reload])

  return { data, error, loading, reload, setData }
}

/** Thời điểm hiện tại, cập nhật mỗi giây. */
export function useNow(step = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), step)
    return () => clearInterval(id)
  }, [step])
  return now
}

/**
 * Chạy một thao tác ghi: giữ trạng thái đang gửi và lỗi để hiển thị.
 * Trả về kết quả của thao tác (hoặc true) khi thành công, false khi lỗi; lỗi được giữ trong error.
 */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const run = useCallback(async fn => {
    setBusy(true)
    setError(null)
    try {
      return (await fn()) ?? true
    } catch (e) {
      setError(e)
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, setError, run }
}
