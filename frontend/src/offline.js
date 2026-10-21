// Hàng đợi thao tác của Driver trong IndexedDB (mục 3.5).
// Khi mất mạng, kết quả giao được lưu trên máy kèm mã thao tác; thiết bị gửi lại theo thứ tự khi có mạng và
// chỉ xóa khỏi hàng đợi sau khi máy chủ xác nhận. Chuyến đã tải cũng được lưu để Driver vẫn xem được khi mất mạng.
import { api } from './api.js'

const DB_NAME = 'lastmile-driver'
let dbPromise = null

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const d = req.result
      d.createObjectStore('outbox', { keyPath: 'clientEventId' })
      d.createObjectStore('cache')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx(store, mode, fn) {
  const d = await db()
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode)
    const out = fn(t.objectStore(store))
    t.oncomplete = () => resolve(out?.result)
    t.onerror = () => reject(t.error)
  })
}

const listeners = new Set()
const notify = () => listeners.forEach(fn => fn())
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn) }

export const listOutbox = async () =>
  ((await tx('outbox', 'readonly', s => s.getAll())) || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt))

/** Thêm thao tác vào hàng đợi. item: { clientEventId, path, body, tripId, stopId, kind, label } */
export async function enqueue(item) {
  await tx('outbox', 'readwrite', s => s.put({ ...item, createdAt: new Date().toISOString(), state: 'pending', error: null }))
  notify()
}

async function update(id, patch) {
  const all = await listOutbox()
  const cur = all.find(x => x.clientEventId === id)
  if (!cur) return
  await tx('outbox', 'readwrite', s => s.put({ ...cur, ...patch }))
  notify()
}

export async function removeItem(id) {
  await tx('outbox', 'readwrite', s => s.delete(id))
  notify()
}

let flushing = null

/**
 * Gửi các thao tác chờ theo thứ tự. Mất mạng thì dừng và giữ nguyên hàng đợi.
 * Máy chủ trả lỗi nghiệp vụ (xung đột, sai dữ liệu) thì giữ lại thao tác với trạng thái lỗi để Driver xử lý.
 */
export function flush() {
  flushing ??= (async () => {
    try {
      for (const item of await listOutbox()) {
        if (item.state === 'failed') continue
        await update(item.clientEventId, { state: 'sending' })
        try {
          await api(item.path, { method: 'POST', body: item.body })
          await removeItem(item.clientEventId)
        } catch (e) {
          // Mất mạng hoặc máy chủ tạm lỗi (5xx): giữ nguyên để gửi lại sau, theo đúng thứ tự
          if (e.status === 0 || e.status >= 500) { await update(item.clientEventId, { state: 'pending' }); break }
          await update(item.clientEventId, { state: 'failed', error: e.message })
        }
      }
    } finally {
      flushing = null
    }
  })()
  return flushing
}

export const cacheSet = (key, value) => tx('cache', 'readwrite', s => s.put(value, key))
export const cacheGet = key => tx('cache', 'readonly', s => s.get(key))
