import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { TimeField } from "../components/TimeField";
import { pickDirectory, openDataDir } from "../api/ipc";
import { TAG_COLOR_TOKENS, tagBarClasses, tagChipClasses } from "../lib/tagColor";
import type { Config, NotifyLevel } from "../types";

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
    <div className="flex items-center justify-between gap-4">
      <div>
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
  // V3.1 T4：数字输入 300ms 防抖后保存，避免逐字符触发配置应用线程。
  const [graceDraft, setGraceDraft] = useState<number | null>(null);
  const graceTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void loadTags();
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
      pushToast(`已导入：事件 ${r.events}、日常 ${r.routines}、浮动 ${r.tasks}、归档 ${r.archiveMonths} 个月`);
    } catch (e) {
      pushToast(`导入失败：${String(e)}`);
    } finally {
      setImporting(false);
    }
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
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
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

      <Section title="行为">
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
      </Section>

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
        <Row label="数据目录" hint={config.dataDir === "auto" ? "自动（用户数据目录）" : config.dataDir}>
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
        </Row>
        <Row label="导出全部 JSON" hint="备份 config/events/routines/tasks/archive 到所选目录">
          <button
            type="button"
            disabled={exporting}
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            onClick={onExport}
          >
            {exporting ? "导出中…" : "导出"}
          </button>
        </Row>
        <Row label="导入全部 JSON" hint="从所选目录恢复（校验后覆盖当前数据）">
          <button
            type="button"
            disabled={importing}
            className="rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50"
            onClick={onImport}
          >
            {importing ? "导入中…" : "导入"}
          </button>
        </Row>
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
