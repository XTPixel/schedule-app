// 共享输入类配色（V3.0 B4）：统一补全背景/文字/占位符颜色，避免深色主题下文字看不清。
export const INPUT_COLORS =
  "bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500";

/** 通用输入框类（含边框/内边距/焦点态）。宽度由调用方追加（w-full / w-20 / flex-1 等）。 */
export const inputClass = `rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm outline-none focus:border-accent-400 focus:ring-2 focus:ring-accent-100 ${INPUT_COLORS}`;
