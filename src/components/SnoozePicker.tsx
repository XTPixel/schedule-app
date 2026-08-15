import { useState } from "react";

const PRESETS: [number, string][] = [
  [10, "10 分钟"],
  [30, "30 分钟"],
  [60, "1 小时"],
  [120, "2 小时"],
];

/** 稍后延时选择（V3.0 F2）：预设 + 自定义分钟。 */
export function SnoozePicker({ onPick, onClose }: { onPick: (minutes: number) => void; onClose: () => void }) {
  const [custom, setCustom] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-700/40 p-2">
      {PRESETS.map(([m, label]) => (
        <button
          key={m}
          type="button"
          className="rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-xs text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
          onClick={() => onPick(m)}
        >
          {label}
        </button>
      ))}
      <input
        type="number"
        min={1}
        className="w-20 rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-xs text-gray-800 dark:text-slate-100 outline-none"
        placeholder="自定义分钟"
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
      />
      <button
        type="button"
        className="rounded-md bg-accent-500 px-2 py-1 text-xs text-white hover:bg-accent-400"
        onClick={() => {
          const m = Number(custom);
          onPick(m > 0 ? m : 30);
        }}
      >
        确定
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-xs text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700"
        onClick={onClose}
      >
        取消
      </button>
    </div>
  );
}
