import { useEffect, useState } from "react";
import dayjs from "dayjs";
import { useAppStore } from "../store/useAppStore";
import { fmtDate, fmtTime } from "../lib/time";
import { PRIORITY_BADGE, PRIORITY_LABEL } from "../lib/format";
import { TagChips } from "../components/TagFilter";
import { tagChipClasses } from "../lib/tagColor";
import type { SearchQuery } from "../types";

function fmtDurationLong(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 搜索页：标题 / 标签 / 日期范围组合筛选（Phase 1）。 */
export function SearchPage() {
  const data = useAppStore((s) => s.data);
  const results = useAppStore((s) => s.searchResults);
  const doSearch = useAppStore((s) => s.doSearch);
  const clearSearch = useAppStore((s) => s.clearSearch);
  const tags = useAppStore((s) => s.tags);
  const loadTags = useAppStore((s) => s.loadTags);
  const openDrawer = useAppStore((s) => s.openDrawer);

  const tz = data?.config.timezone ?? "Asia/Shanghai";
  const [text, setText] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    void loadTags();
    return () => clearSearch();
  }, [loadTags, clearSearch]);

  function run() {
    const q: SearchQuery = {
      text,
      tags: selectedTags,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
    };
    void doSearch(q);
  }

  function toggleTag(t: string) {
    setSelectedTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  const ev = results?.events ?? [];
  const tasks = results?.tasks ?? [];
  const routines = results?.routines ?? [];
  const longTasks = results?.longTasks ?? [];
  const query = text.trim().toLowerCase();

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-4 text-xl font-bold text-gray-900 dark:text-slate-100">搜索</h1>

      {/* 筛选区 */}
      <div className="mb-4 rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-sm">
        <input
          className="mb-3 w-full rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-800 dark:text-slate-100 outline-none placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:border-accent-400"
          placeholder="标题关键词（回车搜索）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        {tags.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <button
                key={t.tag}
                type="button"
                onClick={() => toggleTag(t.tag)}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  selectedTags.includes(t.tag)
                    ? `${tagChipClasses(t.color)} font-medium`
                    : "border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
                }`}
              >
                #{t.tag} ({t.count})
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="date"
            className="rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-gray-800 dark:text-slate-100"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <span className="text-gray-400 dark:text-slate-500">至</span>
          <input
            type="date"
            className="rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-gray-800 dark:text-slate-100"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
          <button type="button" className="rounded-lg bg-accent-500 px-4 py-1.5 text-sm text-white hover:bg-accent-400" onClick={run}>
            搜索
          </button>
          <button
            type="button"
            className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
            onClick={() => {
              setText("");
              setSelectedTags([]);
              setDateFrom("");
              setDateTo("");
              clearSearch();
            }}
          >
            重置
          </button>
        </div>
      </div>

      {/* 结果 */}
      {results && (
        <div className="flex flex-col gap-6">
          <ResultSection
            title="事件"
            count={ev.length}
            empty="无匹配事件"
            items={ev.map((e) => ({
              id: e.id,
              title: e.title,
              sub: e.allDay ? `全天 · ${e.start}` : `${fmtDate(e.start, tz)} ${fmtTime(e.start, tz)}`,
              priority: e.priority,
              tags: e.tags,
              onClick: () => openDrawer("event", e),
            }))}
          />
          <ResultSection
            title="浮动事项"
            count={tasks.length}
            empty="无匹配浮动事项"
            items={tasks.map((t) => ({
              id: t.id,
              title: t.title,
              sub: t.deadline ? `截止 ${fmtDate(t.deadline, tz)}` : undefined,
              priority: t.priority,
              tags: t.tags,
              onClick: () => openDrawer("task", t),
            }))}
          />
          <ResultSection
            title="日常"
            count={routines.length}
            empty="无匹配日常"
            items={routines.map((r) => ({
              id: r.id,
              title: r.title,
              sub: r.timeWindows.length ? `${r.timeWindows.length} 个时间窗口` : undefined,
              priority: r.priority,
              tags: r.tags,
              onClick: () => openDrawer("routine", r),
            }))}
          />
          <ResultSection
            title="长期任务"
            count={longTasks.length}
            empty="无匹配长期任务"
            items={longTasks.map((t) => {
              const allMatched = t.sessions.filter(
                (s) => s.deletedAt == null && query && (s.note ?? "").toLowerCase().includes(query),
              );
              const shown = allMatched.slice(0, 3).map((s) => {
                const started = dayjs(s.startedAt);
                return `${started.format("M月D日 HH:mm")} · ${fmtDurationLong(s.durationMs)} · ${s.note ?? ""}`;
              });
              const extraLines =
                allMatched.length > 3 ? [...shown, `共 ${allMatched.length} 条命中收获`] : shown;
              return {
                id: t.id,
                title: t.title,
                sub: `${t.startDate} → ${t.dueDate}`,
                priority: t.priority,
                tags: t.tags,
                extraLines,
                onClick: () => openDrawer("longtask", t),
              };
            })}
          />
        </div>
      )}

      {!results && (
        <div className="rounded-xl border border-dashed border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-10 text-center text-gray-400 dark:text-slate-500">
          输入关键词或选择标签/日期范围后点击「搜索」
        </div>
      )}
    </div>
  );
}

interface Item {
  id: string;
  title: string;
  sub?: string;
  priority: "high" | "normal" | "low";
  tags: string[];
  /** V1.2：命中会话收获时展示的会话片段。 */
  extraLines?: string[];
  onClick: () => void;
}

function ResultSection({
  title,
  count,
  empty,
  items,
}: {
  title: string;
  count: number;
  empty: string;
  items: Item[];
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-gray-400 dark:text-slate-500">
        {title} · {count}
      </h2>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-6 text-center text-sm text-gray-400 dark:text-slate-500">{empty}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={it.onClick}
              className="flex items-center gap-3 rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3 text-left shadow-sm hover:bg-gray-50 dark:hover:bg-slate-700"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-gray-900 dark:text-slate-100">{it.title || "（未命名）"}</div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
                  {it.sub && <span>{it.sub}</span>}
                  <TagChips tags={it.tags} />
                </div>
                {it.extraLines && it.extraLines.length > 0 && (
                  <div className="mt-1.5 space-y-0.5 border-t border-dashed border-gray-100 dark:border-slate-700 pt-1.5">
                    {it.extraLines.map((line, i) => (
                      <div key={i} className="truncate text-xs text-amber-700 dark:text-amber-300">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <span className={`rounded border px-1.5 py-0.5 text-xs ${PRIORITY_BADGE[it.priority]}`}>
                {PRIORITY_LABEL[it.priority]}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
