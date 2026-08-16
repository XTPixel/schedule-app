import { useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { fmtClock, fmtDurationMs } from "../lib/longTaskStats";
import type { LongTask, LongTaskSession } from "../types";

interface Props {
  task: LongTask;
  session: LongTaskSession;
  onClose: () => void;
}

/** V1.2：终止投入后的「本次收获」补填对话框（可跳过；关闭 = 保持未填写，详情页可随时补填）。 */
export function SessionSummaryDialog({ task, session, onClose }: Props) {
  const updateNote = useAppStore((s) => s.updateLongTaskSessionNote);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await updateNote(task.id, session.id, note.trim() || null);
    } finally {
      setSaving(false);
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30">
      <div className="w-96 rounded-xl bg-white dark:bg-slate-800 p-5 shadow-xl">
        <h3 className="text-base font-semibold text-gray-900 dark:text-slate-100">本次收获</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">
          「{task.title || "长期任务"}」本次投入{" "}
          <span className="font-medium tabular-nums">{fmtClock(session.durationMs)}</span>（
          {fmtDurationMs(session.durationMs)}）
        </p>
        <textarea
          autoFocus
          rows={4}
          className="mt-3 w-full rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-800 dark:text-slate-100 outline-none placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:border-accent-400"
          placeholder="这次做了什么？有哪些收获？（可选）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700"
            onClick={onClose}
          >
            跳过
          </button>
          <button
            type="button"
            disabled={saving}
            className="rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-400 disabled:opacity-50"
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存收获"}
          </button>
        </div>
      </div>
    </div>
  );
}
