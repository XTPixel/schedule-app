import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./store/useAppStore";
import { applyTheme } from "./lib/theme";
import { Sidebar } from "./components/Sidebar";
import { Drawer } from "./components/Drawer";
import { ToastContainer } from "./components/Toast";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { NowPage } from "./pages/NowPage";
import { CalendarPage } from "./pages/CalendarPage";
import { EventsPage } from "./pages/EventsPage";
import { RoutinesPage } from "./pages/RoutinesPage";
import { TasksPage } from "./pages/TasksPage";
import { SearchPage } from "./pages/SearchPage";
import { ArchivePage } from "./pages/ArchivePage";
import { StatsPage } from "./pages/StatsPage";
import { ExtensionsPage } from "./pages/ExtensionsPage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  const page = useAppStore((s) => s.page);
  const init = useAppStore((s) => s.init);
  const refresh = useAppStore((s) => s.refresh);
  const triggerQuickAdd = useAppStore((s) => s.triggerQuickAdd);
  const theme = useAppStore((s) => s.data?.config.appearance.theme ?? "light");
  const checkSnoozes = useAppStore((s) => s.checkSnoozes);

  useEffect(() => {
    void init();
    const unlisteners: Promise<() => void>[] = [];
    unlisteners.push(listen("tray-quick-add", () => triggerQuickAdd()));
    unlisteners.push(listen("app-resumed", () => void refresh()));
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
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

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#f6f7f9] dark:bg-slate-900">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {page === "now" && <NowPage />}
        {page === "calendar" && <CalendarPage />}
        {page === "events" && <EventsPage />}
        {page === "routines" && <RoutinesPage />}
        {page === "tasks" && <TasksPage />}
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
