// 时间格式化与本地/UTC 转换（§5.8）。
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import "dayjs/locale/zh-cn";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale("zh-cn");

export const DEFAULT_TZ = "Asia/Shanghai";

/** 当前绝对时刻（UTC ISO，供 get_now_candidates(now) 使用）。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** UTC ISO → 指定时区本地 HH:mm。 */
export function fmtTime(iso: string, tz: string): string {
  const d = dayjs(iso);
  if (!d.isValid()) return iso;
  return d.tz(tz).format("HH:mm");
}

/** UTC ISO → 指定时区本地 YYYY-MM-DD。 */
export function fmtDate(iso: string, tz: string): string {
  const d = dayjs(iso);
  if (!d.isValid()) return iso;
  return d.tz(tz).format("YYYY-MM-DD");
}

/** UTC ISO → 指定时区本地 M月D日 周x HH:mm。 */
export function fmtDateTime(iso: string, tz: string): string {
  const d = dayjs(iso);
  if (!d.isValid()) return iso;
  return d.tz(tz).format("M月D日 ddd HH:mm");
}

/**
 * 本地日期 + 墙钟时间 → 带时区偏移的 ISO 字符串（供后端归一化为 UTC Z）。
 * 例如 ("2025-01-15", "14:00", "Asia/Shanghai") → "2025-01-15T14:00:00+08:00"。
 */
export function buildLocalIso(date: string, time: string, tz: string): string {
  return dayjs.tz(`${date}T${time}:00`, tz).format("YYYY-MM-DDTHH:mm:ssZ");
}

/** 本地 HH:mm（用于新建事件的默认开始时间：当前时间 + 1 小时）。 */
export function nowPlusOneHourLocal(date: string, time: string, tz: string): string {
  const d = dayjs.tz(`${date}T${time}:00`, tz).add(1, "hour");
  return d.format("HH:mm");
}

/** 指定时区的「今天」日期 YYYY-MM-DD。 */
export function todayInTz(tz: string): string {
  return dayjs().tz(tz).format("YYYY-MM-DD");
}

/** 指定时区的当前墙钟时间 HH:mm。 */
export function nowHhmmInTz(tz: string): string {
  return dayjs().tz(tz).format("HH:mm");
}

/** 校验 HH:mm 格式。 */
export function isHhmm(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** 数字直输格式化：1430 → 14:30。 */
export function digitsToHhmm(input: string): string | null {
  const digits = input.replace(/\D/g, "").slice(0, 4);
  if (digits.length < 3) return null;
  const hh = digits.slice(0, 2);
  const mm = digits.slice(2, 4).padEnd(2, "0");
  const h = parseInt(hh, 10);
  const m = parseInt(mm, 10);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
