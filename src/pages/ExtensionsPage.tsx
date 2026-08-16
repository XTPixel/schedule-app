// 扩展页：事项模板 · 脚本钩子。
// Git 一键备份与移动端只读功能已按用户要求完全移除。
// 交互遵循 §7.5：行内编辑、非模态、危险确认才弹窗；V3.1 起抽屉改为显式保存（不涉及本页）。
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api/ipc";
import { useAppStore, withExternalConflict } from "../store/useAppStore";
import { TagInput } from "../components/TagInput";
import { todayInTz } from "../lib/time";
import type {
  HooksStatus,
  Template,
  TemplateItem,
  TemplateKind,
  TemplatePreview,
} from "../types";

type Tab = "template" | "hooks";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 shadow-sm">
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

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
      {children}
    </div>
  );
}

const inputCls =
  "rounded-lg border border-gray-200 dark:border-slate-600 px-2 py-1.5 text-sm outline-none focus:border-accent-400 bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-100";
const btnCls =
  "rounded-lg border border-gray-200 dark:border-slate-600 px-3 py-1.5 text-sm text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50";
const primaryCls =
  "rounded-lg bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50";

export function ExtensionsPage() {
  const [tab, setTab] = useState<Tab>("template");
  const tabs: { key: Tab; label: string }[] = [
    { key: "template", label: "事项模板" },
    { key: "hooks", label: "脚本钩子" },
  ];
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-xl font-bold text-gray-900 dark:text-slate-100">扩展</h1>
      <p className="mb-5 text-xs text-gray-400 dark:text-slate-500">
        事项模板与脚本钩子均为可选项；脚本执行有明确风险提示，默认关闭。
      </p>
      <div className="mb-5 flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              tab === t.key
                ? "bg-accent-500 text-white"
                : "bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 border border-gray-200 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* 全部页签保持挂载，切换不重置状态。 */}
      <div className={tab === "template" ? "" : "hidden"}>
        <TemplateTab />
      </div>
      <div className={tab === "hooks" ? "" : "hidden"}>
        <HooksTab />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 事项模板
// ---------------------------------------------------------------------------

function TemplateTab() {
  const pushToast = useAppStore((s) => s.pushToast);
  const refresh = useAppStore((s) => s.refresh);
  const tz = useAppStore((s) => s.data?.config.timezone ?? "Asia/Shanghai");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [applyDate, setApplyDate] = useState(() => todayInTz(tz));
  const [preview, setPreview] = useState<{ id: string; data: TemplatePreview } | null>(null);

  async function load() {
    setTemplates(await api.listTemplates().catch(() => [] as Template[]));
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = useMemo(() => templates.filter((t) => !t.deletedAt), [templates]);

  async function onCreate(kind: TemplateKind) {
    const t = await api.makeTemplateDefault(kind);
    const saved = await withExternalConflict(() => api.saveTemplate(t));
    if (!saved) {
      await load();
      return;
    }
    setTemplates((prev) => [...prev, saved]);
    setEditingId(saved.id);
  }

  async function onDelete(t: Template) {
    const r = await withExternalConflict(() => api.deleteTemplate(t.id));
    if (r === null) {
      await load();
      return;
    }
    pushToast(`已删除模板「${t.name || "未命名"}」`);
    setTemplates((prev) => prev.filter((x) => x.id !== t.id));
    if (editingId === t.id) setEditingId(null);
  }

  async function onSave(t: Template) {
    const saved = await withExternalConflict(() => api.saveTemplate(t));
    if (!saved) {
      await load();
      return;
    }
    setTemplates((prev) => {
      const i = prev.findIndex((x) => x.id === saved.id);
      if (i < 0) return [...prev, saved];
      const next = [...prev];
      next[i] = saved;
      return next;
    });
  }

  async function onPreview(t: Template) {
    try {
      const data = await api.previewTemplate(t.id, applyDate);
      setPreview({ id: t.id, data });
    } catch (e) {
      pushToast(`预览失败：${String(e)}`);
    }
  }

  async function onApply(t: Template) {
    try {
      const r = await withExternalConflict(() => api.applyTemplate(t.id, applyDate));
      if (r === null) return;
      pushToast(`已生成：事件 ${r.eventsCreated}、日常 ${r.routinesCreated}`);
      setPreview(null);
      await refresh();
    } catch (e) {
      pushToast(`应用模板失败：${String(e)}`);
    }
  }

  return (
    <div className="space-y-5">
      <Section title="模板列表">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnCls} onClick={() => onCreate("workday")}>
            新建工作日模板
          </button>
          <button type="button" className={btnCls} onClick={() => onCreate("weekend")}>
            新建周末模板
          </button>
          <button type="button" className={btnCls} onClick={() => onCreate("custom")}>
            新建自定义模板
          </button>
        </div>
        {active.length === 0 ? (
          <div className="text-sm text-gray-400 dark:text-slate-500">暂无模板。</div>
        ) : (
          <div className="space-y-2">
            {active.map((t) => (
              <div key={t.id} className="rounded-lg border border-gray-100 dark:border-slate-700 p-3">
                <div className="flex items-center gap-2">
                  <input
                    className={`${inputCls} flex-1`}
                    defaultValue={t.name}
                    placeholder="模板名称"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== t.name) onSave({ ...t, name: v });
                    }}
                  />
                  <span className="rounded bg-gray-100 dark:bg-slate-700 px-2 py-0.5 text-xs text-gray-600 dark:text-slate-300">
                    {t.kind === "workday" ? "工作日" : t.kind === "weekend" ? "周末" : "自定义"}
                  </span>
                  <button type="button" className={btnCls} onClick={() => setEditingId(editingId === t.id ? null : t.id)}>
                    {editingId === t.id ? "收起" : "编辑"}
                  </button>
                  <button type="button" className="text-xs text-red-400 hover:text-red-600" onClick={() => onDelete(t)}>
                    删除
                  </button>
                </div>
                {editingId === t.id && (
                  <TemplateEditor template={t} onChange={(next) => onSave(next)} />
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="应用模板">
        <Row label="目标日期" hint="模板将按此日期批量生成事件/日常">
          <input
            type="date"
            className={inputCls}
            value={applyDate}
            onChange={(e) => setApplyDate(e.target.value)}
          />
        </Row>
        {active.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {active.map((t) => (
              <button key={t.id} type="button" className={btnCls} onClick={() => onPreview(t)}>
                预览「{t.name || "未命名"}」
              </button>
            ))}
          </div>
        )}
        {preview && (
          <div className="rounded-lg border border-gray-100 dark:border-slate-700 p-3">
            <div className="mb-2 text-sm font-medium text-gray-700 dark:text-slate-200">
              预览：将生成 {preview.data.events.length} 个事件、{preview.data.routines.length} 个日常
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto text-sm text-gray-600 dark:text-slate-300">
              {preview.data.events.map((e, i) => (
                <div key={`e${i}`}>◷ {e.title || "(无标题)"} · {e.start}</div>
              ))}
              {preview.data.routines.map((r, i) => (
                <div key={`r${i}`}>↻ {r.title || "(无标题)"}</div>
              ))}
              {preview.data.events.length === 0 && preview.data.routines.length === 0 && (
                <div className="text-gray-400 dark:text-slate-500">该模板没有可生成的有效条目。</div>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={primaryCls}
                onClick={() => {
                  const t = active.find((x) => x.id === preview.id);
                  if (t) onApply(t);
                }}
              >
                确认生成
              </button>
              <button type="button" className={btnCls} onClick={() => setPreview(null)}>
                取消
              </button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function TemplateEditor({ template, onChange }: { template: Template; onChange: (t: Template) => void }) {
  // 本地草稿：编辑过程中仅改草稿，失焦/结构性操作时才提交（§7.5 失焦自动保存）。
  // 编辑器随 editingId 条件挂载/卸载，useState 初始值即当前模板，无需跟随 prop 重同步。
  const [draft, setDraft] = useState<Template>(template);
  // 同步维护最新草稿引用，避免 blur 回调闭包读到旧 draft 覆盖刚输入的内容。
  const draftRef = useRef<Template>(draft);

  function commit(next: Template) {
    draftRef.current = next;
    setDraft(next);
    onChange(next);
  }
  /** 把当前本地草稿提交给父组件（用于失焦保存）。 */
  function commitDraft() {
    onChange(draftRef.current);
  }
  function patchItem(i: number, patch: Partial<TemplateItem>) {
    const next: Template = {
      ...draftRef.current,
      items: draftRef.current.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)),
    };
    draftRef.current = next;
    setDraft(next);
  }
  function patchItemCommit(i: number, patch: Partial<TemplateItem>) {
    const next: Template = {
      ...draftRef.current,
      items: draftRef.current.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)),
    };
    commit(next);
  }
  function addItem() {
    const item: TemplateItem = {
      kind: "event",
      title: "",
      description: null,
      tags: [],
      priority: "normal",
      allDay: false,
      startTime: "09:00",
      endTime: null,
      durationMinutes: 60,
      daysOfWeek: [],
      windowStart: "08:00",
      windowEnd: "09:00",
    };
    commit({ ...draftRef.current, items: [...draftRef.current.items, item] });
  }
  function removeItem(i: number) {
    commit({ ...draftRef.current, items: draftRef.current.items.filter((_, idx) => idx !== i) });
  }
  return (
    <div className="mt-3 space-y-2 border-t border-gray-100 dark:border-slate-700 pt-3">
      {draft.items.map((it, i) => (
        <div key={i} className="space-y-1 rounded bg-gray-50 dark:bg-slate-700/40 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={inputCls}
              value={it.kind}
              onChange={(e) => patchItemCommit(i, { kind: e.target.value as "event" | "routine" })}
            >
              <option value="event">事件</option>
              <option value="routine">日常</option>
            </select>
            <input
              className={`${inputCls} flex-1 min-w-40`}
              value={it.title}
              placeholder="标题"
              onChange={(e) => patchItem(i, { title: e.target.value })}
              onBlur={commitDraft}
            />
            <select
              className={inputCls}
              value={it.priority}
              onChange={(e) => patchItemCommit(i, { priority: e.target.value as "high" | "normal" | "low" })}
            >
              <option value="high">高</option>
              <option value="normal">中</option>
              <option value="low">低</option>
            </select>
            <button type="button" className="text-xs text-red-400 hover:text-red-600" onClick={() => removeItem(i)}>
              删除
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TagInput
              value={it.tags}
              onChange={(tags) => patchItem(i, { tags })}
              onBlur={commitDraft}
            />
            {it.kind === "event" ? (
              <>
                <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={it.allDay}
                    onChange={(e) => patchItemCommit(i, { allDay: e.target.checked })}
                  />
                  全天
                </label>
                {!it.allDay && (
                  <>
                    <input
                      type="time"
                      className={inputCls}
                      value={it.startTime ?? "09:00"}
                      onChange={(e) => patchItem(i, { startTime: e.target.value })}
                      onBlur={commitDraft}
                    />
                    <span className="text-gray-400">–</span>
                    <input
                      type="time"
                      className={inputCls}
                      value={it.endTime ?? ""}
                      onChange={(e) => patchItem(i, { endTime: e.target.value || null })}
                      onBlur={commitDraft}
                    />
                  </>
                )}
              </>
            ) : (
              <>
                <input
                  type="time"
                  className={inputCls}
                  value={it.windowStart ?? "08:00"}
                  onChange={(e) => patchItem(i, { windowStart: e.target.value })}
                  onBlur={commitDraft}
                />
                <span className="text-gray-400">–</span>
                <input
                  type="time"
                  className={inputCls}
                  value={it.windowEnd ?? "09:00"}
                  onChange={(e) => patchItem(i, { windowEnd: e.target.value })}
                  onBlur={commitDraft}
                />
              </>
            )}
            <input
              type="number"
              min={0}
              className={`${inputCls} w-24`}
              value={it.durationMinutes ?? ""}
              placeholder="分钟"
              onChange={(e) => patchItem(i, { durationMinutes: Number(e.target.value) || null })}
              onBlur={commitDraft}
            />
          </div>
        </div>
      ))}
      <button type="button" className={btnCls} onClick={addItem}>
        + 添加条目
      </button>
      <p className="text-xs text-gray-400 dark:text-slate-500">
        模板仅作为生成源；生成后的事件/日常与模板解除绑定，修改模板不影响已生成事项。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 脚本钩子
// ---------------------------------------------------------------------------

function HooksTab() {
  const config = useAppStore((s) => s.data?.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const [status, setStatus] = useState<HooksStatus | null>(null);

  useEffect(() => {
    void api.hooksStatus().then(setStatus).catch(() => setStatus(null));
  }, [config?.hooks.enabled]);

  if (!config) return null;
  const cfg = config;
  const hooks = cfg.hooks;
  function save(enabled: boolean) {
    void saveConfig({ ...cfg, hooks: { enabled } });
  }

  return (
    <div className="space-y-5">
      <Warn>
        脚本安全警告：启用后，本机将执行数据目录 <code>hooks/*.js</code> 中的用户脚本（受限解释器，无文件系统/网络能力，单脚本限时 2 秒）。
        请仅放入你信任的脚本；恶意脚本可能窃取被传入的只读数据（如标题/时间/归档内容）。默认关闭。
      </Warn>
      <Section title="开关">
        <Row label="启用脚本钩子" hint="读取数据目录 hooks/*.js，在生命周期事件时调用（默认关闭）">
          <Toggle checked={hooks.enabled} onChange={save} />
        </Row>
        <Row label="支持的生命周期钩子">
          <div className="text-sm text-gray-600 dark:text-slate-300">
            {status ? status.supportedHooks.join(" · ") : "—"}
          </div>
        </Row>
        <Row label="脚本目录">
          <div className="max-w-md truncate text-sm text-gray-500 dark:text-slate-400">
            {status?.directory ?? "—"}
          </div>
        </Row>
      </Section>
      <Section title="脚本列表">
        {!status || status.scripts.length === 0 ? (
          <div className="text-sm text-gray-400 dark:text-slate-500">
            暂无脚本。将 <code>*.js</code> 文件放入上述 hooks 目录后刷新查看。
          </div>
        ) : (
          <div className="space-y-2">
            {status.scripts.map((s) => (
              <div key={s.file} className="rounded-lg border border-gray-100 dark:border-slate-700 p-2 text-sm">
                <div className="font-medium text-gray-700 dark:text-slate-200">{s.file}</div>
                {s.error ? (
                  <div className="text-xs text-red-400">错误：{s.error}</div>
                ) : (
                  <div className="text-xs text-gray-500 dark:text-slate-400">
                    声明钩子：{s.functions.length ? s.functions.join(" · ") : "（无）"}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <HookTestPanel enabled={hooks.enabled} hooks={status?.supportedHooks ?? []} />
    </div>
  );
}

function HookTestPanel({ enabled, hooks }: { enabled: boolean; hooks: string[] }) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [hook, setHook] = useState(hooks[0] ?? "");
  const [payload, setPayload] = useState("{}");
  const [results, setResults] = useState<{ file: string; output: string | null; error: string | null }[] | null>(null);

  async function run() {
    if (!enabled) {
      pushToast("请先开启脚本钩子");
      return;
    }
    try {
      const r = await api.runHookTest(hook, payload);
      setResults(r);
    } catch (e) {
      pushToast(`测试失败：${String(e)}`);
      setResults(null);
    }
  }

  return (
    <Section title="测试钩子">
      <Row label="钩子名称">
        <select className={inputCls} value={hook} onChange={(e) => setHook(e.target.value)}>
          {hooks.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </Row>
      <Row label="入参（只读 JSON）">
        <textarea
          className={`${inputCls} w-full font-mono text-xs`}
          rows={4}
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
        />
      </Row>
      <div className="flex gap-2">
        <button type="button" className={primaryCls} onClick={run} disabled={!enabled}>
          运行
        </button>
        {!enabled && <span className="text-xs text-gray-400 dark:text-slate-500">需先开启钩子</span>}
      </div>
      {results && (
        <div className="space-y-1 text-sm">
          {results.length === 0 ? (
            <div className="text-gray-400 dark:text-slate-500">没有脚本声明该钩子。</div>
          ) : (
            results.map((r, i) => (
              <div key={i} className="rounded border border-gray-100 dark:border-slate-700 p-2 text-xs">
                <div className="text-gray-600 dark:text-slate-300">{r.file}</div>
                {r.error ? (
                  <div className="text-red-400">错误：{r.error}</div>
                ) : (
                  <div className="whitespace-pre-wrap text-gray-500 dark:text-slate-400">输出：{r.output ?? ""}</div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </Section>
  );
}
