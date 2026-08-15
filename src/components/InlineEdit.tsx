import { useEffect, useRef, useState } from "react";

interface Props {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  className?: string;
  textClassName?: string;
}

/** 行内编辑：单击进入输入态，失焦自动保存（§7.5）。 */
export function InlineEdit({ value, onSave, placeholder, className, textClassName }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className={`block w-full text-left ${className ?? ""} ${textClassName ?? ""}`}
        onClick={() => setEditing(true)}
        title="点击编辑"
      >
        {value || <span className="text-gray-400 dark:text-slate-500">{placeholder ?? "点击添加标题"}</span>}
      </button>
    );
  }

  return (
    <input
      ref={ref}
      className={`inline-input ${className ?? ""}`}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (text !== value) onSave(text);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(value);
          setEditing(false);
        }
      }}
    />
  );
}
