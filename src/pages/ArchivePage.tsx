import { useEffect, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { InlineEdit } from "../components/InlineEdit";
import { TimeField } from "../components/TimeField";
import { todayInTz } from "../lib/time";
import { SOURCE_LABEL } from "../lib/format";
import { getArchiveMonth } from "../api/ipc";
import type { ArchiveDay, ArchiveFile, ArchiveEntry } from "../types";

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 归档页（§7.3④）：按天查看流水 + 手动补记 + 编辑/删除。 */
export function ArchivePage() {
  const data = useAppStore((s) => s.data);
  const addManualArchive = useAppStore((s) => s.addManualArchive);
  const updateArchiveDay = useAppStore((s) => s.updateArchiveDay);
  const askConfirm = useAppStore((s) => s.askConfirm);
  const pushToast = useAppStore((s) => s.pushToast);

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

  function removeEntry(id: string) {
    const next: ArchiveDay = {
      entries: entries.filter((x) => x.id !== id),
      summary: day?.summary ?? null,
      updatedAt: new Date().toISOString(),
    };
    saveDay(next);
    pushToast("已删除记录", "撤回", () => {
      const restored = entries.find((x) => x.id === id);
      if (restored) {
        saveDay({
          entries: [...entries.filter((x) => x.id !== id), restored].sort((a, b) =>
            a.time.localeCompare(b.time),
          ),
          summary: day?.summary ?? null,
          updatedAt: new Date().toISOString(),
        });
      }
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
                // V3.1 T1：补记归入归档页当前浏览日期 viewDate；失败 Toast 可见。
                await addManualArchive(title.trim(), time, note.trim(), viewDate);
                setTitle("");
                setNote("");
                const month = viewDate.slice(0, 7);
                setArchive(await getArchiveMonth(month));
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
          <ol className="space-y-2">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-gray-50 dark:hover:bg-slate-700">
                <span className="w-24 shrink-0">
                  <TimeField compact value={e.time} onChange={(t) => saveEntry({ ...e, time: t })} />
                </span>
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                <div className="min-w-0 flex-1">
                  <InlineEdit
                    value={e.title}
                    onSave={(title) => saveEntry({ ...e, title })}
                    className="font-medium text-gray-900 dark:text-slate-100"
                  />
                  <div className="mt-0.5 flex gap-2 text-xs text-gray-400 dark:text-slate-500">
                    <span>{SOURCE_LABEL[e.source]}</span>
                    {e.note && <span>{e.note}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50"
                  onClick={() =>
                    askConfirm("删除记录", `删除「${e.title || "该记录"}」？`, () => removeEntry(e.id))
                  }
                >
                  删除
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
