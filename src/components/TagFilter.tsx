import { useEffect } from "react";
import { useAppStore } from "../store/useAppStore";
import { tagChipClasses } from "../lib/tagColor";

/** 标签过滤条（Phase 2 完整标签过滤）：多选标签，用于列表页过滤；V3.1 应用标签颜色。 */
export function TagFilterBar({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (s: string[]) => void;
}) {
  const tags = useAppStore((s) => s.tags);
  const tagsLoaded = useAppStore((s) => s.tagsLoaded);
  const loadTags = useAppStore((s) => s.loadTags);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  // 标签列表加载完成后，自动清除已不存在（被重命名/删除）的持久化筛选，
  // 避免旧筛选在无标签可匹配时把列表/日历全部过滤为空。
  useEffect(() => {
    if (!tagsLoaded) return;
    const valid = tags.map((t) => t.tag);
    const next = selected.filter((s) => valid.includes(s));
    if (next.length !== selected.length) {
      onChange(next);
    }
  }, [tagsLoaded, tags, selected, onChange]);

  if (tags.length === 0) return null;

  function toggle(t: string) {
    onChange(selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t]);
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-gray-400 dark:text-slate-500">按标签过滤：</span>
      {tags.map((t) => (
        <button
          key={t.tag}
          type="button"
          onClick={() => toggle(t.tag)}
          className={`rounded-full border px-2.5 py-0.5 text-xs ${
            selected.includes(t.tag)
              ? `${tagChipClasses(t.color)} font-medium`
              : "border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
          }`}
        >
          #{t.tag}
        </button>
      ))}
      {selected.length > 0 && (
        <button type="button" className="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600" onClick={() => onChange([])}>
          清除
        </button>
      )}
    </div>
  );
}

export function matchesTags(itemTags: string[], selected: string[]): boolean {
  if (selected.length === 0) return true;
  return selected.every((t) => itemTags.includes(t));
}

/** 列表页标签芯片（V3.1 U4：应用颜色）。 */
export function TagChips({ tags, className = "" }: { tags: string[]; className?: string }) {
  const tagColors = useAppStore((s) => s.data?.config.tagColors ?? {});
  if (tags.length === 0) return null;
  return (
    <span className={`flex flex-wrap items-center gap-1 ${className}`}>
      {tags.map((t) => (
        <span key={t} className={`rounded border px-1.5 py-0.5 text-xs ${tagChipClasses(tagColors[t])}`}>
          #{t}
        </span>
      ))}
    </span>
  );
}
