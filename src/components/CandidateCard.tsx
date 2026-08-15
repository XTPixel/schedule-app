import { useEffect, useState } from "react";
import type { Candidate } from "../types";
import { CANDIDATE_SOURCE_LABEL, PRIORITY_BADGE, PRIORITY_LABEL } from "../lib/format";
import { useAppStore } from "../store/useAppStore";
import { SnoozePicker } from "./SnoozePicker";

interface Props {
  candidate: Candidate;
  primary?: boolean;
}

function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 候选卡片（主候选大卡 / 次选紧凑卡），含「开始/暂停/完成/跳过/稍后」操作（V3.0 F1/F2）。 */
export function CandidateCard({ candidate, primary }: Props) {
  const complete = useAppStore((s) => s.completeCandidate);
  const pushToast = useAppStore((s) => s.pushToast);
  const askConfirm = useAppStore((s) => s.askConfirm);
  const toggleTimer = useAppStore((s) => s.toggleTimer);
  const skipCandidate = useAppStore((s) => s.skipCandidate);
  const undoSkipped = useAppStore((s) => s.undoSkipped);
  const snoozeCandidate = useAppStore((s) => s.snoozeCandidate);
  const undoSnoozed = useAppStore((s) => s.undoSnoozed);
  const timer = useAppStore((s) => s.timers[candidate.sourceId]);

  const [snoozing, setSnoozing] = useState(false);
  const [, setTick] = useState(0);

  // 运行中每秒刷新一次以更新计时显示。
  useEffect(() => {
    if (!timer?.running) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [timer?.running]);

  const c = candidate;
  const elapsedMs = timer ? timer.accumulatedMs + (timer.running ? Date.now() - timer.startedAt : 0) : 0;
  const timerLabel = timer ? fmtElapsed(elapsedMs) : null;

  function onSkip() {
    askConfirm("跳过该事项", `跳过后「${c.title || "该事项"}」将在今日不再提示，确定？`, () => {
      skipCandidate(c.sourceId);
      pushToast(`已跳过「${c.title || "该事项"}」`, "撤回", () => undoSkipped(c.sourceId));
    });
  }

  function onSnooze(minutes: number) {
    snoozeCandidate(c.sourceId, c.title, minutes);
    setSnoozing(false);
    pushToast(`已稍后 ${minutes} 分钟`, "撤回", () => undoSnoozed(c.sourceId));
  }

  return (
    <div
      className={`rounded-2xl border bg-white dark:bg-slate-800 shadow-card ${
        primary ? "border-accent-200 p-6" : "border-gray-100 dark:border-slate-700 p-4"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 text-xs text-gray-500 dark:text-slate-400">
              {CANDIDATE_SOURCE_LABEL[c.sourceType]}
            </span>
            <span className={`rounded border px-1.5 py-0.5 text-xs ${PRIORITY_BADGE[c.priority]}`}>
              {PRIORITY_LABEL[c.priority]}
            </span>
          </div>
          <h3 className={`mt-2 truncate font-semibold text-gray-900 dark:text-slate-100 ${primary ? "text-2xl" : "text-base"}`}>
            {c.title || "（未命名）"}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
            {c.reason}
            {c.timeLabel ? ` · ${c.timeLabel}` : ""}
          </p>
          {c.description && <p className="mt-1 text-sm text-gray-400 dark:text-slate-500">{c.description}</p>}
        </div>
        {timerLabel && (
          <div className="shrink-0 rounded-lg bg-gray-50 dark:bg-slate-700/50 px-3 py-1.5 text-right">
            <div className={`text-lg font-semibold tabular-nums ${timer?.running ? "text-emerald-600 dark:text-emerald-300" : "text-gray-500 dark:text-slate-400"}`}>
              {timerLabel}
            </div>
            <div className="text-xs text-gray-400 dark:text-slate-500">{timer?.running ? "进行中" : "已暂停"}</div>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white ${
            timer?.running ? "bg-amber-500 hover:bg-amber-400" : "bg-accent-500 hover:bg-accent-400"
          }`}
          onClick={() => toggleTimer(c.sourceType, c.sourceId, c.title)}
        >
          {timer?.running ? "暂停" : timer ? "继续" : "开始"}
        </button>
        <button
          type="button"
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-400"
          onClick={() =>
            complete(c.sourceType, c.sourceId, c.seriesId, c.title, c.suggestedDurationMinutes)
          }
        >
          完成
        </button>
        <button
          type="button"
          className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
          onClick={onSkip}
        >
          跳过
        </button>
        <button
          type="button"
          className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
          onClick={() => setSnoozing((v) => !v)}
        >
          稍后
        </button>
      </div>

      {snoozing && (
        <div className="mt-2">
          <SnoozePicker onPick={onSnooze} onClose={() => setSnoozing(false)} />
        </div>
      )}
    </div>
  );
}
