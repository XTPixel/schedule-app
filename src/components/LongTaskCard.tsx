import { useEffect, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { todayInTz } from "../lib/time";
import { computeLongTaskStats, fmtClock, fmtDurationMs, isLongTaskInWindow } from "../lib/longTaskStats";
import { PRIORITY_BADGE, PRIORITY_LABEL } from "../lib/format";
import { TagChips } from "./TagFilter";
import type { LongTask, LongTaskSession } from "../types";
import { SessionSummaryDialog } from "./SessionSummaryDialog";

interface Props {
  task: LongTask;
}

/** V1.2：「现在」页 / 长期任务页共用的长期任务卡片与三按钮状态机。 */
export function LongTaskCard({ task }: Props) {
  const tz = useAppStore((s) => s.data?.config.timezone ?? "Asia/Shanghai");
  const timer = useAppStore((s) => s.timers[task.id]);
  const toggleLongTaskTimer = useAppStore((s) => s.toggleLongTaskTimer);
  const terminateLongTaskSession = useAppStore((s) => s.terminateLongTaskSession);
  const openDrawer = useAppStore((s) => s.openDrawer);

  const [, setTick] = useState(0);
  const [terminating, setTerminating] = useState(false);
  const [finishedSession, setFinishedSession] = useState<LongTaskSession | null>(null);

  const todayDate = todayInTz(tz);

  useEffect(() => {
    if (!timer?.running) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [timer?.running]);

  const stats = computeLongTaskStats(task, todayDate, tz);
  const inWindow = isLongTaskInWindow(task, todayDate);
  const canStart = inWindow;
  const disabledReason = task.status === "ended"
    ? "任务已结束"
    : todayDate < task.startDate
      ? `${task.startDate} 开始`
      : todayDate > task.dueDate
        ? "已截止"
        : null;

  const elapsedMs = timer ? timer.accumulatedMs + (timer.running ? Date.now() - timer.startedAt : 0) : 0;
  const running = Boolean(timer?.running);

  async function onTerminate() {
    if (terminating) return;
    setTerminating(true);
    try {
      const session = await terminateLongTaskSession(task);
      if (session) setFinishedSession(session);
    } finally {
      setTerminating(false);
    }
  }

  return (
    <div
      className={`rounded-2xl border bg-white dark:bg-slate-800 p-4 shadow-card transition ${
        running
          ? "border-amber-400 ring-1 ring-amber-300 dark:ring-amber-700"
          : timer
            ? "border-gray-300 dark:border-slate-600"
            : "border-gray-100 dark:border-slate-700"
      }`}
    >
      <button
        type="button"
        className="block w-full text-left"
        onClick={() => openDrawer("longtask", task)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="rounded bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                长期
              </span>
              <span className={`rounded border px-1.5 py-0.5 text-xs ${PRIORITY_BADGE[task.priority]}`}>
                {PRIORITY_LABEL[task.priority]}
              </span>
            </div>
            <h3 className="mt-2 truncate font-semibold text-gray-900 dark:text-slate-100">{task.title || "（未命名）"}</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
              {task.startDate} → {task.dueDate} ·{" "}
              {task.status === "ended" ? "已结束" : stats.remainingDays < 0 ? "已截止" : stats.remainingDays === 0 ? "今天截止" : `剩余 ${stats.remainingDays} 天`}
            </p>
            <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">
              {stats.todayCount > 0 ? `今日 ${stats.todayCount} 次 · ${fmtDurationMs(stats.todayDurationMs)} ｜ ` : ""}
              累计 {stats.sessionCount} 次 · {fmtDurationMs(stats.totalDurationMs)}
            </p>
            {task.tags.length > 0 && (
              <div className="mt-1.5">
                <TagChips tags={task.tags} />
              </div>
            )}
          </div>
          {timer && (
            <div className="shrink-0 rounded-lg bg-gray-50 dark:bg-slate-700/50 px-3 py-1.5 text-right">
              <div className={`text-lg font-semibold tabular-nums ${running ? "text-amber-600 dark:text-amber-300" : "text-gray-500 dark:text-slate-400"}`}>
                {fmtClock(elapsedMs)}
              </div>
              <div className="text-xs text-gray-400 dark:text-slate-500">{running ? "进行中" : "已暂停"}</div>
            </div>
          )}
        </div>
      </button>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canStart}
          title={canStart ? "" : disabledReason ?? ""}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 ${
            running ? "bg-amber-500 hover:bg-amber-400" : "bg-accent-500 hover:bg-accent-400"
          }`}
          onClick={() => toggleLongTaskTimer(task)}
        >
          {running ? "暂停" : timer ? "继续" : "开始"}
        </button>
        {timer && (
          <button
            type="button"
            disabled={terminating}
            className="rounded-lg border border-red-200 dark:border-red-900 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
            onClick={() => void onTerminate()}
          >
            {terminating ? "记录中…" : "终止"}
          </button>
        )}
        <button
          type="button"
          className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
          onClick={() => openDrawer("longtask", task)}
        >
          详情
        </button>
      </div>

      {finishedSession && (
        <SessionSummaryDialog
          task={task}
          session={finishedSession}
          onClose={() => setFinishedSession(null)}
        />
      )}
    </div>
  );
}
