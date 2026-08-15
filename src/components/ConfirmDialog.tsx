import { useAppStore } from "../store/useAppStore";

/** 危险确认对话框（§7.5：仅危险确认允许模态）。 */
export function ConfirmDialog() {
  const confirm = useAppStore((s) => s.confirm);
  const close = useAppStore((s) => s.closeConfirm);
  if (!confirm) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30">
      <div className="w-80 rounded-xl bg-white dark:bg-slate-800 p-5 shadow-xl">
        <h3 className="text-base font-semibold text-gray-900 dark:text-slate-100">{confirm.title}</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">{confirm.message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700"
            onClick={async () => {
              const onCancel = confirm.onCancel;
              close();
              await onCancel?.();
            }}
          >
            {confirm.cancelLabel ?? "取消"}
          </button>
          <button
            type="button"
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-500"
            onClick={async () => {
              const onConfirm = confirm.onConfirm;
              close();
              await onConfirm();
            }}
          >
            {confirm.confirmLabel ?? "确认"}
          </button>
        </div>
      </div>
    </div>
  );
}
