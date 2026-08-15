import { useAppStore } from "../store/useAppStore";

/** 底部 Toast 撤回条（§7.5，停留 6 秒）。 */
export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);

  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-3 rounded-lg bg-gray-900 px-4 py-2.5 text-sm text-white shadow-lg"
        >
          <span>{t.message}</span>
          {t.actionLabel && (
            <button
              type="button"
              className="rounded bg-accent-500 px-2 py-0.5 text-xs font-medium hover:bg-accent-400"
              onClick={() => {
                t.onAction?.();
                dismiss(t.id);
              }}
            >
              {t.actionLabel}
            </button>
          )}
          <button
            type="button"
            className="ml-1 text-gray-400 dark:text-slate-500 hover:text-white"
            onClick={() => dismiss(t.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
