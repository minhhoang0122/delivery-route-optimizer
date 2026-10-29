// Khung giờ giao của một đơn cho Optimization Engine (mục 3.1.4): giờ sớm nhất và muộn nhất được bắt đầu giao,
// tính bằng giây kể từ 0:00 của ngày ca (base).
//  - windowStart, windowEnd: khung giờ trong ngày Dispatcher nhập (cột TIME, dạng "HH:MM" hoặc "HH:MM:SS");
//  - notBeforeAt: giờ hẹn một lần khách chọn ("giao sau HH:MM"), chỉ tính khi còn sau mốc after.
// Giờ sớm nhất là giờ muộn hơn trong hai giờ trên. Khách tự hẹn giao sau giờ kết thúc khung giờ thì bỏ giờ muộn nhất,
// vì chính khách đã đổi ý; ngược lại đơn sẽ luôn bị coi là trễ.
import { parseClock, secondsFrom } from './clock.js';

/** "17:00" hoặc "17:00:00" → 61.200; null nếu trống. */
export const clockSecondsOf = t => (t == null || t === '' ? null : parseClock(String(t).slice(0, 5)));

/** "17:00:00" → "17:00" (null giữ nguyên). */
export const clockLabel = t => (t == null ? null : String(t).slice(0, 5));

export function windowSeconds(base, { windowStart = null, windowEnd = null, notBeforeAt = null }, { after = null } = {}) {
  const from = clockSecondsOf(windowStart);
  const to = clockSecondsOf(windowEnd);
  const hen = notBeforeAt && (!after || new Date(notBeforeAt) > new Date(after)) ? secondsFrom(base, notBeforeAt) : null;
  const starts = [from, hen].filter(x => x != null);
  const notBeforeSeconds = starts.length ? Math.max(...starts) : null;
  const notAfterSeconds = to != null && (notBeforeSeconds == null || to > notBeforeSeconds) ? to : null;
  return { notBeforeSeconds, notAfterSeconds };
}
