import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { useAppStore } from "../store/useAppStore";
import { fmtTime, todayInTz } from "../lib/time";
import { TagFilterBar, matchesTags } from "../components/TagFilter";
import { firstColoredTag, tagChipClasses } from "../lib/tagColor";
import type { Occurrence } from "../types";

function loadFilter<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveFilter(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

type ViewMode = "month" | "week" | "day";

const VIEW_LABEL: Record<ViewMode, string> = { month: "月", week: "周", day: "日" };
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function addDays(d: string, n: number) {
  return dayjs(d).add(n, "day").format("YYYY-MM-DD");
}
function weekStart(d: string) {
  const j = dayjs(d);
  const dow = (j.day() + 6) % 7; // 周一=0
  return j.subtract(dow, "day").format("YYYY-MM-DD");
}

/** 日历页（§7.3②）：月/周/日切换，事件（含重复实例）与日常窗口叠加。 */
export function CalendarPage() {
  const data = useAppStore((s) => s.data);
  const calendar = useAppStore((s) => s.calendar);
  const loadCalendar = useAppStore((s) => s.loadCalendar);
  const openDrawer = useAppStore((s) => s.openDrawer);
  const tagColors = useAppStore((s) => s.data?.config.tagColors ?? {});

  const tz = data?.config.timezone ?? "Asia/Shanghai";
  const [view, setView] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState(() => todayInTz(tz));
  // V3.0 F3：日历显示内容与标签筛选（localStorage 持久化）。
  const [showEvents, setShowEvents] = useState(() => loadFilter("schedule.cal.showEvents", true));
  const [showRoutines, setShowRoutines] = useState(() => loadFilter("schedule.cal.showRoutines", true));
  const [filterTags, setFilterTags] = useState<string[]>(() => loadFilter("schedule.cal.tags", []));

  // 可视区间。
  const range = useMemo(() => {
    if (view === "day") return { start: anchor, end: anchor };
    if (view === "week") {
      const s = weekStart(anchor);
      return { start: s, end: addDays(s, 6) };
    }
    const m = dayjs(anchor);
    const s = m.startOf("month").format("YYYY-MM-DD");
    const e = m.endOf("month").format("YYYY-MM-DD");
    return { start: s, end: e };
  }, [view, anchor]);

  useEffect(() => {
    void loadCalendar(range.start, range.end);
    // V1.2.2：日常数据变化（如新增/修改「每隔 N 天」窗口）时重载日历，避免仍显示旧命中结果。
  }, [range.start, range.end, loadCalendar, data?.routines]);

  const byDate = useMemo(() => {
    const map = new Map<string, { occurrences: Occurrence[]; routines: { title: string; time: string; tags: string[] }[] }>();
    for (const o of calendar?.occurrences ?? []) {
      if (!showEvents) continue;
      if (!matchesTags(o.event.tags, filterTags)) continue;
      const cell = map.get(o.localDate) ?? { occurrences: [], routines: [] };
      cell.occurrences.push(o);
      map.set(o.localDate, cell);
    }
    for (const w of calendar?.routineWindows ?? []) {
      if (!showRoutines) continue;
      if (!matchesTags(w.tags, filterTags)) continue;
      const cell = map.get(w.date) ?? { occurrences: [], routines: [] };
      cell.routines.push({ title: w.title, time: `${w.start}–${w.end}`, tags: w.tags });
      map.set(w.date, cell);
    }
    return map;
  }, [calendar, showEvents, showRoutines, filterTags]);

  function shift(dir: -1 | 1) {
    if (view === "day") setAnchor(addDays(anchor, dir));
    else if (view === "week") setAnchor(addDays(anchor, dir * 7));
    else setAnchor(dayjs(anchor).add(dir, "month").format("YYYY-MM-DD"));
  }

  function title() {
    if (view === "day") return dayjs(anchor).format("YYYY年M月D日 dddd");
    if (view === "week") {
      const s = range.start;
      return `${dayjs(s).format("M月D日")} – ${dayjs(range.end).format("M月D日")}`;
    }
    return dayjs(anchor).format("YYYY年M月");
  }

  const monthCells = useMemo(() => {
    if (view !== "month") return [] as string[];
    const first = dayjs(range.start);
    const startDow = (first.day() + 6) % 7;
    const gridStart = first.subtract(startDow, "day");
    return Array.from({ length: 42 }, (_, i) => gridStart.add(i, "day").format("YYYY-MM-DD"));
  }, [view, range.start]);

  const weekCells = useMemo(() => {
    if (view !== "week") return [] as string[];
    return Array.from({ length: 7 }, (_, i) => addDays(range.start, i));
  }, [view, range.start]);

  function renderOccurrence(o: Occurrence) {
    const ev = o.event;
    // 重复实例点击时打开序列本身（避免实例时刻覆盖序列锚点导致漂移）。
    const series = o.seriesId ? data?.events.find((x) => x.id === o.seriesId) : undefined;
    const target = series ?? ev;
    const time = ev.allDay ? "全天" : fmtTime(ev.start, tz);
    // V3.1 U4：按「第一个有色标签」着色；无有色标签维持 accent 默认样式。
    const color = firstColoredTag(ev.tags, tagColors);
    return (
      <button
        key={o.key}
        type="button"
        title={ev.title}
        onClick={() => openDrawer("event", target)}
        className={`block w-full truncate rounded px-1 py-0.5 text-left text-[11px] leading-4 hover:brightness-95 ${
          color
            ? `border ${tagChipClasses(color)}`
            : "bg-accent-100 dark:bg-accent-900/50 text-accent-800 dark:text-accent-200 hover:bg-accent-200"
        }`}
      >
        {time} {ev.title || "（未命名）"}
      </button>
    );
  }

  function renderRoutine(r: { title: string; time: string; tags: string[] }, i: number) {
    const color = firstColoredTag(r.tags, tagColors);
    return (
      <div
        key={`r${i}`}
        className={`truncate rounded px-1 py-0.5 text-left text-[11px] leading-4 ${
          color
            ? `border ${tagChipClasses(color)}`
            : "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
        }`}
        title={`${r.title} ${r.time}`}
      >
        {r.time} {r.title}
      </div>
    );
  }

  function Cell({ date, compact }: { date: string; compact?: boolean }) {
    const cell = byDate.get(date);
    const isToday = date === todayInTz(tz);
    const inMonth = view !== "month" || dayjs(date).format("YYYY-MM") === dayjs(anchor).format("YYYY-MM");
    return (
      <div
        className={`min-h-0 border-b border-r border-gray-100 dark:border-slate-700 p-1 ${compact ? "" : "min-h-[96px]"} ${
          inMonth ? "bg-white dark:bg-slate-800" : "bg-gray-50/60 dark:bg-slate-800/40"
        }`}
      >
        <div
          className={`mb-1 flex items-center justify-between px-0.5 text-xs ${
            isToday ? "font-bold text-accent-600 dark:text-accent-300" : "text-gray-500 dark:text-slate-400"
          }`}
        >
          <span className={isToday ? "flex h-5 w-5 items-center justify-center rounded-full bg-accent-500 text-white" : ""}>
            {dayjs(date).format("D")}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 overflow-hidden">
          {cell?.occurrences.map(renderOccurrence)}
          {cell?.routines.map(renderRoutine)}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col px-6 py-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-slate-100">日历</h1>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-0.5">
            {(["month", "week", "day"] as ViewMode[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded-md px-3 py-1 text-sm ${
                  view === v ? "bg-accent-500 text-white" : "text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
                }`}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* V3.0 F3：显示内容与标签筛选条 */}
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={showEvents}
            onChange={(e) => {
              setShowEvents(e.target.checked);
              saveFilter("schedule.cal.showEvents", e.target.checked);
            }}
          />
          事件
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={showRoutines}
            onChange={(e) => {
              setShowRoutines(e.target.checked);
              saveFilter("schedule.cal.showRoutines", e.target.checked);
            }}
          />
          日常
        </label>
      </div>
      <TagFilterBar
        selected={filterTags}
        onChange={(s) => {
          setFilterTags(s);
          saveFilter("schedule.cal.tags", s);
        }}
      />

      <div className="mb-4 flex items-center justify-center gap-3">
        <button type="button" className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700" onClick={() => shift(-1)}>
          ←
        </button>
        <button type="button" className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700" onClick={() => setAnchor(todayInTz(tz))}>
          今天
        </button>
        <button type="button" className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700" onClick={() => shift(1)}>
          →
        </button>
        <span className="min-w-40 text-center text-base font-semibold text-gray-800 dark:text-slate-100">{title()}</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm">
        {/* 表头 */}
        <div className="grid grid-cols-7 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/50 text-center text-xs text-gray-500 dark:text-slate-400">
          {WEEKDAYS.map((d) => (
            <div key={d} className="py-1.5">
              周{d}
            </div>
          ))}
        </div>

        {view === "month" && (
          <div className="grid grid-cols-7">
            {monthCells.map((d) => (
              <Cell key={d} date={d} />
            ))}
          </div>
        )}

        {view === "week" && (
          <div className="grid grid-cols-7">
            {weekCells.map((d) => (
              <div key={d} className="min-h-[320px]">
                <Cell date={d} />
              </div>
            ))}
          </div>
        )}

        {view === "day" && (
          <div className="p-3">
            <div className="mb-2 text-sm font-semibold text-gray-700 dark:text-slate-200">{dayjs(anchor).format("M月D日 dddd")}</div>
            <div className="flex flex-col gap-1">
              {(byDate.get(anchor)?.occurrences ?? [])
                .slice()
                .sort((a, b) => (a.event.allDay ? -1 : 0) || a.event.start.localeCompare(b.event.start))
                .map(renderOccurrence)}
              {(byDate.get(anchor)?.routines ?? []).map(renderRoutine)}
              {!(byDate.get(anchor)?.occurrences ?? []).length && !(byDate.get(anchor)?.routines ?? []).length && (
                <div className="py-10 text-center text-sm text-gray-400 dark:text-slate-500">当天没有安排</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
