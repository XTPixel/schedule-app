import { useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import { useAppStore } from "../store/useAppStore";
import { CandidateCard } from "../components/CandidateCard";
import { LongTaskCard } from "../components/LongTaskCard";
import { parseNl } from "../api/ipc";
import { fmtTime, todayInTz } from "../lib/time";
import { isLongTaskInWindow } from "../lib/longTaskStats";
import { SOURCE_LABEL } from "../lib/format";

interface TimelineItem {
  kind: "event" | "routine" | "archive";
  time: string;
  title: string;
  sub?: string;
  done?: boolean;
}

function TimelineCard({ title, items, emptyText }: { title: string; items: TimelineItem[]; emptyText: string }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-3 text-sm font-semibold text-gray-400 dark:text-slate-500">{title}</h2>
      <div className="rounded-2xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-card">
        {items.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-400 dark:text-slate-500">{emptyText}</div>
        ) : (
          <ol className="relative space-y-3 border-l border-gray-100 dark:border-slate-700 pl-5">
            {items.map((item, i) => (
              <li key={i} className="relative">
                <span
                  className={`absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full ${
                    item.kind === "event"
                      ? "bg-accent-500"
                      : item.kind === "routine"
                        ? "bg-amber-400"
                        : "bg-emerald-500"
                  }`}
                />
                <div className="flex items-baseline gap-3">
                  <span className="w-12 shrink-0 text-sm font-medium tabular-nums text-gray-500 dark:text-slate-400">
                    {item.time}
                  </span>
                  <span className={`text-sm ${item.done ? "text-gray-400 dark:text-slate-500 line-through" : "text-gray-800 dark:text-slate-100"}`}>
                    {item.title}
                  </span>
                  {item.sub && <span className="text-xs text-gray-400 dark:text-slate-500">{item.sub}</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/** 「现在」页（§7.3①）：当前时间 + 主候选 + 次选 + 今日时间轴。 */
export function NowPage() {
  const candidates = useAppStore((s) => s.candidates);
  const hidden = useAppStore((s) => s.hiddenCandidates);
  const refresh = useAppStore((s) => s.refresh);
  const saveEvent = useAppStore((s) => s.saveEvent);
  const openDrawer = useAppStore((s) => s.openDrawer);
  const updateDraft = useAppStore((s) => s.updateDraft);
  const quickAddTick = useAppStore((s) => s.quickAddTick);
  const data = useAppStore((s) => s.data);
  const setPage = useAppStore((s) => s.setPage);

  const [clock, setClock] = useState(() => new Date());
  const quickRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (quickAddTick > 0) quickRef.current?.focus();
  }, [quickAddTick]);

  const tz = data?.config.timezone ?? "Asia/Shanghai";
  const todayDate = todayInTz(tz);

  // V1.2：长期任务独立区域（不进入候选、不受跳过/稍后隐藏）。
  const longTasks = useMemo(
    () => (data?.longTasks ?? []).filter((t) => isLongTaskInWindow(t, todayDate)),
    [data, todayDate],
  );

  // 每 60 秒被动刷新候选。
  useEffect(() => {
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const main = candidates?.main && !hidden.has(candidates.main.sourceId) ? candidates.main : null;
  const secondary = useMemo(
    () => (candidates?.secondary ?? []).filter((c) => !hidden.has(c.sourceId)),
    [candidates, hidden],
  );

  const timeline: TimelineItem[] = useMemo(() => {
    if (!candidates) return [];
    const items: TimelineItem[] = [];
    for (const ev of candidates.timeline.events) {
      items.push({
        kind: "event",
        time: ev.allDay ? "全天" : fmtTime(ev.start, tz),
        title: ev.title || "（未命名）",
        sub: ev.allDay ? undefined : ev.end ? `至 ${fmtTime(ev.end, tz)}` : undefined,
      });
    }
    for (const w of candidates.timeline.routineWindows) {
      items.push({
        kind: "routine",
        time: w.start,
        title: w.title || "（未命名）",
        sub: `至 ${w.end}`,
        done: w.doneToday,
      });
    }
    for (const a of candidates.timeline.archive) {
      items.push({
        kind: "archive",
        time: a.time,
        title: a.title,
        sub: SOURCE_LABEL[a.source],
        done: true,
      });
    }
    return items.sort((a, b) => (a.time === "全天" ? -1 : a.time.localeCompare(b.time)));
  }, [candidates, tz]);

  // v1.1.0：今日时间轴拆分为「按计划」（事件/日常窗口）与「实际」（已完成归档）。
  const plannedTimeline = useMemo(() => timeline.filter((i) => i.kind !== "archive"), [timeline]);
  const actualTimeline = useMemo(() => timeline.filter((i) => i.kind === "archive"), [timeline]);

  async function quickAdd(title: string) {
    const t = title.trim();
    if (!t) return;
    // 自然语言解析（§7.4 快速录入）。
    try {
      const parsed = await parseNl(t);
      if (parsed.matched) {
        await saveEvent({
          id: "",
          title: parsed.title || t,
          description: null,
          start: parsed.start,
          end: parsed.end,
          allDay: parsed.allDay,
          reminders: [],
          repeat: null,
          tags: [],
          priority: "normal",
          status: "active",
          createdAt: "",
          updatedAt: "",
          completedAt: null,
          deletedAt: null,
        });
        return;
      }
    } catch {
      // 解析失败继续走兜底。
    }
    // 兜底：打开表单，标题预填、时间高亮引导手动修正（§7.5）。
    openDrawer("event", null);
    updateDraft({ title: t } as never);
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* 快录框（托盘「快速新增」聚焦此处；回车后自然语言解析，失败降级表单） */}
      <input
        ref={quickRef}
        className="mb-5 w-full rounded-xl border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-4 py-2.5 text-sm shadow-sm outline-none placeholder:text-gray-400 focus:border-accent-400 focus:ring-2 focus:ring-accent-100"
        placeholder="快速新增：如「明天下午3点开会」（回车即存；识别失败则打开表单）"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void quickAdd((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).value = "";
          }
        }}
      />

      {/* 应用内提醒（§4.5：免打扰仅抑制系统通知，应用内依旧可见） */}
      {candidates && candidates.dueReminders.length > 0 && (
        <div className="mb-5 flex flex-col gap-2">
          {candidates.dueReminders.map((r, i) => (
            <div key={i} className="flex items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-200">
              <span className="text-xs">🔔</span>
              <span className="font-medium">{r.title}</span>
              <span>{r.body}</span>
              {!r.shouldNotify && <span className="ml-auto text-xs text-amber-500">仅应用内</span>}
            </div>
          ))}
        </div>
      )}

      {/* 当前时间（V3.1 T10：与候选引擎一致的 config.timezone 口径） */}
      <div className="mb-6">
        <div className="text-5xl font-bold tabular-nums tracking-tight text-gray-900 dark:text-slate-100">
          {dayjs(clock).tz(tz).format("HH:mm:ss")}
        </div>
        <div className="mt-1 text-sm text-gray-500 dark:text-slate-400">
          {dayjs(clock).tz(tz).locale("zh-cn").format("YYYY年M月D日 dddd")} · {tz}
        </div>
      </div>

      {/* 主候选 */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-gray-400 dark:text-slate-500">此刻最该做</h2>
        {main ? (
          <CandidateCard candidate={main} primary />
        ) : (
          <div className="rounded-2xl border border-dashed border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-8 text-center text-gray-400 dark:text-slate-500">
            当前没有待办候选，享受片刻空闲吧 ☕
          </div>
        )}
      </section>

      {/* V1.2：长期任务独立区域（主候选之后、次选之前）。 */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-gray-400 dark:text-slate-500">长期任务</h2>
        {longTasks.length === 0 ? (
          <div className="flex items-center justify-between rounded-2xl border border-dashed border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-5 text-gray-400 dark:text-slate-500">
            <span className="text-sm">暂无进行中的长期任务</span>
            <button
              type="button"
              className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1 text-xs text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
              onClick={() => setPage("longtasks")}
            >
              去创建
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {longTasks.map((t) => (
              <LongTaskCard key={t.id} task={t} />
            ))}
          </div>
        )}
      </section>

      {/* 次选 */}
      {secondary.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-semibold text-gray-400 dark:text-slate-500">还可以做</h2>
          <div className="flex flex-col gap-3">
            {secondary.map((c) => (
              <CandidateCard key={c.sourceId} candidate={c} />
            ))}
          </div>
        </section>
      )}

      {/* 今日时间轴（v1.1.0：按计划 / 实际 两个时间轴） */}
      <div className="grid gap-6 md:grid-cols-2">
        <TimelineCard title="按计划时间轴" items={plannedTimeline} emptyText="今天还没有计划安排" />
        <TimelineCard title="实际时间轴" items={actualTimeline} emptyText="今天还没有完成记录" />
      </div>
    </div>
  );
}
