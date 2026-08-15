import { useEffect, useState } from "react";
import { digitsToHhmm, isHhmm } from "../lib/time";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  /** V3.1 U3：紧凑模式——箭头绝对定位在输入框内部右侧，不额外占宽。 */
  compact?: boolean;
}

/** 自定义时间输入（§7.5）：键盘直输数字（1430 → 14:30）+ 上下步进。 */
export function TimeField({ value, onChange, onBlur, disabled, compact }: Props) {
  const [text, setText] = useState(value);

  useEffect(() => setText(value), [value]);

  function commit(raw: string) {
    const d = digitsToHhmm(raw);
    if (d) {
      setText(d);
      onChange(d);
    } else if (isHhmm(raw)) {
      onChange(raw);
    } else {
      setText(value); // 还原
    }
  }

  function step(delta: number) {
    const [h, m] = value.split(":").map(Number);
    const total = (((h * 60 + m + delta) % 1440) + 1440) % 1440;
    const hh = String(Math.floor(total / 60)).padStart(2, "0");
    const mm = String(total % 60).padStart(2, "0");
    const next = `${hh}:${mm}`;
    setText(next);
    onChange(next);
  }

  if (compact) {
    return (
      <div className="relative w-24 shrink-0">
        <input
          className="w-24 rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 py-1.5 pl-2 pr-6 text-center text-sm text-gray-800 dark:text-slate-100 outline-none focus:border-accent-400 focus:ring-2 focus:ring-accent-100"
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            commit(text);
            onBlur?.();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "ArrowUp") {
              e.preventDefault();
              step(5);
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              step(-5);
            }
          }}
        />
        <div className="absolute right-1 top-0 bottom-0 flex flex-col justify-center">
          <button
            type="button"
            className="rounded px-0.5 text-xs leading-3 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700 hover:text-gray-700"
            onClick={() => step(5)}
            tabIndex={-1}
          >
            ▲
          </button>
          <button
            type="button"
            className="rounded px-0.5 text-xs leading-3 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700 hover:text-gray-700"
            onClick={() => step(-5)}
            tabIndex={-1}
          >
            ▼
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        className="w-20 rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-center text-sm text-gray-800 dark:text-slate-100 outline-none focus:border-accent-400 focus:ring-2 focus:ring-accent-100"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          commit(text);
          onBlur?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp") {
            e.preventDefault();
            step(5);
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            step(-5);
          }
        }}
      />
      <div className="flex flex-col">
        <button
          type="button"
          className="rounded px-1 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700 hover:text-gray-700"
          onClick={() => step(5)}
          tabIndex={-1}
        >
          ▲
        </button>
        <button
          type="button"
          className="rounded px-1 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700 hover:text-gray-700"
          onClick={() => step(-5)}
          tabIndex={-1}
        >
          ▼
        </button>
      </div>
    </div>
  );
}
