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

/** Thời gian Driver còn hoàn tác được kết quả vừa ghi, trước khi thiết bị gửi lên máy chủ. */
export const UNDO_MS = 10_000

/**
 * Thêm thao tác vào hàng đợi. item: { clientEventId, userId, path, body, tripId, stopId, kind, label }
 * userId: người tạo thao tác; đăng xuất rồi người khác đăng nhập trên cùng máy thì thao tác vẫn được giữ nhưng không gửi.
 * holdMs: giữ trên máy ngần ấy mili giây rồi mới gửi (để hoàn tác); đóng ứng dụng trong lúc giữ thì lần mở sau vẫn gửi.
 */
export async function enqueue(item, { holdMs = 0 } = {}) {
  const now = Date.now()
  await tx('outbox', 'readwrite', s => s.put({
    ...item, createdAt: new Date(now).toISOString(), sendAfter: holdMs ? new Date(now + holdMs).toISOString() : null, state: 'pending', error: null,
  }))
  notify()
}

/** Thao tác còn trong thời gian hoàn tác. */
export const isHeld = (item, now = Date.now()) => Boolean(item.sendAfter) && item.state === 'pending' && Date.parse(item.sendAfter) > now

async function update(id, patch) {
  const all = await listOutbox()
  const cur = all.find(x => x.clientEventId === id)
  if (!cur) return false
  await tx('outbox', 'readwrite', s => s.put({ ...cur, ...patch }))
  notify()
  return true
}

export async function removeItem(id) {
  await tx('outbox', 'readwrite', s => s.delete(id))
  notify()
}

// Thao tác ghi trước khi có userId (bản cũ) được coi là của người đang đăng nhập
const ownedBy = (item, userId) => (item.userId ?? userId) === userId

/** Hàng đợi của một người dùng. */
export const listOwnOutbox = async userId => (await listOutbox()).filter(x => ownedBy(x, userId))

/**
 * Bỏ các kết quả máy chủ đã từ chối (409) cho điểm dừng mà máy chủ đã có kết quả cuối:
 * không còn gì để gửi nên không để Driver phải tự xóa.
 */
export async function dropSettled(trip, userId) {
  if (!trip) return
  const settled = new Set(trip.stops.filter(s => s.status !== 'pending').map(s => s.id))
  for (const x of await listOwnOutbox(userId)) {
    if (x.kind === 'attempt' && x.state === 'failed' && x.errorStatus === 409 && x.tripId === trip.id && settled.has(x.stopId)) {
      await removeItem(x.clientEventId)
    }
  }
}

let flushing = null

/**
 * Gửi các thao tác chờ theo thứ tự. Mất mạng thì dừng và giữ nguyên hàng đợi.
 * Máy chủ trả lỗi nghiệp vụ (xung đột, sai dữ liệu) thì giữ lại thao tác với trạng thái lỗi để Driver xử lý.
 * Chỉ gửi thao tác của userId (người đang đăng nhập). retryFailed: gửi lại cả các thao tác đã lỗi (nút Thử lại).
 */
export function flush({ userId, retryFailed = false } = {}) {
  flushing ??= (async () => {
    try {
      for (const item of await listOwnOutbox(userId)) {
        if (item.state === 'failed' && !retryFailed) continue
        // Còn trong thời gian hoàn tác: chưa gửi, các thao tác sau vẫn gửi bình thường
        if (isHeld(item)) continue
        // Driver vừa hoàn tác (thao tác đã bị xóa khỏi hàng đợi) thì không gửi
        if (!(await update(item.clientEventId, { state: 'sending' }))) continue
        try {
          await api(item.path, { method: 'POST', body: item.body })
          await removeItem(item.clientEventId)
        } catch (e) {
          // Mất mạng, máy chủ tạm lỗi (5xx), phiên hết hạn (401) hoặc tài khoản bị khóa (gửi lại sau khi đăng nhập lại):
          // giữ nguyên để gửi lại sau, theo đúng thứ tự
          if (e.status === 0 || e.status === 401 || e.status >= 500 || e.code === 'ACCOUNT_LOCKED') { await update(item.clientEventId, { state: 'pending' }); break }
          // Báo đã nhận tuyến bị từ chối (đã có phiên bản mới hơn, chuyến đã kết thúc): bỏ, lần tải chuyến sau gửi lại cho phiên bản hiện hành
          if (item.kind === 'route_ack') { await removeItem(item.clientEventId); continue }
          await update(item.clientEventId, { state: 'failed', error: e.message, errorStatus: e.status })
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
export const cacheDelete = key => tx('cache', 'readwrite', s => s.delete(key))
