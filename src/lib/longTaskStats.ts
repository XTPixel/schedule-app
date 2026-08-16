// V1.2：长期任务派生统计纯函数（不落库；单测友好）。
import dayjs from "dayjs";
import type { LongTask, LongTaskSession } from "../types";

export interface LongTaskStats {
  sessionCount: number;
  totalDurationMs: number;
  todayCount: number;
  todayDurationMs: number;
  avgDurationMs: number;
  lastSessionAt: string | null;
  /** dueDate - today（天）；负数 = 已截止。 */
  remainingDays: number;
}

export function effectiveSessions(task: LongTask): LongTaskSession[] {
  return task.sessions.filter((s) => s.deletedAt == null);
}

/** 纯日期字典序比较：today ∈ [startDate, dueDate] 且任务未结束、未删除。 */
export function isLongTaskInWindow(task: LongTask, today: string): boolean {
  if (task.deletedAt != null || task.status !== "active") return false;
  return task.startDate <= today && today <= task.dueDate;
}

export function computeLongTaskStats(task: LongTask, today: string, tz: string): LongTaskStats {
  const sessions = effectiveSessions(task);
  let totalDurationMs = 0;
  let todayCount = 0;
  let todayDurationMs = 0;
  let lastSessionAt: string | null = null;

  for (const s of sessions) {
    totalDurationMs += Math.max(0, s.durationMs);
    // V1.2.1：会话按 endedAt 本地日期归属（与归档 / 统计口径一致）。
    const d = dayjs(s.endedAt).tz(tz).format("YYYY-MM-DD");
    if (d === today) {
      todayCount += 1;
      todayDurationMs += Math.max(0, s.durationMs);
    }
    if (!lastSessionAt || s.startedAt > lastSessionAt) lastSessionAt = s.startedAt;
  }

  const count = sessions.length;
  const start = dayjs(task.startDate);
  const due = dayjs(task.dueDate);
  const remainingDays = start.isValid() && due.isValid() ? due.diff(dayjs(today), "day") : 0;

  return {
    sessionCount: count,
    totalDurationMs,
    todayCount,
    todayDurationMs,
    avgDurationMs: count > 0 ? Math.round(totalDurationMs / count) : 0,
    lastSessionAt,
    remainingDays,
  };
}

/** 毫秒 → 计时器显示 HH:MM:SS（或 MM:SS）。 */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 时长的人类可读文案（分钟取整）。 */
export function fmtDurationMs(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 投入摘要：`今日 2 次 · 45 分钟 ｜ 累计 18 次 · 12.5 小时`。 */
export function longTaskInvestLabel(stats: LongTaskStats): string {
  const today =
    stats.todayCount > 0 ? `今日 ${stats.todayCount} 次 · ${fmtDurationMs(stats.todayDurationMs)}` : null;
  const total = `累计 ${stats.sessionCount} 次 · ${fmtDurationMs(stats.totalDurationMs)}`;
  return today ? `${today} ｜ ${total}` : total;
}
