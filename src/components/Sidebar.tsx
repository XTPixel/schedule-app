import { useAppStore, type Page } from "../store/useAppStore";
import { version } from "../../package.json";

const NAV: { key: Page; label: string; icon: string }[] = [
  { key: "now", label: "现在", icon: "◉" },
  { key: "calendar", label: "日历", icon: "▦" },
  { key: "events", label: "事件", icon: "◷" },
  { key: "routines", label: "日常", icon: "↻" },
  { key: "tasks", label: "浮动", icon: "☰" },
  { key: "longtasks", label: "长期", icon: "◈" },
  { key: "search", label: "搜索", icon: "⌕" },
  { key: "archive", label: "归档", icon: "▤" },
  { key: "stats", label: "统计", icon: "◫" },
  { key: "extensions", label: "扩展", icon: "❖" },
  { key: "settings", label: "设置", icon: "⚙" },
];

/** 导航侧栏（§7.2 信息架构，v1.1.0 功能全景）。 */
export function Sidebar({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="关闭导航"
          className="fixed inset-0 z-30 bg-slate-950/40 md:hidden"
          onClick={onClose}
        />
      )}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white transition-transform dark:border-slate-600 dark:bg-slate-800 md:static md:w-44 md:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="flex h-14 items-center gap-2 px-4 text-sm font-semibold text-gray-800 dark:text-slate-100">
        <span
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: "linear-gradient(180deg, #5C6CFF 0%, #3534B8 100%)" }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4">
            <circle cx="12" cy="12" r="9.5" fill="none" stroke="#FFFFFF" strokeWidth="2" />
            <path d="M12 12 L8.5 10" stroke="#FFFFFF" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M12 12 L16.8 9.2" stroke="#FFFFFF" strokeWidth="1.3" strokeLinecap="round" />
            <circle cx="12" cy="12" r="1.6" fill="#FFC53D" />
          </svg>
        </span>
        此刻 MOMENT
        <button
          type="button"
          aria-label="关闭导航"
          className="ml-auto rounded-md px-2 py-1 text-lg text-gray-500 hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-700 md:hidden"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-2">
        {NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            onClick={() => { setPage(n.key); onClose(); }}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
              page === n.key
                ? "bg-accent-50 dark:bg-accent-900/30 font-medium text-accent-700 dark:text-accent-200"
                : "text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"
            }`}
          >
            <span className="w-4 text-center">{n.icon}</span>
            {n.label}
          </button>
        ))}
      </nav>
      <div className="px-4 py-3 text-xs text-gray-400 dark:text-slate-500">v{version.replace("-", " ")}</div>
      </aside>
    </>
  );
}
