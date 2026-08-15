import { useMemo, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { InlineEdit } from "../components/InlineEdit";
import { TagFilterBar, TagChips, matchesTags } from "../components/TagFilter";
import { PRIORITY_BADGE, PRIORITY_LABEL, weekdayLabel } from "../lib/format";
import type { Routine } from "../types";

/** 日常列表页：时间窗口 + 行内编辑 + 标签过滤 + 启用开关 + 抽屉。 */
export function RoutinesPage() {
  const data = useAppStore((s) => s.data);
  const openDrawer = useAppStore((s) => s.openDrawer);
  const saveRoutine = useAppStore((s) => s.saveRoutine);
  const [tagFilter, setTagFilter] = useState<string[]>([]);

  const routines = useMemo(
    () => (data?.routines ?? []).filter((r) => !r.deletedAt && matchesTags(r.tags, tagFilter)),
    [data, tagFilter],
  );

  function windowText(r: Routine): string {
    if (!r.timeWindows.length) return "无时间窗口";
    return r.timeWindows
      .map((w) => `${weekdayLabel(w.daysOfWeek)} ${w.start}–${w.end}`)
      .join("；");
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-slate-100">日常</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">在某类时间段内完成的习惯事项</p>
        </div>
        <button
          type="button"
          className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-400"
          onClick={() => openDrawer("routine", null)}
        >
          + 新建日常
        </button>
      </div>

      <TagFilterBar selected={tagFilter} onChange={setTagFilter} />

      <div className="flex flex-col gap-2">
        {routines.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-8 text-center text-gray-400 dark:text-slate-500">
            暂无日常，点击右上角新建
          </div>
        )}
        {routines.map((r) => (
          <div
            key={r.id}
            className={`flex items-center gap-3 rounded-xl border bg-white dark:bg-slate-800 px-4 py-3 shadow-sm ${
              r.enabled ? "border-gray-100 dark:border-slate-700" : "border-gray-100 dark:border-slate-700 opacity-60"
            }`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
            <div className="min-w-0 flex-1">
              <InlineEdit
                value={r.title}
                onSave={(title) => saveRoutine({ ...r, title })}
                className="font-medium text-gray-900 dark:text-slate-100"
              />
              <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
                <span>{windowText(r)}</span>
                {r.durationMinutes != null && (
                  <span className="text-gray-400 dark:text-slate-500">约 {r.durationMinutes} 分钟</span>
                )}
                <TagChips tags={r.tags} />
              </div>
            </div>
            <span className={`rounded border px-1.5 py-0.5 text-xs ${PRIORITY_BADGE[r.priority]}`}>
              {PRIORITY_LABEL[r.priority]}
            </span>
            <label className="flex cursor-pointer items-center" title="启用/停用">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent-500"
                checked={r.enabled}
                onChange={(e) => saveRoutine({ ...r, enabled: e.target.checked })}
              />
            </label>
            <button
              type="button"
              className="rounded-lg px-2 py-1 text-sm text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700 hover:text-gray-700"
              onClick={() => openDrawer("routine", r)}
            >
              更多
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
