import { useMemo, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { InlineEdit } from "../components/InlineEdit";
import { TagFilterBar, TagChips, matchesTags } from "../components/TagFilter";
import { fmtDate, fmtTime } from "../lib/time";
import { PRIORITY_BADGE, PRIORITY_LABEL, statusLabel } from "../lib/format";
import type { Event } from "../types";

/** 事件列表页：列表 + 行内编辑 + 标签过滤 + 右侧抽屉。 */
export function EventsPage() {
  const data = useAppStore((s) => s.data);
  const openDrawer = useAppStore((s) => s.openDrawer);
  const saveEvent = useAppStore((s) => s.saveEvent);
  const [tagFilter, setTagFilter] = useState<string[]>([]);

  const tz = data?.config.timezone ?? "Asia/Shanghai";

  const events = useMemo(() => {
    const list = (data?.events ?? []).filter((e) => !e.deletedAt && matchesTags(e.tags, tagFilter));
    return list.sort((a, b) => a.start.localeCompare(b.start));
  }, [data, tagFilter]);

  function timeText(e: Event): string {
    if (e.allDay) return `全天 · ${e.start}`;
    const s = `${fmtDate(e.start, tz)} ${fmtTime(e.start, tz)}`;
    return e.end ? `${s} – ${fmtTime(e.end, tz)}` : s;
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-slate-100">事件</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">有时限的一次性事项</p>
        </div>
        <button
          type="button"
          className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-400"
          onClick={() => openDrawer("event", null)}
        >
          + 新建事件
        </button>
      </div>

      <TagFilterBar selected={tagFilter} onChange={setTagFilter} />

      <div className="flex flex-col gap-2">
        {events.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-8 text-center text-gray-400 dark:text-slate-500">
            暂无事件，点击右上角新建
          </div>
        )}
        {events.map((e) => {
          const muted = e.status !== "active";
          return (
            <div
              key={e.id}
              className={`flex items-center gap-3 rounded-xl border bg-white dark:bg-slate-800 px-4 py-3 shadow-sm ${
                muted ? "border-gray-100 dark:border-slate-700 opacity-60" : "border-gray-100 dark:border-slate-700"
              }`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full bg-accent-500" />
              <div className="min-w-0 flex-1">
                <InlineEdit
                  value={e.title}
                  onSave={(title) => saveEvent({ ...e, title })}
                  className="font-medium text-gray-900 dark:text-slate-100"
                />
                <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
                  <span>{timeText(e)}</span>
                  <TagChips tags={e.tags} />
                </div>
              </div>
              <span className={`rounded border px-1.5 py-0.5 text-xs ${PRIORITY_BADGE[e.priority]}`}>
                {PRIORITY_LABEL[e.priority]}
              </span>
              {muted && <span className="text-xs text-gray-400 dark:text-slate-500">{statusLabel(e.status)}</span>}
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-sm text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700 hover:text-gray-700"
                onClick={() => openDrawer("event", e)}
              >
                更多
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
