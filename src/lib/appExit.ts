import { syncExit, syncForceExit, saveLocalTimerExit } from "../api/ipc";
import { useAppStore } from "../store/useAppStore";

let exitPending = false;

/** The same visible handoff flow is used by the tray, window close and mobile. */
export async function requestAppExit(): Promise<void> {
  if (exitPending) return;
  exitPending = true;
  const store = useAppStore.getState();
  // Keep the effective segment as a paused local draft before any network wait.
  for (const [id, timer] of Object.entries(store.timers)) {
    if (timer.running) store.pauseTimer(id);
  }
  try {
    await saveLocalTimerExit({ updatedAt: Date.now() + 1, timers: useAppStore.getState().timers });
  } catch (error) {
    store.pushToast(`计时草稿保存失败，请重试退出：${String(error)}`);
    exitPending = false;
    return;
  }
  try {
    await syncExit();
    exitPending = false;
  } catch (error) {
    store.askConfirm(
      "同步尚未完成",
      `${String(error)}。本地修改和计时草稿已保留。返回应用可重试；仍然退出会保留待上传数据，另一设备需要等租约到期后再接管。`,
      async () => {
        try { await syncForceExit(); }
        catch (failure) { store.pushToast(`退出失败：${String(failure)}`); }
        finally { exitPending = false; }
      },
      () => { exitPending = false; },
      "保留本地并退出",
      "返回应用",
    );
  }
}
