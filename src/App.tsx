import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { syncGetStatus, syncNow, syncTick, syncCancel, recoveryStatus } from "./api/ipc";
import { useAppStore } from "./store/useAppStore";
import { applyTheme } from "./lib/theme";
import { Sidebar } from "./components/Sidebar";
import { Drawer } from "./components/Drawer";
import { ToastContainer } from "./components/Toast";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { RecoveryPanel } from "./components/RecoveryPanel";
import { NowPage } from "./pages/NowPage";
import { CalendarPage } from "./pages/CalendarPage";
import { EventsPage } from "./pages/EventsPage";
import { RoutinesPage } from "./pages/RoutinesPage";
import { TasksPage } from "./pages/TasksPage";
import { LongTasksPage } from "./pages/LongTasksPage";
import { SearchPage } from "./pages/SearchPage";
import { ArchivePage } from "./pages/ArchivePage";
import { StatsPage } from "./pages/StatsPage";
import { ExtensionsPage } from "./pages/ExtensionsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { isAndroid } from "./lib/platform";
import { setEditingAllowed } from "./lib/editing";
import { requestAppExit } from "./lib/appExit";
import type { SyncStatus } from "./types";

export default function App() {
  const page = useAppStore((s) => s.page);
  const init = useAppStore((s) => s.init);
  const refresh = useAppStore((s) => s.refresh);
  const triggerQuickAdd = useAppStore((s) => s.triggerQuickAdd);
  const theme = useAppStore((s) => s.data?.config.appearance.theme ?? "light");
  const checkSnoozes = useAppStore((s) => s.checkSnoozes);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [recovery, setRecovery] = useState<{error:string|null;points:string[]}|null>(null);
  useEffect(() => {
    if (!isAndroid) return;
    const bridge = window as Window & { __momentBack?: () => boolean };
    bridge.__momentBack = () => {
      const store = useAppStore.getState();
      if (store.confirm) { store.confirm.onCancel?.(); store.closeConfirm(); return true; }
      if (store.drawer) { store.requestCloseDrawer(); return true; }
      if (mobileNavOpen) { setMobileNavOpen(false); return true; }
      if (store.page !== "now") { store.setPage("now"); return true; }
      return false;
    };
    return () => { delete bridge.__momentBack; };
  }, [mobileNavOpen]);

  useEffect(() => {
    let mounted = true;
    const acceptStatus = (status: SyncStatus) => {
      if (!mounted) return;
      setSyncStatus(status);
      setEditingAllowed(status.editable);
      if (!status.editable) {
        const store = useAppStore.getState();
        for (const [id, timer] of Object.entries(store.timers)) {
          if (timer.running) store.pauseTimer(id);
        }
      }
    };
    // Load remote data before the first store read so the UI cannot briefly
    // show stale local data or let edits race with the initial download.
    void (async () => {
      let initialized = false;
      try {
        const recovery = await recoveryStatus();
        setRecovery(recovery);
        if (recovery.error) { setEditingAllowed(false); return; }
        const status = await syncGetStatus();
        acceptStatus(status);
        await init();
        initialized = true;
        if (status.configured) acceptStatus(await syncNow());
      } catch {
        try { acceptStatus(await syncGetStatus()); } catch { setEditingAllowed(false); }
      }
      if (!initialized) await init();
    })();
    const unlisteners: Promise<() => void>[] = [];
    unlisteners.push(listen<SyncStatus>("sync-status-changed", (event) => {
      acceptStatus(event.payload);
      if (event.payload.lastSyncAt) void refresh();
    }));
    unlisteners.push(listen("tray-quick-add", () => triggerQuickAdd()));
    unlisteners.push(listen("app-resumed", () => void refresh()));
    unlisteners.push(listen("sync-exit-request", () => { void requestAppExit(); }));
    const resumeSync = async () => {
      if (document.visibilityState !== "visible") return;
      try { const s = await syncGetStatus(); if (s.configured && !s.syncing) await syncTick(); } catch { /* status event carries errors */ }
    };
    const onFocus = () => {
      useAppStore.getState().checkpointTimers();
      void refresh();
      if (isAndroid) void resumeSync();
    };
    const onOnline = () => void resumeSync();
    const onVisibility = () => {
      useAppStore.getState().checkpointTimers();
      if (isAndroid) void resumeSync();
    };
    // Preserve the active segment before a renderer/process restart. Restore
    // remains paused, so time spent with the application closed is excluded.
    const checkpoint = () => useAppStore.getState().checkpointTimers();
    const checkpointInterval = window.setInterval(checkpoint, 10_000);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", checkpoint);
    window.addEventListener("beforeunload", checkpoint);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted = false;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", checkpoint);
      window.removeEventListener("beforeunload", checkpoint);
      window.clearInterval(checkpointInterval);
      document.removeEventListener("visibilitychange", onVisibility);
      unlisteners.forEach((p) => void p.then((fn) => fn()));
    };
  }, [init, refresh, triggerQuickAdd]);

  // 主题应用（§4.8）：浅色 / 深色 / 跟随系统。
  useEffect(() => {
    applyTheme(theme as "light" | "dark" | "system");
  }, [theme]);

  // 跟随系统时，监听系统深浅色变化。
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // V3.0 F2：低频检查「稍后」是否到期，到期移除并重新提醒。
  useEffect(() => {
    checkSnoozes();
    const t = setInterval(() => checkSnoozes(), 15_000);
    return () => clearInterval(t);
  }, [checkSnoozes]);

  // V2.0 Lite：高频检测业务数据指纹；同步模块会在变更后的 30 秒防抖窗口上传。
  useEffect(() => {
    let ticking = false;
    const tick = async () => {
      if (ticking) return;
      ticking = true;
      try { await syncTick(); } catch { /* Status is published by the backend. */ }
      finally { ticking = false; }
    };
    const t = setInterval(tick, isAndroid ? 15_000 : 5_000);
    return () => clearInterval(t);
  }, []);

  if (recovery?.error) return <RecoveryPanel error={recovery.error} points={recovery.points} />;
  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#f6f7f9] dark:bg-slate-900">
      <Sidebar mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-gray-200 bg-white/95 px-4 backdrop-blur dark:border-slate-700 dark:bg-slate-800/95 md:hidden">
          <button
            type="button"
            aria-label="打开导航"
            className="rounded-lg px-2 py-1 text-xl text-gray-600 hover:bg-gray-100 dark:text-slate-200 dark:hover:bg-slate-700"
            onClick={() => setMobileNavOpen(true)}
          >
            ☰
          </button>
          <span className="text-sm font-semibold text-gray-800 dark:text-slate-100">此刻 MOMENT</span>
        </header>
        {syncStatus?.configured && (
          <div role="status" className={`flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs ${syncStatus.editable ? "border-blue-100 bg-blue-50 text-blue-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
            <span>{syncStatus.editable ? (syncStatus.dirty ? "本机可编辑 · 修改待同步" : "本机可编辑 · 已同步") : "当前只读 · 请先获取编辑权"}</span>
            {syncStatus.lastError && <span className="break-all">{syncStatus.lastError}</span>}
            {syncStatus.syncing && <button type="button" className="underline" onClick={()=>void syncCancel()}>取消同步</button>}
            {syncStatus.retryAt && !syncStatus.syncing && <span>将在 {new Date(syncStatus.retryAt).toLocaleTimeString()} 后重试</span>}
            <button type="button" className="ml-auto shrink-0 underline" onClick={() => useAppStore.getState().setPage("settings")}>同步设置</button>
          </div>
        )}
        {page === "now" && <NowPage />}
        {page === "calendar" && <CalendarPage />}
        {page === "events" && <EventsPage />}
        {page === "routines" && <RoutinesPage />}
        {page === "tasks" && <TasksPage />}
        {page === "longtasks" && <LongTasksPage />}
        {page === "search" && <SearchPage />}
        {page === "archive" && <ArchivePage />}
        {page === "stats" && <StatsPage />}
        {page === "extensions" && <ExtensionsPage />}
        {page === "settings" && <SettingsPage />}
      </main>
      <Drawer />
      <ToastContainer />
      <ConfirmDialog />
    </div>
  );
}
