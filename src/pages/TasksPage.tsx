import { useMemo, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { InlineEdit } from "../components/InlineEdit";
import { TagFilterBar, TagChips, matchesTags } from "../components/TagFilter";
import { fmtDate } from "../lib/time";
import { PRIORITY_BADGE, PRIORITY_LABEL, statusLabel } from "../lib/format";

/** 浮动事项列表页：行内编辑 + 标签过滤 + 拖拽排序（sortOrder 静默保存）+ 抽屉。 */
export function TasksPage() {
  const data = useAppStore((s) => s.data);
  const openDrawer = useAppStore((s) => s.openDrawer);
  const saveTask = useAppStore((s) => s.saveTask);
  const updateTaskOrder = useAppStore((s) => s.updateTaskOrder);
  const [dragId, setDragId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string[]>([]);

  const tz = data?.config.timezone ?? "Asia/Shanghai";

  const tasks = useMemo(() => {
    const list = (data?.tasks ?? []).filter((t) => !t.deletedAt && matchesTags(t.tags, tagFilter));
    return list.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  }, [data, tagFilter]);

  function move(index: number, delta: number) {
    const next = [...tasks];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void updateTaskOrder(next.map((t) => t.id));
  }

  function onDrop(index: number) {
    if (!dragId) return;
    const ids = tasks.map((t) => t.id);
    const from = ids.indexOf(dragId);
    if (from < 0) return;
    ids.splice(from, 1);
    ids.splice(index, 0, dragId);
    setDragId(null);
    void updateTaskOrder(ids);
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-slate-100">浮动事项</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">无固定时间、有空可做的事，可拖拽排序</p>
        </div>
        <button
          type="button"
          className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-400"
          onClick={() => openDrawer("task", null)}
        >
          + 新建浮动事项
        </button>
      </div>

      <TagFilterBar selected={tagFilter} onChange={setTagFilter} />

      <div className="flex flex-col gap-2">
        {tasks.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-8 text-center text-gray-400 dark:text-slate-500">
            暂无浮动事项，点击右上角新建
          </div>
        )}
        {tasks.map((t, i) => {
          const muted = t.status !== "active";
          return (
            <div
              key={t.id}
              draggable
              onDragStart={() => setDragId(t.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(i)}
              className={`flex cursor-grab items-center gap-2 rounded-xl border bg-white dark:bg-slate-800 px-3 py-3 shadow-sm active:cursor-grabbing ${
                muted ? "border-gray-100 dark:border-slate-700 opacity-60" : "border-gray-100 dark:border-slate-700"
              } ${dragId === t.id ? "ring-2 ring-accent-200" : ""}`}
            >
              <div className="flex flex-col">
                <button
                  type="button"
                  className="px-1 text-xs text-gray-300 dark:text-slate-600 hover:text-gray-600"
                  onClick={() => move(i, -1)}
                  title="上移"
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="px-1 text-xs text-gray-300 dark:text-slate-600 hover:text-gray-600"
                  onClick={() => move(i, 1)}
                  title="下移"
                >
                  ▼
                </button>
              </div>
              <span className="text-xs text-gray-300 dark:text-slate-600">≡</span>
              <div className="min-w-0 flex-1">
                <InlineEdit
                  value={t.title}
                  onSave={(title) => saveTask({ ...t, title })}
                  className="font-medium text-gray-900 dark:text-slate-100"
                />
                <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
                  {t.deadline && <span>截止 {fmtDate(t.deadline, tz)}</span>}
                  <TagChips tags={t.tags} />
                </div>
              </div>
              <span className={`rounded border px-1.5 py-0.5 text-xs ${PRIORITY_BADGE[t.priority]}`}>
                {PRIORITY_LABEL[t.priority]}
              </span>
              {muted && <span className="text-xs text-gray-400 dark:text-slate-500">{statusLabel(t.status)}</span>}
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-sm text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700 hover:text-gray-700"
                onClick={() => openDrawer("task", t)}
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
