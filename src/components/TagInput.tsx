import { useMemo, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { tagChipClasses } from "../lib/tagColor";

interface Props {
  value: string[];
  onChange: (tags: string[]) => void;
  onBlur?: () => void;
}

/** 标签输入（V3.0 F4 / v1.1.0）：芯片列表 + 输入框；已有标签候选始终直接显示，可点击选择，也可输入新建。V3.1 应用标签颜色。 */
export function TagInput({ value, onChange, onBlur }: Props) {
  const tags = useAppStore((s) => s.tags);
  const tagColors = useAppStore((s) => s.data?.config.tagColors ?? {});
  const [text, setText] = useState("");

  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase();
    return tags
      .filter((t) => !value.includes(t.tag) && (!q || t.tag.toLowerCase().includes(q)))
      .map((t) => t.tag)
      .slice(0, 8);
  }, [tags, value, text]);

  function add(raw: string) {
    const t = raw.trim();
    setText("");
    if (!t || value.includes(t)) return;
    onChange([...value, t]);
  }
  function remove(t: string) {
    onChange(value.filter((x) => x !== t));
  }
  /** 失焦时把输入框中尚未回车确认的文本补录为标签，避免「填了直接点保存就丢失」。 */
  function commitPending() {
    const t = text.trim();
    if (!t || value.includes(t)) {
      setText("");
      return;
    }
    setText("");
    onChange([...value, t]);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5">
        {value.map((t) => (
          <span
            key={t}
            className={`flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${tagChipClasses(tagColors[t])}`}
          >
            #{t}
            <button
              type="button"
              className="text-current opacity-60 hover:opacity-100"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => remove(t)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="min-w-24 flex-1 border-0 bg-transparent px-1 py-0.5 text-sm text-gray-800 dark:text-slate-100 outline-none placeholder:text-gray-400 dark:placeholder:text-slate-500"
          placeholder="输入标签，回车/逗号添加，或点选下方已有标签"
          value={text}
          onBlur={() => {
            // 先把未确认文本落成标签，再通知外层（此时外层能读到最新 tags）。
            commitPending();
            onBlur?.();
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              // 中文输入法选词确认的 Enter/逗号不当作新增；compositionend 后仍可失焦兜底提交。
              if (e.nativeEvent.isComposing) return;
              e.preventDefault();
              add(text);
            } else if (e.key === "Backspace" && !text && value.length) {
              remove(value[value.length - 1]);
            }
          }}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-xs text-gray-400 dark:text-slate-500">已有标签</span>
          {suggestions.map((t) => (
            <button
              key={t}
              type="button"
              className={`rounded-full border px-2 py-0.5 text-xs hover:opacity-90 ${tagChipClasses(tagColors[t])}`}
              onMouseDown={(e) => {
                e.preventDefault();
                add(t);
              }}
            >
              #{t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
