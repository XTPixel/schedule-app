import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/useAppStore";
import { TimeField } from "../components/TimeField";
import { pickDirectory, openDataDir, syncConfigure, syncDisconnect, syncGetStatus, syncNow, syncResolveInitial, syncTakeoverExpired, syncTestConnection } from "../api/ipc";
import { TAG_COLOR_TOKENS, tagBarClasses, tagChipClasses } from "../lib/tagColor";
import { isAndroid } from "../lib/platform";
import { exportBackupDocument, importBackupDocument, notificationPermission, notificationReminderStatus, notificationOpenSettings } from "../api/ipc";
import { recoveryPoints as getRecoveryPoints, restoreRecoveryPoint, recoveryDetails, exportSyncDiagnostics, syncCancel } from "../api/ipc";
import type { Config, InitialSyncChoice, NotifyLevel, SyncConfigInput, SyncStatus } from "../types";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-gray-800 dark:text-slate-100">{title}</h2>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="text-sm text-gray-700 dark:text-slate-200">{label}</div>
        {hint && <div className="text-xs text-gray-400 dark:text-slate-500">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition ${checked ? "bg-accent-500" : "bg-gray-200"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white dark:bg-slate-800 shadow transition-all ${
          checked ? "left-[22px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function LevelSelect({ value, onChange }: { value: NotifyLevel; onChange: (v: NotifyLevel) => void }) {
  return (
    <select
      className="rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-gray-800 dark:text-slate-100 outline-none focus:border-accent-400"
      value={value}
      onChange={(e) => onChange(e.target.value as NotifyLevel)}
    >
      <option value="system">系统通知</option>
      <option value="app">仅应用内</option>
      <option value="off">不提醒</option>
    </select>
  );
}

const TIMEZONES = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

/** 设置页：通知/免打扰/行为/时区/主题/数据目录/导入导出/标签管理（Phase 1 + 1.5）。 */
export function SettingsPage() {
  const data = useAppStore((s) => s.data);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const setDataDir = useAppStore((s) => s.setDataDir);
  const exportData = useAppStore((s) => s.exportData);
  const importData = useAppStore((s) => s.importData);
  const pushToast = useAppStore((s) => s.pushToast);
  const tags = useAppStore((s) => s.tags);
  const loadTags = useAppStore((s) => s.loadTags);
  const renameTag = useAppStore((s) => s.renameTag);
  const deleteTag = useAppStore((s) => s.deleteTag);

  const config: Config | undefined = data?.config;
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [permission, setPermission] = useState<string | null>(null);
  const [exactReminder, setExactReminder] = useState<boolean | null>(null);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [recoveryPoints, setRecoveryPoints] = useState<string[]>([]);
  const [recoveryId, setRecoveryId] = useState("");
  const [recoveryLabels, setRecoveryLabels] = useState<Record<string,string>>({});
  useEffect(() => { void getRecoveryPoints().then(setRecoveryPoints).catch(() => setRecoveryPoints([])); }, []);
  useEffect(() => { void recoveryDetails().then(points=>setRecoveryLabels(Object.fromEntries(points.map(p=>[p.id,new Date(Number(p.id.split("-")[0])).toLocaleString()+" · "+p.platform+" · 数据 v"+(p.schemaVersion || "?")+" · "+p.files+" 文件"+(p.complete ? "" : " · 不完整")])))).catch(()=>setRecoveryLabels({})); }, [recoveryPoints]);
  useEffect(() => {
    if (!isAndroid) return;
    const refreshPermission = () => {
      if (document.visibilityState !== "visible") return;
      void notificationPermission().then(setPermission).catch(() => setPermission("unknown"));
      void notificationReminderStatus().then(s => setExactReminder(s.exact)).catch(() => setExactReminder(null));
    };
    refreshPermission();
    document.addEventListener("visibilitychange", refreshPermission);
    window.addEventListener("focus", refreshPermission);
    return () => { document.removeEventListener("visibilitychange", refreshPermission); window.removeEventListener("focus", refreshPermission); };
  }, []);
  async function mobileBackup(restore: boolean) {
    if (restore) setImporting(true); else setExporting(true);
    try {
      const changed = restore ? await importBackupDocument(backupPassphrase || undefined) : await exportBackupDocument(backupPassphrase || undefined);
      if (changed) {
        pushToast(restore ? "日程备份已恢复" : "日程备份已保存");
        if (restore) await useAppStore.getState().refresh();
        if (restore) setRecoveryPoints(await getRecoveryPoints());
      }
    } catch (error) { pushToast(`备份操作失败：${String(error)}`); }
    finally { setImporting(false); setExporting(false); }
  }
  // V3.1 T4：数字输入 300ms 防抖后保存，避免逐字符触发配置应用线程。
  const [graceDraft, setGraceDraft] = useState<number | null>(null);
  const graceTimer = useRef<number | undefined>(undefined);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncForm, setSyncForm] = useState<SyncConfigInput>({
    bucket: "", downloadDomain: "", prefix: "moment-sync/v2", deviceName: isAndroid ? "Android手机" : "Windows电脑", accessKey: "", secretKey: "", passphrase: "",
  });

  useEffect(() => {
    void loadTags();
    void syncGetStatus().then(setSyncStatus).catch(() => setSyncStatus(null));
    const off=listen<SyncStatus>("sync-status-changed", event => setSyncStatus(event.payload));
    return () => { void off.then(unlisten => unlisten()); };
  }, [loadTags]);

  useEffect(() => {
    if (config) setGraceDraft(config.candidate.missedRoutineGraceHours);
  }, [config?.candidate.missedRoutineGraceHours]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!config) return null;

  function save(next: Config) {
    void saveConfig(next);
  }

  /** 读最新 config 后再合并，防抖回调不会覆盖期间其他设置。 */
  function saveCandidateGrace(v: number) {
    setGraceDraft(v);
    window.clearTimeout(graceTimer.current);
    graceTimer.current = window.setTimeout(() => {
      const latest = useAppStore.getState().data?.config;
      if (!latest) return;
      save({ ...latest, candidate: { missedRoutineGraceHours: v } });
    }, 300);
  }

  async function onPickDir() {
    const dir = await pickDirectory();
    if (dir) {
      await setDataDir(dir);
      pushToast(`数据目录已切换至 ${dir}`);
    }
  }

  async function onOpenDir() {
    try {
      await openDataDir();
    } catch (e) {
      pushToast(`打开目录失败：${String(e)}`);
    }
  }

  async function onExport() {
    const dir = await pickDirectory();
    if (!dir) return;
    setExporting(true);
    try {
      const files = await exportData(dir);
      pushToast(`已导出 ${files.length} 个文件到 ${dir}/schedule-export`);
    } catch (e) {
      pushToast(`导出失败：${String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  async function onImport() {
    const dir = await pickDirectory();
    if (!dir) return;
    setImporting(true);
    try {
      const r = await importData(dir);
      pushToast(`已导入：事件 ${r.events}、日常 ${r.routines}、浮动 ${r.tasks}、长期 ${r.longTasks}、归档 ${r.archiveMonths} 个月`);
    } catch (e) {
      pushToast(`导入失败：${String(e)}`);
    } finally {
      setImporting(false);
    }
  }

  function setSync<K extends keyof SyncConfigInput>(key: K, value: SyncConfigInput[K]) {
    setSyncForm((prev) => ({ ...prev, [key]: value }));
  }

  async function saveSync() {
    setSyncBusy(true);
    try {
      setSyncStatus(await syncConfigure(syncForm));
      pushToast("七牛同步配置已安全保存到系统凭据库");
      setSyncForm((p) => ({ ...p, accessKey: "", secretKey: "", passphrase: "" }));
    } catch (e) { pushToast(`保存同步配置失败：${String(e)}`); } finally { setSyncBusy(false); }
  }
  async function runSync(testOnly = false) {
    setSyncBusy(true);
    try { setSyncStatus(testOnly ? await syncTestConnection() : await syncNow()); pushToast(testOnly ? "七牛连接正常" : "同步完成"); }
    catch (e) { setSyncStatus(await syncGetStatus().catch(() => null)); pushToast(`${testOnly ? "连接" : "同步"}失败：${String(e)}`); }
    finally { setSyncBusy(false); }
  }
  async function chooseInitial(choice: InitialSyncChoice) {
    setSyncBusy(true);
    try { setSyncStatus(await syncResolveInitial(choice)); pushToast(choice === "upload" ? "已上传本地快照" : choice === "download" ? "已下载远端快照" : "已取消首次同步"); if (choice !== "cancel") await useAppStore.getState().refresh(); }
    catch (e) { pushToast(`首次同步失败：${String(e)}`); } finally { setSyncBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-6 text-xl font-bold text-gray-900 dark:text-slate-100">设置</h1>

      <Section title="外观">
        <Row label="主题" hint="浅色 / 深色 / 跟随系统">
          <select
            className="rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-gray-800 dark:text-slate-100 outline-none focus:border-accent-400"
            value={config.appearance.theme}
            onChange={(e) => save({ ...config, appearance: { theme: e.target.value } })}
          >
            <option value="light">浅色</option>
            <option value="dark">深色</option>
            <option value="system">跟随系统</option>
          </select>
        </Row>
      </Section>

      <Section title="通知">
        {isAndroid && <>
          <Row label="系统通知权限" hint={permission === "granted" ? "已允许" : permission === null ? "正在检查…" : "通知未获允许；反复拒绝后需到系统设置开启"}>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => void notificationPermission(true).then(setPermission).catch(e => pushToast(String(e)))}>检查并申请</button>
              <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => void notificationOpenSettings().catch(e => pushToast(String(e)))}>通知设置</button>
            </div>
          </Row>
          <Row label="精确定时" hint={exactReminder === true ? "系统已允许精确定时" : exactReminder === false ? "尚未允许，系统可能延迟提醒；可在闹钟和提醒设置中开启" : "正在检查系统定时能力…"}>
            <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => void notificationOpenSettings(true).catch(e => pushToast(String(e)))}>定时设置</button>
          </Row>
          <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">应用预排未来 48 小时内最多 128 条提醒，打开应用时更新。重启解锁后恢复已排提醒；系统强行停止应用会取消提醒，需重新打开。省电模式或厂商后台限制可能延迟提醒，可按需在系统应用管理中允许后台运行。</p>
        </>}
        <Row label="系统通知" hint="事件/日常窗口/截止日提醒">
          <Toggle
            checked={config.notifications.enabled}
            onChange={(v) => save({ ...config, notifications: { ...config.notifications, enabled: v } })}
          />
        </Row>
        <Row label="提示音">
          <Toggle
            checked={config.notifications.sound}
            onChange={(v) => save({ ...config, notifications: { ...config.notifications, sound: v } })}
          />
        </Row>
        <Row label="免打扰时段" hint="该时段内仅应用内展示，不弹系统通知">
          <Toggle
            checked={config.notifications.doNotDisturb.enabled}
            onChange={(v) =>
              save({
                ...config,
                notifications: {
                  ...config.notifications,
                  doNotDisturb: { ...config.notifications.doNotDisturb, enabled: v },
                },
              })
            }
          />
        </Row>
        <Row label="免打扰区间">
          <div className="flex items-center gap-2">
            <TimeField
              value={config.notifications.doNotDisturb.start}
              onChange={(v) =>
                save({
                  ...config,
                  notifications: {
                    ...config.notifications,
                    doNotDisturb: { ...config.notifications.doNotDisturb, start: v },
                  },
                })
              }
            />
            <span className="text-gray-400 dark:text-slate-500">–</span>
            <TimeField
              value={config.notifications.doNotDisturb.end}
              onChange={(v) =>
                save({
                  ...config,
                  notifications: {
                    ...config.notifications,
                    doNotDisturb: { ...config.notifications.doNotDisturb, end: v },
                  },
                })
              }
            />
          </div>
        </Row>
        <Row label="分级提醒" hint="按优先级决定提醒方式：系统级通知 / 仅应用内 / 不提醒">
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
            <span>高</span>
            <LevelSelect
              value={config.notifications.priorityPolicy.high}
              onChange={(v) =>
                save({
                  ...config,
                  notifications: {
                    ...config.notifications,
                    priorityPolicy: { ...config.notifications.priorityPolicy, high: v },
                  },
                })
              }
            />
            <span>中</span>
            <LevelSelect
              value={config.notifications.priorityPolicy.normal}
              onChange={(v) =>
                save({
                  ...config,
                  notifications: {
                    ...config.notifications,
                    priorityPolicy: { ...config.notifications.priorityPolicy, normal: v },
                  },
                })
              }
            />
            <span>低</span>
            <LevelSelect
              value={config.notifications.priorityPolicy.low}
              onChange={(v) =>
                save({
                  ...config,
                  notifications: {
                    ...config.notifications,
                    priorityPolicy: { ...config.notifications.priorityPolicy, low: v },
                  },
                })
              }
            />
          </div>
        </Row>
      </Section>

      {!isAndroid && <Section title="行为">
        <Row label="最小化到托盘" hint="关闭主窗口时缩到托盘而非退出">
          <Toggle
            checked={config.behavior.minimizeToTray}
            onChange={(v) => save({ ...config, behavior: { ...config.behavior, minimizeToTray: v } })}
          />
        </Row>
        <Row label="开机自启动" hint="登录 Windows 后自动运行本应用">
          <Toggle
            checked={config.behavior.launchAtStartup}
            onChange={(v) => save({ ...config, behavior: { ...config.behavior, launchAtStartup: v } })}
          />
        </Row>
        <Row label="全局快捷键" hint="唤起主窗口（如 Ctrl+Shift+A，失焦保存）">
          <input
            className="rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-gray-800 dark:text-slate-100 outline-none focus:border-accent-400"
            defaultValue={config.behavior.globalHotkey}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== config.behavior.globalHotkey) {
                save({ ...config, behavior: { ...config.behavior, globalHotkey: v } });
              }
            }}
          />
        </Row>
      </Section>}

      <Section title="候选推荐">
        <Row label="逾期日常宽限" hint="窗口结束后多少小时内可补（不再硬编码 4 小时）">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              className="w-20 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-gray-800 dark:text-slate-100 outline-none focus:border-accent-400"
              value={graceDraft ?? config.candidate.missedRoutineGraceHours}
              onChange={(e) => saveCandidateGrace(Math.max(0, Number(e.target.value) || 0))}
            />
            <span className="text-sm text-gray-500 dark:text-slate-400">小时</span>
          </div>
        </Row>
      </Section>

      <Section title="时间与数据">
        <Row label="时区" hint="绝对时刻按此时区显示（§5.8）">
          <select
            className="rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-gray-800 dark:text-slate-100 outline-none focus:border-accent-400"
            value={config.timezone}
            onChange={(e) => save({ ...config, timezone: e.target.value })}
          >
            {TIMEZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </Row>
        {!isAndroid && <Row label="数据目录" hint={config.dataDir === "auto" ? "自动（用户数据目录）" : config.dataDir}>
          <div className="flex items-center gap-2">
            <button type="button" className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700" onClick={onPickDir}>
              选择目录…
            </button>
            <button type="button" className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700" onClick={onOpenDir}>
              打开
            </button>
            {config.dataDir !== "auto" && (
              <button type="button" className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700" onClick={() => setDataDir("auto")}>
                恢复默认
              </button>
            )}
          </div>
        </Row>}
        {<>
          <div className="rounded-lg bg-gray-50 p-3 text-xs leading-5 text-gray-500 dark:bg-slate-900/40 dark:text-slate-400">日程备份包含全部事项、长期任务、归档、模板、标签颜色和候选规则；设备凭据和运行中的计时器保留在本机。</div>
          <Row label="备份口令" hint="填写至少 8 个字符可导出加密备份；留空导出普通 JSON。恢复加密文件时填写同一口令。口令不会保存。">
            <input aria-label="备份口令" type="password" autoComplete="off" value={backupPassphrase} onChange={e=>setBackupPassphrase(e.target.value)} className="min-w-0 rounded border bg-transparent px-3 py-2 text-sm" />
          </Row>
          <Row label="日程备份" hint="使用系统文件选择器保存或恢复 JSON 备份">
            <div className="flex gap-2">
              <button type="button" disabled={exporting || importing} className="rounded border px-3 py-2 text-sm" onClick={() => void mobileBackup(false)}>{exporting ? "保存中…" : "导出备份"}</button>
              <button type="button" disabled={exporting || importing} className="rounded border px-3 py-2 text-sm" onClick={() => useAppStore.getState().askConfirm("恢复日程备份", "将覆盖本机日程数据。系统会保留恢复前副本，请先导出当前备份。", () => void mobileBackup(true))}>{importing ? "恢复中…" : "恢复备份"}</button>
            </div>
          </Row>
        </>}
        <Row label="本地恢复点" hint="同步下载或恢复备份前自动保留，最多五份；本机设置保持不变">
          <div className="flex flex-wrap gap-2">
            <select aria-label="选择恢复点" value={recoveryId} onChange={e => setRecoveryId(e.target.value)} className="min-w-0 rounded border bg-transparent px-2 py-2 text-sm">
              <option value="">{recoveryPoints.length ? "选择恢复时间…" : "暂无恢复点"}</option>
              {recoveryPoints.map(id => <option key={id} value={id}>{recoveryLabels[id] ?? new Date(Number(id.split("-")[0])).toLocaleString()}</option>)}
            </select>
            <button type="button" disabled={!recoveryId || importing} className="rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={() => useAppStore.getState().askConfirm("恢复本地日程", "将使用选中的恢复点覆盖本机日程，并保留恢复前副本。", () => {
              setImporting(true);
              void restoreRecoveryPoint(recoveryId).then(async () => { await useAppStore.getState().refresh(); setRecoveryPoints(await getRecoveryPoints()); setRecoveryId(""); pushToast("本地恢复完成"); }).catch(error => pushToast(`恢复失败：${String(error)}`)).finally(() => setImporting(false));
            })}>恢复</button>
          </div>
        </Row>
        {!isAndroid && <Row label="导出全部 JSON" hint="备份 config/events/routines/tasks/archive 到所选目录">
          <button
            type="button"
            disabled={exporting}
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            onClick={onExport}
          >
            {exporting ? "导出中…" : "导出"}
          </button>
        </Row>}
        {!isAndroid && <Row label="导入全部 JSON" hint="从所选目录恢复（校验后覆盖当前数据）">
          <button
            type="button"
            disabled={importing}
            className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50"
            onClick={onImport}
          >
            {importing ? "导入中…" : "导入"}
          </button>
        </Row>}
      </Section>

      <Section title="七牛同步">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" onClick={()=>void exportSyncDiagnostics().then(saved=>{if(saved)pushToast("脱敏诊断已导出");}).catch(error=>pushToast(String(error)))}>导出脱敏诊断</button>
          {syncStatus?.syncing && <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" onClick={()=>void syncCancel().catch(error=>pushToast(String(error)))}>取消同步</button>}
        </div>
        <p className="text-xs leading-5 text-gray-400 dark:text-slate-500">单设备互斥快照同步：启动或手动同步时下载，关键保存后延迟上传。AK、SK 和同步口令只存入当前设备的系统凭据库，不会进入导出数据或云端快照。</p>
        <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
          <label className="text-xs text-gray-500 dark:text-slate-400">Bucket<input value={syncForm.bucket} onChange={(e) => setSync("bucket", e.target.value)} placeholder="你的私有 Bucket" className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-800 outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" /></label>
          <label className="text-xs text-gray-500 dark:text-slate-400">HTTPS 下载域名<input value={syncForm.downloadDomain} onChange={(e) => setSync("downloadDomain", e.target.value)} placeholder="https://example.com" className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-800 outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" /></label>
          <label className="text-xs text-gray-500 dark:text-slate-400">对象前缀<input value={syncForm.prefix} onChange={(e) => setSync("prefix", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-800 outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" /></label>
          <label className="text-xs text-gray-500 dark:text-slate-400">本机设备名<input value={syncForm.deviceName} onChange={(e) => setSync("deviceName", e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-800 outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" /></label>
          <label className="text-xs text-gray-500 dark:text-slate-400">AccessKey<input type="password" value={syncForm.accessKey} onChange={(e) => setSync("accessKey", e.target.value)} placeholder={syncStatus?.configured ? "留空保留已保存的 AK" : "AK"} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-800 outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" /></label>
          <label className="text-xs text-gray-500 dark:text-slate-400">SecretKey<input type="password" value={syncForm.secretKey} onChange={(e) => setSync("secretKey", e.target.value)} placeholder={syncStatus?.configured ? "留空保留已保存的 SK" : "SK"} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-800 outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" /></label>
        </div>
        <label className="block pt-1 text-xs text-gray-500 dark:text-slate-400">同步口令（至少 8 位）<input type="password" value={syncForm.passphrase} onChange={(e) => setSync("passphrase", e.target.value)} placeholder={syncStatus?.configured ? "留空保留已保存的口令" : "用于 AES-256-GCM 加密快照"} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-800 outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100" /></label>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <button type="button" disabled={syncBusy} onClick={saveSync} className="rounded-lg bg-accent-600 px-3 py-1.5 text-sm text-white hover:bg-accent-700 disabled:opacity-50">保存配置</button>
          <button type="button" disabled={syncBusy || !syncStatus?.configured} onClick={() => void runSync(true)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200">测试连接</button>
          <button type="button" disabled={syncBusy || !syncStatus?.configured} onClick={() => void runSync()} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200">立即同步</button>
          {syncStatus?.configured && <button type="button" disabled={syncBusy} onClick={() => void syncDisconnect().then(() => { setSyncStatus(null); pushToast("已断开本机七牛同步，远端快照未删除"); })} className="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50">断开本机</button>}
        </div>
        {syncStatus?.configured && <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-500 dark:bg-slate-900/40 dark:text-slate-400">设备：{syncStatus.deviceName} · 远端版本：{syncStatus.revision} · {syncStatus.dirty ? "存在待上传修改" : "已同步"}{syncStatus.lastSyncAt ? ` · 最近：${new Date(syncStatus.lastSyncAt).toLocaleString()}` : ""}{syncStatus.lockedBy ? <div className="mt-1 text-amber-600">当前被设备「{syncStatus.lockedBy}」占用，请在对方退出或租约过期后再同步。</div> : null}{syncStatus.lastError ? <div className="mt-1 text-red-500">{syncStatus.lastError}</div> : null}</div>}
        {syncStatus?.lockedBy && syncStatus.lastError?.includes("租约已过期") && <button type="button" disabled={syncBusy} onClick={async () => { setSyncBusy(true); try { setSyncStatus(await syncTakeoverExpired()); pushToast("已接管过期设备锁"); } catch (e) { pushToast(`接管失败：${String(e)}`); } finally { setSyncBusy(false); } }} className="rounded border border-amber-300 px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50">确认接管过期锁</button>}
        {(syncStatus?.needsInitialChoice || syncStatus?.lastError?.includes("远端版本")) && <div className="flex flex-wrap gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><span className="basis-full">本地与远端需要确认处理方式。覆盖前会保留备份，系统不会自动合并。</span><button type="button" onClick={() => void chooseInitial("upload")} className="rounded bg-amber-700 px-2 py-1 text-white">上传本地覆盖远端</button><button type="button" onClick={() => void chooseInitial("download")} className="rounded border border-amber-300 px-2 py-1">下载远端覆盖本地</button><button type="button" onClick={() => void chooseInitial("cancel")} className="rounded border border-amber-300 px-2 py-1">取消</button></div>}
      </Section>

      <Section title="标签管理">
        {tags.length === 0 ? (
          <div className="text-sm text-gray-400 dark:text-slate-500">暂无标签（在事件/日常/浮动事项中填写标签后出现）</div>
        ) : (
          <div className="flex flex-col gap-2">
            {tags.map((t) => (
              <TagRow
                key={t.tag}
                tag={t.tag}
                count={t.count}
                color={t.color}
                onRename={(n) => renameTag(t.tag, n)}
                onDelete={() => deleteTag(t.tag)}
                onSetColor={(token) => save({ ...config, tagColors: { ...config.tagColors, [t.tag]: token } })}
                onClearColor={() => {
                  const next = { ...config.tagColors };
                  delete next[t.tag];
                  save({ ...config, tagColors: next });
                }}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function TagRow({
  tag,
  count,
  color,
  onRename,
  onDelete,
  onSetColor,
  onClearColor,
}: {
  tag: string;
  count: number;
  color: string | null;
  onRename: (n: string) => void;
  onDelete: () => void;
  onSetColor: (token: string) => void;
  onClearColor: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(tag);
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className={`rounded border px-2 py-0.5 text-xs ${tagChipClasses(color)}`}>#{tag}</span>
      <span className="text-xs text-gray-400 dark:text-slate-500">({count})</span>
      {editing ? (
        <input
          autoFocus
          className="rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-0.5 text-xs text-gray-800 dark:text-slate-100 outline-none"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            setEditing(false);
            const n = val.trim();
            if (n && n !== tag) onRename(n);
            else setVal(tag);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <button type="button" className="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600" onClick={() => setEditing(true)}>
          重命名
        </button>
      )}
      {/* V3.1 U4：标签颜色选择器。 */}
      <div className="relative">
        <button
          type="button"
          className="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600"
          onClick={() => setPaletteOpen(!paletteOpen)}
        >
          颜色
        </button>
        {paletteOpen && (
          <div className="absolute bottom-8 left-0 z-20 w-40 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-2 shadow-xl">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-gray-400 dark:text-slate-500">选择颜色</span>
              <button type="button" className="text-xs text-gray-400 hover:text-gray-600" onClick={onClearColor}>
                清除
              </button>
            </div>
            <div className="grid grid-cols-5 gap-1">
              {TAG_COLOR_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  title={token}
                  className={`h-6 w-6 rounded-full border border-gray-200 dark:border-slate-600 ${tagBarClasses(token)} ${
                    color === token ? "ring-2 ring-accent-500 ring-offset-1" : ""
                  }`}
                  onClick={() => {
                    onSetColor(token);
                    setPaletteOpen(false);
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <button type="button" className="ml-auto text-xs text-red-400 hover:text-red-600" onClick={onDelete}>
        删除
      </button>
    </div>
  );
}
