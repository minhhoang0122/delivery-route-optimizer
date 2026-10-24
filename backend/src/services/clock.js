// Giờ địa phương cho lập kế hoạch và giờ dự kiến. Optimization Engine tính giờ bằng số giây kể từ 0:00 của ngày ca làm việc,
// nên Backend đổi thời điểm (Date) sang số giây đó và ngược lại. Việt Nam dùng UTC+7 quanh năm (TZ_OFFSET_MINUTES).
import { config } from '../config.js';

const DAY_MS = 86_400_000;
const offsetMs = () => config.tzOffsetMinutes * 60_000;

/** 0:00 giờ địa phương của ngày chứa thời điểm t. */
export function localMidnight(t = new Date()) {
  const local = new Date(t).getTime() + offsetMs();
  return new Date(local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - offsetMs());
}

/** Số giây từ mốc base (0:00 của ngày ca) tới thời điểm t; có thể lớn hơn 86.400 nếu qua nửa đêm. */
export const secondsFrom = (base, t) => (new Date(t).getTime() - new Date(base).getTime()) / 1000;

/** Thời điểm cách mốc base s giây. */
export const atSeconds = (base, s) => new Date(new Date(base).getTime() + s * 1000);

/** Số giây kể từ 0:00 giờ địa phương của chính ngày đó (0 … 86.399). */
export const secondsOfDay = t => secondsFrom(localMidnight(t), t);

/** "17:30" → 63.000; sai dạng thì trả null. */
export function parseClock(hhmm) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 : null;
}

/** Giờ địa phương dạng HH:MM. */
export function clockText(t) {
  const s = Math.floor(secondsOfDay(t) / 60);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Lần đầu tiên đồng hồ chỉ hhmm (giờ địa phương) sau thời điểm after (bằng after thì lấy luôn khi orEqual). */
export function nextClock(hhmm, after, { orEqual = false } = {}) {
  const s = parseClock(hhmm);
  if (s == null) return null;
  let t = atSeconds(localMidnight(after), s);
  if (t < after || (!orEqual && t.getTime() === new Date(after).getTime())) t = new Date(t.getTime() + DAY_MS);
  return t;
}

/** Thời điểm hôm nay (giờ địa phương) lúc hhmm. */
export function todayAt(hhmm, now = new Date()) {
  const s = parseClock(hhmm);
  return s == null ? null : atSeconds(localMidnight(now), s);
}

/** Làm tròn lên bội số của step phút. */
export const roundUp = (t, stepMinutes = 5) => {
  const step = stepMinutes * 60_000;
  return new Date(Math.ceil(new Date(t).getTime() / step) * step);
};

/** Thời điểm theo dạng TomTom nhận cho departAt: 2026-10-26T16:00:00+07:00. */
export function isoLocal(t) {
  const d = new Date(new Date(t).getTime() + offsetMs());
  const m = Math.abs(config.tzOffsetMinutes);
  const off = `${config.tzOffsetMinutes < 0 ? '-' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${d.toISOString().slice(0, 19)}${off}`;
}
