import { useEffect, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { InlineEdit } from "../components/InlineEdit";
import { TimeField } from "../components/TimeField";
import { todayInTz } from "../lib/time";
import { SOURCE_LABEL } from "../lib/format";
import { getArchiveMonth, undeleteLongTaskArchiveDay } from "../api/ipc";
import type { ArchiveDay, ArchiveFile, ArchiveEntry } from "../types";

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtDuration(min: number): string {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

const SOURCE_DOT: Record<string, string> = {
  event: "bg-accent-500",
  routine: "bg-amber-400",
  task: "bg-sky-400",
  longtask: "bg-amber-500",
  manual: "bg-emerald-500",
};

/** 归档页（§7.3④）：按天查看流水 + 手动补记 + 编辑/删除。 */
export function ArchivePage() {
  const data = useAppStore((s) => s.data);
  const addManualArchive = useAppStore((s) => s.addManualArchive);
  const updateArchiveDay = useAppStore((s) => s.updateArchiveDay);
  const removeArchiveEntry = useAppStore((s) => s.removeArchiveEntry);
  const refreshStatsIfLoaded = useAppStore((s) => s.refreshStatsIfLoaded);
  const refresh = useAppStore((s) => s.refresh);
  const askConfirm = useAppStore((s) => s.askConfirm);
  const pushToast = useAppStore((s) => s.pushToast);
  const openDrawer = useAppStore((s) => s.openDrawer);

  const tz = data?.config.timezone ?? "Asia/Shanghai";
  const [viewDate, setViewDate] = useState(() => todayInTz(tz));
  const [archive, setArchive] = useState<ArchiveFile | null>(data?.archive ?? null);
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("12:00");
  const [note, setNote] = useState("");

  useEffect(() => {
    setViewDate(todayInTz(tz));
  }, [tz]);

  useEffect(() => {
    const month = viewDate.slice(0, 7);
    if (archive && archive.month === month) return;
    getArchiveMonth(month).then(setArchive).catch(() => setArchive(null));
  }, [viewDate, archive]);

  const day: ArchiveDay | undefined = archive?.days[viewDate];
  const entries = day?.entries ?? [];

  function saveDay(next: ArchiveDay) {
    void updateArchiveDay(viewDate, next);
    setArchive((prev) =>
      prev ? { ...prev, days: { ...prev.days, [viewDate]: next } } : prev,
    );
  }

  function saveEntry(entry: ArchiveEntry) {
    const next: ArchiveDay = {
      entries: entries.map((x) => (x.id === entry.id ? entry : x)),
      summary: day?.summary ?? null,
      updatedAt: new Date().toISOString(),
    };
    saveDay(next);
  }

  async function reloadMonth() {
    const month = viewDate.slice(0, 7);
    setArchive(await getArchiveMonth(month));
  }

  function onRemove(e: ArchiveEntry) {
    const isLongTask = e.source === "longtask";
    const message = isLongTask
      ? `删除「${e.title || "该记录"}」将同时移除当天对应的长期任务投入记录，确定？`
      : `删除「${e.title || "该记录"}」？`;
    askConfirm("删除记录", message, () => {
      void (async () => {
        try {
          const result = await removeArchiveEntry(viewDate, e);
          if (result.status === "cancelled") {
            // 外部修改冲突选择「重新加载」时，放弃本地删除。
            await reloadMonth();
            return;
          }
          await reloadMonth();
          const restore = async () => {
            if (isLongTask && e.sourceId && result.sessionIds.length > 0) {
              await undeleteLongTaskArchiveDay(e.sourceId, viewDate, result.sessionIds);
              await refresh();
            } else if (!isLongTask) {
              // BUG-09：撤回时读取最新月份数据，仅追加目标记录，不复活其它已删记录。
              const month = viewDate.slice(0, 7);
              const af = await getArchiveMonth(month);
              const latestDay = af.days[viewDate] ?? {
                entries: [],
                summary: null,
                updatedAt: new Date().toISOString(),
              };
              if (!latestDay.entries.some((x) => x.id === e.id)) {
                await updateArchiveDay(viewDate, {
                  ...latestDay,
                  entries: [...latestDay.entries, e].sort((a, b) => a.time.localeCompare(b.time)),
                  updatedAt: new Date().toISOString(),
                });
              }
            }
            await reloadMonth();
            await refreshStatsIfLoaded();
          };
          pushToast("已删除记录", "撤回", () => void restore());
        } catch (err) {
          pushToast(`删除记录失败：${String(err)}`);
        }
      })();
    });
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-slate-100">归档</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">每天实际做过的事</p>
        </div>
      </div>

      {/* 日期导航 */}
      <div className="mb-4 flex items-center justify-center gap-3">
        <button
          type="button"
          className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
          onClick={() => setViewDate(addDays(viewDate, -1))}
        >
          ← 前一天
        </button>
        <input
          type="date"
          className="rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm text-gray-800 dark:text-slate-100 outline-none focus:border-accent-400"
          value={viewDate}
          onChange={(e) => e.target.value && setViewDate(e.target.value)}
        />
        <button
          type="button"
          className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
          onClick={() => setViewDate(addDays(viewDate, 1))}
        >
          后一天 →
        </button>
      </div>

      {/* 手动补记 */}
      <div className="mb-4 rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-sm">
        <div className="mb-2 text-xs font-medium text-gray-500 dark:text-slate-400">添加计划外记录</div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="min-w-40 flex-1 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm text-gray-800 dark:text-slate-100 outline-none placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:border-accent-400"
            placeholder="标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <TimeField value={time} onChange={setTime} compact />
          <input
            className="flex-1 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm text-gray-800 dark:text-slate-100 outline-none placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:border-accent-400"
            placeholder="备注（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
            onClick={async () => {
              if (!title.trim()) return;
              try {
                await addManualArchive(title.trim(), time, note.trim(), viewDate);
                setTitle("");
                setNote("");
                await reloadMonth();
              } catch (e) {
                pushToast(`添加记录失败：${String(e)}`);
              }
            }}
          >
            添加
          </button>
        </div>
      </div>

      {/* 当日流水 */}
      <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-card">
        {entries.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-400 dark:text-slate-500">这一天还没有记录</div>
        ) : (
          <ol className="flex flex-col gap-2">
            {entries.map((e) => {
              const isLongTask = e.source === "longtask";
              const longTask = isLongTask
                ? data?.longTasks.find((x) => x.id === e.sourceId && x.deletedAt == null)
                : undefined;
              return (
                <li
                  key={e.id}
                  className={`group flex items-start gap-3 rounded-xl border px-3 py-2.5 transition ${
                    isLongTask && longTask
                      ? "cursor-pointer border-gray-100 dark:border-slate-700 hover:border-accent-200 dark:hover:border-accent-800 hover:bg-gray-50 dark:hover:bg-slate-700/50"
                      : "border-transparent hover:bg-gray-50 dark:hover:bg-slate-700/50"
                  }`}
                  onClick={() => {
                    if (isLongTask && longTask) openDrawer("longtask", longTask);
                  }}
                >
                  <div className="flex h-11 w-16 shrink-0 flex-col items-center justify-center rounded-lg bg-gray-100 dark:bg-slate-700/60">
                    <span className="text-sm font-semibold tabular-nums text-gray-800 dark:text-slate-100">{e.time}</span>
                  </div>
                  <span className={`mt-3 h-2 w-2 shrink-0 rounded-full ${SOURCE_DOT[e.source] ?? "bg-gray-400"}`} />
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {isLongTask ? (
                        <span className="truncate text-sm font-medium text-gray-900 dark:text-slate-100">{e.title}</span>
                      ) : (
                        <InlineEdit
                          value={e.title}
                          onSave={(title) => saveEntry({ ...e, title })}
                          className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 dark:text-slate-100"
                          textClassName="text-sm font-medium text-gray-900 dark:text-slate-100"
                        />
                      )}
                      <span className="rounded bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-slate-400">
                        {SOURCE_LABEL[e.source]}
                      </span>
                      {e.durationMinutes != null && (
                        <span className="text-[11px] tabular-nums text-gray-400 dark:text-slate-500">
                          耗时 {fmtDuration(e.durationMinutes)}
                        </span>
                      )}
                    </div>
                    {e.note && (
                      <p className="mt-1 whitespace-pre-line text-xs leading-5 text-gray-500 dark:text-slate-400">{e.note}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    title="删除记录"
                    className="mt-0.5 rounded-md px-1.5 py-1 text-xs text-gray-400 dark:text-slate-500 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onRemove(e);
                    }}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
