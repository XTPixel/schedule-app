import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { todayInTz } from "../lib/time";
import { InlineEdit } from "../components/InlineEdit";
import { TagChips } from "../components/TagFilter";
import { SessionSummaryDialog } from "../components/SessionSummaryDialog";
import { computeLongTaskStats, fmtClock, fmtDurationMs, isLongTaskInWindow } from "../lib/longTaskStats";
import type { LongTask, LongTaskSession } from "../types";

/** V1.2：长期任务页——进行中 / 未开始 / 已结束三组列表。 */
export function LongTasksPage() {
  const data = useAppStore((s) => s.data);
  const openDrawer = useAppStore((s) => s.openDrawer);
  const tz = data?.config.timezone ?? "Asia/Shanghai";
  const today = todayInTz(tz);

  const groups = useMemo(() => {
    const all = (data?.longTasks ?? []).filter((t) => t.deletedAt == null);
    return {
      active: all
        // V1.2.1 F2：进行中必须 status === active，手动结束的任务只出现在「已结束」组。
        .filter((t) => t.status === "active" && isLongTaskInWindow(t, today))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
      upcoming: all
        .filter((t) => t.status === "active" && today < t.startDate)
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
      ended: all
        .filter((t) => t.status === "ended" || today > t.dueDate)
        .sort((a, b) => b.dueDate.localeCompare(a.dueDate)),
    };
  }, [data, today]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-slate-100">长期任务</h1>
        <button
          type="button"
          className="rounded-lg bg-accent-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-400"
          onClick={() => openDrawer("longtask", null)}
        >
          新建长期任务
        </button>
      </div>

      <LongTaskGroup title="进行中" empty="暂无进行中的长期任务" items={groups.active} />
      <LongTaskGroup title="未开始" empty="暂无未开始的长期任务" items={groups.upcoming} />
      <LongTaskGroup title="已结束" empty="暂无已结束的长期任务" items={groups.ended} />

      <p className="mt-4 text-xs text-gray-400 dark:text-slate-500">
        提示：在「现在」页同样可以快速开始 / 暂停 / 终止长期任务。
      </p>
    </div>
  );
}

function LongTaskGroup({ title, empty, items }: { title: string; empty: string; items: LongTask[] }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-gray-400 dark:text-slate-500">{title} · {items.length}</h2>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-6 text-center text-sm text-gray-400 dark:text-slate-500">
          {empty}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((t) => (
            <LongTaskRow key={t.id} task={t} />
          ))}
        </div>
      )}
    </section>
  );
}

/** 两个 YYYY-MM-DD 的天数差（b - a）。 */
function dateDiffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}

function DateCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {  const [v, setV] = useState(value);
  return (
    <input
      type="date"
      className="rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-1.5 py-0.5 text-xs text-gray-700 dark:text-slate-200"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v && v !== value) onSave(v);
      }}
    />
  );
}

function LongTaskRow({ task }: { task: LongTask }) {
  const tz = useAppStore((s) => s.data?.config.timezone ?? "Asia/Shanghai");
  const today = todayInTz(tz);
  const saveLongTask = useAppStore((s) => s.saveLongTask);
  const deleteLongTask = useAppStore((s) => s.deleteLongTask);
  const openDrawer = useAppStore((s) => s.openDrawer);
  const askConfirm = useAppStore((s) => s.askConfirm);
  const timer = useAppStore((s) => s.timers[task.id]);
  const toggleLongTaskTimer = useAppStore((s) => s.toggleLongTaskTimer);
  const terminateLongTaskSession = useAppStore((s) => s.terminateLongTaskSession);
  const [terminating, setTerminating] = useState(false);
  const [session, setSession] = useState<LongTaskSession | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!timer?.running) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [timer?.running]);

  const stats = computeLongTaskStats(task, today, tz);
  const inWindow = isLongTaskInWindow(task, today);
  const ended = task.status === "ended" || today > task.dueDate;
  const startDisabledReason = !inWindow
    ? task.status === "ended"
      ? "任务已结束"
      : today < task.startDate
        ? `${task.startDate} 开始`
        : "已截止"
    : "";
  const elapsedMs = timer ? timer.accumulatedMs + (timer.running ? Date.now() - timer.startedAt : 0) : 0;

  async function onTerminate() {
    if (terminating) return;
    setTerminating(true);
    try {
      const s = await terminateLongTaskSession(task);
      if (s) setSession(s);
    } finally {
      setTerminating(false);
    }
  }

  return (
    <div className={`rounded-xl border bg-white dark:bg-slate-800 px-4 py-3 shadow-sm ${ended ? "opacity-70" : ""} ${timer?.running ? "border-amber-400" : "border-gray-100 dark:border-slate-700"}`}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <InlineEdit
            value={task.title}
            placeholder="点击填写标题"
            className="text-sm font-semibold text-gray-900 dark:text-slate-100"
            textClassName="text-sm font-semibold text-gray-900 dark:text-slate-100"
            onSave={(v) => void saveLongTask({ ...task, title: v })}
          />
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
            <DateCell value={task.startDate} onSave={(v) => void saveLongTask({ ...task, startDate: v })} />
            <span>→</span>
            <DateCell value={task.dueDate} onSave={(v) => void saveLongTask({ ...task, dueDate: v })} />
            {ended ? (
              <span className="rounded bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 text-gray-500 dark:text-slate-400">
                {task.status === "ended" ? "已结束" : "已截止"}
              </span>
            ) : today < task.startDate ? (
              <span className="rounded bg-sky-50 dark:bg-sky-900/30 px-1.5 py-0.5 text-sky-700 dark:text-sky-300">
                {dateDiffDays(today, task.startDate)} 天后开始
              </span>
            ) : stats.remainingDays <= 7 ? (
              <span className="rounded bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                剩余 {stats.remainingDays === 0 ? "今天截止" : `${stats.remainingDays} 天`}
              </span>
            ) : null}
            <TagChips tags={task.tags} />
            <span>
              {stats.todayCount > 0 ? `今日 ${stats.todayCount} 次 · ${fmtDurationMs(stats.todayDurationMs)} ｜ ` : ""}
              累计 {stats.sessionCount} 次 · {fmtDurationMs(stats.totalDurationMs)}
            </span>
            {timer && (
              <span className={`tabular-nums ${timer.running ? "text-amber-600 dark:text-amber-300" : "text-gray-400"}`}>
                {timer.running ? "进行中" : "已暂停"} {fmtClock(elapsedMs)}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={!inWindow}
            title={inWindow ? "" : startDisabledReason}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 ${timer?.running ? "bg-amber-500 hover:bg-amber-400" : "bg-accent-500 hover:bg-accent-400"}`}
            onClick={() => toggleLongTaskTimer(task)}
          >
            {timer?.running ? "暂停" : timer ? "继续" : "开始"}
          </button>
          {timer && (
            <button
              type="button"
              disabled={terminating}
              className="rounded-lg border border-red-200 dark:border-red-900 px-2.5 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
              onClick={() => void onTerminate()}
            >
              {terminating ? "…" : "终止"}
            </button>
          )}
          <button
            type="button"
            className="rounded-lg border border-gray-200 dark:border-slate-600 px-2.5 py-1 text-xs text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
            onClick={() => openDrawer("longtask", task)}
          >
            详情
          </button>
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-xs text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
            onClick={() =>
              askConfirm("删除长期任务", `确定删除「${task.title || "长期任务"}」吗？此操作可撤回。`, () => {
                void deleteLongTask(task.id);
              })
            }
          >
            删除
          </button>
        </div>
      </div>
      {session && <SessionSummaryDialog task={task} session={session} onClose={() => setSession(null)} />}
    </div>
  );
}
