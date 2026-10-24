import { canEdit } from "../lib/editing";
// 全局状态：数据 + UI（页面/抽屉/Toast/危险确认），封装全部 IPC 调用。
import { create } from "zustand";
import * as api from "../api/ipc";
import {
  nowIso,
  fmtDate,
  buildLocalIso,
  nowPlusOneHourLocal,
  todayInTz,
  nowHhmmInTz,
} from "../lib/time";
import type {
  AppData,
  ArchiveDay,
  ArchiveEntry,
  CalendarData,
  CandidateSource,
  CandidatesResult,
  Config,
  Event,
  ImportResult,
  LongTask,
  LongTaskSession,
  ReviewResult,
  Routine,
  SearchQuery,
  SearchResult,
  StatsResult,
  TagInfo,
  Task,
  TimerSourceType,
} from "../types";

export type Page =
  | "now"
  | "calendar"
  | "events"
  | "routines"
  | "tasks"
  | "longtasks"
  | "search"
  | "archive"
  | "stats"
  | "settings"
  | "extensions";
export type DrawerKind = "event" | "routine" | "task" | "longtask";
export type DraftEntity = Event | Routine | Task | LongTask;

/** V1.2.2：删除归档条目的结果（区分成功 / 外部冲突取消）。 */
export interface RemoveArchiveEntryResult {
  status: "success" | "cancelled";
  sessionIds: string[];
}

export interface Toast {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ConfirmState {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** 取消按钮的额外回调（V3.1 外部修改冲突的「重新加载」路径）。 */
  onCancel?: () => void;
}

export interface DrawerState {
  kind: DrawerKind;
  draft: DraftEntity;
  isNew: boolean;
  /** 打开抽屉时的初始快照，用于「有未保存改动」判断（V3.1 U5）。 */
  initial: DraftEntity;
}

/** V3.0 F1：事项计时器状态（单计时器，localStorage 持久化）。 */
export interface TimerState {
  sourceType: TimerSourceType;
  title: string;
  startedAt: number; // 本次开始/继续的 epoch 毫秒
  accumulatedMs: number; // 本次开始前累计毫秒
  running: boolean;
  /** V1.2：长期任务本次会话首次开始时间戳（继续/暂停不覆盖）。 */
  sessionStartedAt?: number;
  /** V1.2.1：终止落库的幂等键；写入失败重试时复用，成功后随计时一并清除。 */
  sessionId?: string;
}

interface SnoozeEntry {
  until: string; // ISO 时刻
  title: string;
  /** V3.1 T11：写入时的本地日期；稍后集合改为单一 key 存储，跨天不丢。 */
  day: string;
}

const TIMER_KEY = "schedule.timers.v1";
const TIMER_CHECKPOINT_KEY = "schedule.timers.checkpoint.v2";
const SN_KEY = "schedule.snoozed.v1";
const skKey = (date: string) => `schedule.skipped.${date}`;

function localDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD + n 天（纯日期，避免时区偏移）。 */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** V1.2.1：前端生成的会话幂等键。 */
function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    if (key === TIMER_KEY) localStorage.setItem(TIMER_CHECKPOINT_KEY, JSON.stringify({ updatedAt: Date.now(), timers: value }));
  } catch {
    /* 忽略持久化失败 */
  }
}

function computeHidden(skipped: Set<string>, snoozed: Record<string, SnoozeEntry>): Set<string> {
  const hidden = new Set(skipped);
  const now = Date.now();
  for (const [id, v] of Object.entries(snoozed)) {
    if (new Date(v.until).getTime() > now) hidden.add(id);
  }
  return hidden;
}

// ---------------------------------------------------------------------------
// V3.1 T3：外部修改冲突（EXTERNAL_CHANGE:<file>）统一拦截与用户选择。
// ---------------------------------------------------------------------------

function externalConflictFile(e: unknown): string | null {
  const m = /^EXTERNAL_CHANGE:(.+)$/.exec(String(e));
  return m ? m[1] : null;
}

/** 弹「重新加载 / 覆盖」确认框；overwrite 后重试原操作，reload 后刷新并返回 null。 */
function promptExternalConflict<T>(file: string, op: () => Promise<T>): Promise<T | null> {
  return new Promise((resolve, reject) => {
    useAppStore.getState().askConfirm(
      "数据文件被外部修改",
      `数据文件 ${file} 在应用之外被修改（如网盘同步/其他进程）。请选择处理方式：`,
      async () => {
        try {
          await api.resolveExternalChange("overwrite");
          resolve(await op());
        } catch (e) {
          reject(e);
        }
      },
      async () => {
        try {
          await api.resolveExternalChange("reload");
          await useAppStore.getState().refresh();
          resolve(null);
        } catch (e) {
          reject(e);
        }
      },
      "覆盖外部改动",
      "重新加载（放弃本地修改）",
    );
  });
}

/** 拦截写入类 IPC 的结构化外部修改错误；返回 null 表示用户选择重载并放弃本次写入。 */
export async function withExternalConflict<T>(op: () => Promise<T>): Promise<T | null> {
  try {
    return await op();
  } catch (e) {
    const file = externalConflictFile(e);
    if (!file) throw e;
    return promptExternalConflict(file, op);
  }
}

let toastSeq = 0;
function nextId(): string {
  toastSeq += 1;
  return `t${Date.now()}_${toastSeq}`;
}

// BUG-20：外部修改冲突可能并发触发；确认框改为排队，逐一出栈，不吞掉先发起的操作。
let confirmQueue: ConfirmState[] = [];
function presentNextConfirm() {
  const next = confirmQueue.shift();
  useAppStore.setState({ confirm: next ?? null });
}

interface AppStore {
  data: AppData | null;
  candidates: CandidatesResult | null;
  loading: boolean;
  error: string | null;

  page: Page;
  drawer: DrawerState | null;
  /** V3.1 U5：抽屉保存中标记（禁用保存按钮，防重复提交）。 */
  savingDrawer: boolean;
  toasts: Toast[];
  confirm: ConfirmState | null;
  /** 客户端「跳过/稍后」隐藏的候选 sourceId 集合（当日有效，由 skipped ∪ snoozed 派生）。 */
  hiddenCandidates: Set<string>;
  /** V3.0 F2：当日跳过集合（持久化，跨天失效）。 */
  skipped: Set<string>;
  /** V3.0 F2：稍后集合 sourceId → { until, title }（持久化，跨天失效）。 */
  snoozed: Record<string, SnoozeEntry>;
  /** V3.0 F1：计时器（sourceId → 状态，持久化，单计时器）。 */
  timers: Record<string, TimerState>;
  /** 托盘「快速新增」触发信号（自增，驱动首页快录框聚焦）。 */
  quickAddTick: number;

  // Phase 1 / Phase 2 状态。
  calendar: CalendarData | null;
  searchResults: SearchResult | null;
  stats: StatsResult | null;
  /** V1.2.2：最近一次统计范围（归档变化后按此范围自动刷新统计）。 */
  statsDays: number;
  review: ReviewResult | null;
  tags: TagInfo[];
  /** 标签列表是否已完成首次加载（供过滤条清理失效的持久化标签筛选）。 */
  tagsLoaded: boolean;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  setPage: (p: Page) => void;

  openDrawer: (kind: DrawerKind, obj: DraftEntity | null) => void;
  updateDraft: (patch: Partial<DraftEntity>) => void;
  /** 仅落盘草稿（不关闭），成功返回 true；供 saveDraftAndClose 与既有调用方使用。 */
  saveDraft: () => Promise<boolean>;
  /** V3.1 U5：校验必填 → 保存 → 成功后关闭并 Toast；失败留在抽屉。 */
  saveDraftAndClose: () => Promise<void>;
  /** V3.1 U5：✕ / 取消的统一入口：有未保存改动先确认，无改动直接关闭。 */
  requestCloseDrawer: () => void;
  closeDrawer: () => void;
  /** V1.2：会话变更后，用最新 data 同步长期任务抽屉草稿。 */
  syncLongTaskDrawer: (taskId: string) => void;

  pushToast: (message: string, actionLabel?: string, onAction?: () => void) => void;
  dismissToast: (id: string) => void;
  askConfirm: (
    title: string,
    message: string,
    onConfirm: () => void,
    onCancel?: () => void,
    confirmLabel?: string,
    cancelLabel?: string,
  ) => void;
  closeConfirm: () => void;

  triggerQuickAdd: () => void;

  // V3.0 F1：计时器动作。
  startTimer: (sourceType: CandidateSource, sourceId: string, title: string) => void;
  toggleTimer: (sourceType: CandidateSource, sourceId: string, title: string) => void;
  pauseTimer: (sourceId: string) => void;
  checkpointTimers: () => void;
  timerElapsedMs: (sourceId: string) => number;
  /** V1.2：长期任务计时（单计时器互斥；写入 sessionStartedAt）。 */
  startLongTaskTimer: (task: LongTask) => void;
  toggleLongTaskTimer: (task: LongTask) => void;
  /** V1.2：终止本次投入 → 落库会话 + 清计时 + 撤回 Toast；失败保留计时。 */
  terminateLongTaskSession: (task: LongTask) => Promise<LongTaskSession | null>;
  /** V1.2：丢弃任务计时状态（删除任务时调用；不记录会话）。 */
  dropTimer: (sourceId: string) => void;

  // V3.0 F2：跳过/稍后（含撤回）。
  skipCandidate: (id: string) => void;
  undoSkipped: (id: string) => void;
  snoozeCandidate: (id: string, title: string, minutes: number) => void;
  undoSnoozed: (id: string) => void;
  checkSnoozes: () => void;

  saveEvent: (e: Event) => Promise<Event>;
  deleteEvent: (id: string) => Promise<void>;
  saveRoutine: (r: Routine) => Promise<Routine>;
  deleteRoutine: (id: string) => Promise<void>;
  saveTask: (t: Task) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  updateTaskOrder: (orderedIds: string[]) => Promise<void>;

  // V1.2：长期任务。
  saveLongTask: (t: LongTask) => Promise<LongTask>;
  deleteLongTask: (id: string) => Promise<void>;
  endLongTask: (t: LongTask) => Promise<void>;
  updateLongTaskSessionNote: (taskId: string, sessionId: string, note: string | null) => Promise<void>;
  deleteLongTaskSession: (taskId: string, sessionId: string) => Promise<void>;
  undeleteLongTaskSession: (taskId: string, sessionId: string) => Promise<void>;

  completeCandidate: (
    sourceType: CandidateSource,
    sourceId: string,
    seriesId: string | null,
    title: string,
    suggestedDurationMinutes: number | null,
  ) => Promise<void>;

  addManualArchive: (title: string, time: string, note: string, date: string) => Promise<void>;
  updateArchiveDay: (date: string, day: ArchiveDay) => Promise<void>;
  /** V1.2.2：删除归档条目；返回成功/取消与 longtask 会话 ids（供撤回）。 */
  removeArchiveEntry: (date: string, entry: ArchiveEntry) => Promise<RemoveArchiveEntryResult>;

  saveConfig: (c: Config) => Promise<void>;

  // Phase 1 / Phase 2 动作。
  loadCalendar: (start: string, end: string) => Promise<void>;
  doSearch: (q: SearchQuery) => Promise<void>;
  clearSearch: () => void;
  loadStats: (days: number) => Promise<void>;
  /** V1.2.2：若统计页已加载，归档 / 会话变化后按最近范围重新拉取统计。 */
  refreshStatsIfLoaded: () => Promise<void>;
  loadReview: (from: string, to: string) => Promise<void>;
  loadTags: () => Promise<void>;
  renameTag: (oldName: string, newName: string) => Promise<void>;
  deleteTag: (tag: string) => Promise<void>;
  setDataDir: (path: string) => Promise<void>;
  exportData: (destDir: string) => Promise<string[]>;
  importData: (srcDir: string) => Promise<ImportResult>;
}

function setError(msg: string) {
  // 供内部捕获错误：写入顶层 error 并抛 toast。
  const s = useAppStore.getState();
  s.error = msg;
  s.pushToast(msg);
}

// 初始持久化状态（localStorage 当日有效；跨日由 key 带日期自然失效）。
const _timerCheckpoint = loadJSON<{updatedAt:number;timers:Record<string, TimerState>} | null>(TIMER_CHECKPOINT_KEY, null);
const _initTimers = _timerCheckpoint?.timers ?? loadJSON<Record<string, TimerState>>(TIMER_KEY, {});
let _restoredRunningTimer = false;
for (const t of Object.values(_initTimers)) {
  // 重启后恢复为「暂停」态，保留累计时长（不把关闭期间的时长误算进去）。
  if (t.running) {
    t.running = false;
    t.startedAt = 0;
    _restoredRunningTimer = true;
  }
}
// Startup normalization must not make an older WebView checkpoint appear newer
// than the native, fsynced snapshot captured immediately before a normal exit.
if (_restoredRunningTimer) localStorage.setItem(TIMER_KEY, JSON.stringify(_initTimers));
const _initSkipped = new Set(loadJSON<string[]>(skKey(localDateKey()), []));
// V3.1 T11：稍后集合改为单一 key（含 day 字段），跨零点到期的条目不丢失。
const _initSnoozed = loadJSON<Record<string, SnoozeEntry>>(SN_KEY, {});
// 当前「天」键，用于跨天自动清理跳过。
let _currentDayKey = localDateKey();

export const useAppStore = create<AppStore>((set, get) => ({
  data: null,
  candidates: null,
  loading: false,
  error: null,

  page: "now",
  drawer: null,
  savingDrawer: false,
  toasts: [],
  confirm: null,
  hiddenCandidates: computeHidden(_initSkipped, _initSnoozed),
  skipped: _initSkipped,
  snoozed: _initSnoozed,
  timers: _initTimers,
  quickAddTick: 0,

  calendar: null,
  searchResults: null,
  stats: null,
  statsDays: 30,
  review: null,
  tags: [],
  tagsLoaded: false,

  async init() {
    set({ loading: true });
    try {
      try {
        const exitDraft = await api.loadLocalTimerExit();
        const checkpoint = loadJSON<{updatedAt:number} | null>(TIMER_CHECKPOINT_KEY, null);
        if (exitDraft && exitDraft.updatedAt > (checkpoint?.updatedAt ?? 0)) {
          const timers = exitDraft.timers as Record<string, TimerState>;
          set({ timers });
          saveJSON(TIMER_KEY, timers);
        }
      } catch (error) { get().pushToast(`退出计时草稿读取失败：${String(error)}`); }
      const data = await api.loadAllData();
      const candidates = await api.getNowCandidates(nowIso());
      set({ data, candidates, loading: false, error: null });
    } catch (e) {
      set({ loading: false });
      setError(`加载失败：${String(e)}`);
    }
  },

  async refresh() {
    try {
      const data = await api.loadAllData();
      const candidates = await api.getNowCandidates(nowIso());
      set({ data, candidates, error: null });
    } catch (e) {
      setError(`刷新失败：${String(e)}`);
    }
  },

  setPage(p) {
    set({ page: p });
  },

  openDrawer(kind, obj) {
    const tz = get().data?.config.timezone ?? "Asia/Shanghai";
    if (obj) {
      set({ drawer: { kind, draft: structuredClone(obj), isNew: false, initial: structuredClone(obj) } });
      return;
    }
    // 新建草稿（不解析自然语言，默认当前时间 +1 小时，§7.5 兜底）。
    const todayDate = todayInTz(tz);
    const nowLocal = nowHhmmInTz(tz);
    const startTime = nowPlusOneHourLocal(todayDate, nowLocal, tz);
    let draft: DraftEntity;
    if (kind === "event") {
      draft = {
        id: "",
        title: "",
        description: null,
        start: buildLocalIso(todayDate, startTime, tz),
        end: buildLocalIso(todayDate, nowPlusOneHourLocal(todayDate, startTime, tz), tz),
        allDay: false,
        reminders: [],
        repeat: null,
        tags: [],
        priority: "normal",
        status: "active",
        createdAt: "",
        updatedAt: "",
        completedAt: null,
        deletedAt: null,
      };
    } else if (kind === "routine") {
      draft = {
        id: "",
        title: "",
        description: null,
        timeWindows: [{ daysOfWeek: [], start: "08:00", end: "09:00", everyDays: null, anchorDate: null }],
        durationMinutes: null,
        tags: [],
        priority: "normal",
        enabled: true,
        createdAt: "",
        updatedAt: "",
        deletedAt: null,
      };
    } else if (kind === "longtask") {
      // V1.2：默认计划窗口 = 今天起 30 天。
      draft = {
        id: "",
        title: "",
        description: null,
        startDate: todayDate,
        dueDate: addDays(todayDate, 30),
        status: "active",
        endedAt: null,
        tags: [],
        priority: "normal",
        createdAt: "",
        updatedAt: "",
        deletedAt: null,
        sessions: [],
      };
    } else {
      draft = {
        id: "",
        title: "",
        description: null,
        priority: "normal",
        deadline: null,
        tags: [],
        status: "active",
        sortOrder: 0,
        createdAt: "",
        updatedAt: "",
        completedAt: null,
        deletedAt: null,
      };
    }
    set({ drawer: { kind, draft, isNew: true, initial: structuredClone(draft) } });
  },

  updateDraft(patch) {
    const drawer = get().drawer;
    if (!drawer) return;
    set({ drawer: { ...drawer, draft: { ...drawer.draft, ...patch } as DraftEntity } });
  },

  async saveDraft() {
    const drawer = get().drawer;
    if (!drawer) return false;
    try {
      let saved: DraftEntity | null;
      if (drawer.kind === "event") {
        saved = await withExternalConflict(() => api.saveEvent(drawer.draft as Event));
      } else if (drawer.kind === "routine") {
        saved = await withExternalConflict(() => api.saveRoutine(drawer.draft as Routine));
      } else if (drawer.kind === "longtask") {
        saved = await withExternalConflict(() => api.saveLongTask(drawer.draft as LongTask));
      } else {
        saved = await withExternalConflict(() => api.saveTask(drawer.draft as Task));
      }
      // 用户选择「重新加载放弃修改」：草稿数据已被刷新，直接关闭抽屉。
      if (saved === null) {
        get().closeDrawer();
        return false;
      }
      set({ drawer: { ...drawer, draft: saved, isNew: false, initial: structuredClone(saved) } });
      await get().refresh();
      return true;
    } catch (e) {
      setError(`保存失败：${String(e)}`);
      return false;
    }
  },

  async saveDraftAndClose() {
    const drawer = get().drawer;
    if (!drawer) return;
    const title = String((drawer.draft as { title?: string }).title ?? "").trim();
    if (!title) {
      get().pushToast("标题不能为空");
      return;
    }
    if (drawer.kind === "longtask") {
      const lt = drawer.draft as LongTask;
      if (!lt.startDate || !lt.dueDate) {
        get().pushToast("请填写开始日期与截止日期");
        return;
      }
      if (lt.dueDate < lt.startDate) {
        get().pushToast("截止日期不能早于开始日期");
        return;
      }
    }
    if (get().savingDrawer) return;
    set({ savingDrawer: true });
    try {
      const ok = await get().saveDraft();
      if (ok) {
        get().closeDrawer();
        get().pushToast("已保存");
      }
    } finally {
      set({ savingDrawer: false });
    }
  },

  requestCloseDrawer() {
    const drawer = get().drawer;
    if (!drawer || get().savingDrawer) return;
    if (JSON.stringify(drawer.draft) !== JSON.stringify(drawer.initial)) {
      get().askConfirm("放弃修改？", "当前编辑尚未保存，关闭将丢弃这些改动。", () => {
        get().closeDrawer();
      });
    } else {
      get().closeDrawer();
    }
  },

  closeDrawer() {
    set({ drawer: null, savingDrawer: false });
  },

  syncLongTaskDrawer(taskId) {
    const drawer = get().drawer;
    if (!drawer || drawer.kind !== "longtask") return;
    const fresh = get().data?.longTasks.find((x) => x.id === taskId);
    if (!fresh) return;
    const freshClone = structuredClone(fresh) as LongTask;
    // BUG-18：保留用户未保存的本地编辑，仅用最新数据刷新会话与已保存字段。
    const draft = drawer.draft as LongTask;
    const initial = drawer.initial as LongTask;
    const localDirty: Partial<LongTask> = {};
    for (const key of Object.keys(draft) as (keyof LongTask)[]) {
      if (key === "sessions") continue;
      if (JSON.stringify(draft[key]) !== JSON.stringify(initial[key])) {
        (localDirty as Record<string, unknown>)[key] = structuredClone(draft[key]);
      }
    }
    const mergedDraft = { ...freshClone, ...localDirty, sessions: freshClone.sessions };
    // The baseline must reflect persisted data. Merging local edits into it
    // would make an unsaved draft look clean after a session operation.
    const mergedInitial = freshClone;
    set({
      drawer: {
        ...drawer,
        draft: mergedDraft,
        initial: mergedInitial,
      },
    });
  },

  pushToast(message, actionLabel, onAction) {
    const id = nextId();
    set({ toasts: [...get().toasts, { id, message, actionLabel, onAction }] });
    setTimeout(() => get().dismissToast(id), 6000);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  askConfirm(title, message, onConfirm, onCancel, confirmLabel, cancelLabel) {
    const req: ConfirmState = { title, message, onConfirm, onCancel, confirmLabel, cancelLabel };
    if (get().confirm) {
      confirmQueue.push(req);
      return;
    }
    set({ confirm: req });
  },
  closeConfirm() {
    set({ confirm: null });
    presentNextConfirm();
  },

  // ---- V3.0 F1：计时器 ----

  startTimer(sourceType, sourceId, title) {
    if (!canEdit()) { get().pushToast("当前为只读状态，请先同步并获取编辑权"); return; }
    const now = Date.now();
    const timers = { ...get().timers };
    // 单计时器：开始新事项前，先暂停其它 running 计时。
    for (const [id, t] of Object.entries(timers)) {
      if (t.running) {
        timers[id] = { ...t, running: false, accumulatedMs: t.accumulatedMs + (now - t.startedAt), startedAt: 0 };
      }
    }
    const existing = timers[sourceId];
    if (existing) {
      timers[sourceId] = { ...existing, sourceType, title, running: true, startedAt: now };
    } else {
      timers[sourceId] = { sourceType, title, startedAt: now, accumulatedMs: 0, running: true };
    }
    set({ timers });
    saveJSON(TIMER_KEY, timers);
  },

  toggleTimer(sourceType, sourceId, title) {
    const t = get().timers[sourceId];
    if (t && t.running) {
      get().pauseTimer(sourceId);
    } else {
      get().startTimer(sourceType, sourceId, title);
    }
  },

  checkpointTimers() {
    const now = Date.now();
    const timers = { ...get().timers };
    let changed = false;
    for (const [id, timer] of Object.entries(timers)) {
      if (!timer.running) continue;
      timers[id] = {
        ...timer,
        accumulatedMs: timer.accumulatedMs + Math.max(0, now - timer.startedAt),
        startedAt: now,
      };
      changed = true;
    }
    if (changed) {
      set({ timers });
      saveJSON(TIMER_KEY, timers);
    }
  },

  pauseTimer(sourceId) {
    const timers = { ...get().timers };
    const t = timers[sourceId];
    if (t && t.running) {
      timers[sourceId] = { ...t, running: false, accumulatedMs: t.accumulatedMs + (Date.now() - t.startedAt), startedAt: 0 };
      set({ timers });
      saveJSON(TIMER_KEY, timers);
    }
  },

  timerElapsedMs(sourceId) {
    const t = get().timers[sourceId];
    if (!t) return 0;
    return t.accumulatedMs + (t.running ? Date.now() - t.startedAt : 0);
  },

  // ---- V1.2：长期任务计时 / 会话 ----

  startLongTaskTimer(task) {
    if (!canEdit()) { get().pushToast("当前为只读状态，请先同步并获取编辑权"); return; }
    const now = Date.now();
    const timers = { ...get().timers };
    // 单计时器互斥：暂停其它 running 计时。
    for (const [id, t] of Object.entries(timers)) {
      if (t.running) {
        timers[id] = { ...t, running: false, accumulatedMs: t.accumulatedMs + (now - t.startedAt), startedAt: 0 };
      }
    }
    const existing = timers[task.id];
    const sessionStartedAt =
      existing?.sessionStartedAt ?? (existing && existing.startedAt > 0 ? existing.startedAt : now);
    timers[task.id] = {
      sourceType: "longtask",
      title: task.title,
      startedAt: now,
      accumulatedMs: existing?.accumulatedMs ?? 0,
      running: true,
      sessionStartedAt,
      // 新会话生成幂等键；暂停/继续/重试均复用。
      sessionId: existing?.sessionId ?? newSessionId(),
    };
    set({ timers });
    saveJSON(TIMER_KEY, timers);
  },

  toggleLongTaskTimer(task) {
    const t = get().timers[task.id];
    if (t && t.running) {
      get().pauseTimer(task.id);
    } else {
      get().startLongTaskTimer(task);
    }
  },

  async terminateLongTaskSession(task) {
    const timer = get().timers[task.id];
    if (!timer) return null;
    const elapsedMs = Math.max(0, timer.accumulatedMs + (timer.running ? Date.now() - timer.startedAt : 0));
    const sessionStart =
      timer.sessionStartedAt ?? (timer.startedAt > 0 ? timer.startedAt : Date.now() - elapsedMs);
    // V1.2.1：幂等键随计时持久化；失败重试不会重复落库会话。
    const sessionId = timer.sessionId ?? newSessionId();
    if (!timer.sessionId) {
      const timers = { ...get().timers, [task.id]: { ...timer, sessionId } };
      set({ timers });
      saveJSON(TIMER_KEY, timers);
    }
    try {
      const session = await withExternalConflict(() =>
        api.addLongTaskSession({
          taskId: task.id,
          startedAt: new Date(sessionStart).toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: elapsedMs,
          note: null,
          sessionId,
        }),
      );
      if (session === null) return null;
      // 成功落库后才清除计时（失败保留计时可重试）。
      get().dropTimer(task.id);
      await get().refresh();
      await get().refreshStatsIfLoaded();
      get().pushToast(`已记录本次投入「${task.title || "长期任务"}」`, "撤回", async () => {
        await withExternalConflict(() => api.deleteLongTaskSession(task.id, session.id));
        await get().refresh();
        await get().refreshStatsIfLoaded();
        get().syncLongTaskDrawer(task.id);
      });
      return session;
    } catch (e) {
      setError(`记录投入失败：${String(e)}`);
      return null;
    }
  },

  dropTimer(sourceId) {
    const timers = { ...get().timers };
    if (!timers[sourceId]) return;
    delete timers[sourceId];
    set({ timers });
    saveJSON(TIMER_KEY, timers);
  },

  // ---- V3.0 F2：跳过/稍后 ----

  skipCandidate(id) {
    const skipped = new Set(get().skipped);
    skipped.add(id);
    set({ skipped, hiddenCandidates: computeHidden(skipped, get().snoozed) });
    saveJSON(skKey(localDateKey()), [...skipped]);
  },

  undoSkipped(id) {
    const skipped = new Set(get().skipped);
    skipped.delete(id);
    set({ skipped, hiddenCandidates: computeHidden(skipped, get().snoozed) });
    saveJSON(skKey(localDateKey()), [...skipped]);
  },

  snoozeCandidate(id, title, minutes) {
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    const snoozed = { ...get().snoozed, [id]: { until, title, day: localDateKey() } };
    set({ snoozed, hiddenCandidates: computeHidden(get().skipped, snoozed) });
    saveJSON(SN_KEY, snoozed);
  },

  undoSnoozed(id) {
    const snoozed = { ...get().snoozed };
    delete snoozed[id];
    set({ snoozed, hiddenCandidates: computeHidden(get().skipped, snoozed) });
    saveJSON(SN_KEY, snoozed);
  },

  checkSnoozes() {
    // 跨天：仅清理「跳过」（按天 key 隔离）；「稍后」保留单一 key，
    // 昨日稍后但尚未到期的条目不丢失，到期后由统一 until 判断重新出现。
    const day = localDateKey();
    if (day !== _currentDayKey) {
      _currentDayKey = day;
      set({ skipped: new Set(), hiddenCandidates: computeHidden(new Set(), get().snoozed) });
      saveJSON(skKey(day), []);
    }
    const now = Date.now();
    const snoozed = { ...get().snoozed };
    const expired: SnoozeEntry[] = [];
    for (const [id, v] of Object.entries(snoozed)) {
      if (new Date(v.until).getTime() <= now) {
        delete snoozed[id];
        expired.push(v);
      }
    }
    if (expired.length > 0) {
      set({ snoozed, hiddenCandidates: computeHidden(get().skipped, snoozed) });
      saveJSON(SN_KEY, snoozed);
      for (const v of expired) {
        get().pushToast(`「${v.title || "该事项"}」稍后时间到，已重新提醒`);
      }
      void get().refresh();
    }
  },

  triggerQuickAdd() {
    set({ page: "now", quickAddTick: get().quickAddTick + 1 });
  },

  async saveEvent(e) {
    const saved = await withExternalConflict(() => api.saveEvent(e));
    if (saved === null) return e; // 用户选择重载，数据已刷新。
    await get().refresh();
    return saved;
  },

  async deleteEvent(id) {
    const original = get().data?.events.find((x) => x.id === id);
    const r = await withExternalConflict(() => api.deleteEvent(id));
    if (r === null) return;
    await get().refresh();
    if (original) {
      get().pushToast(`已删除「${original.title || "事件"}」`, "撤回", async () => {
        await withExternalConflict(() => api.saveEvent(original));
        await get().refresh();
      });
    }
  },

  async saveRoutine(r) {
    const saved = await withExternalConflict(() => api.saveRoutine(r));
    if (saved === null) return r;
    await get().refresh();
    return saved;
  },

  async deleteRoutine(id) {
    const original = get().data?.routines.find((x) => x.id === id);
    const r = await withExternalConflict(() => api.deleteRoutine(id));
    if (r === null) return;
    await get().refresh();
    if (original) {
      get().pushToast(`已删除「${original.title || "日常"}」`, "撤回", async () => {
        await withExternalConflict(() => api.saveRoutine(original));
        await get().refresh();
      });
    }
  },

  async saveTask(t) {
    const saved = await withExternalConflict(() => api.saveTask(t));
    if (saved === null) return t;
    await get().refresh();
    return saved;
  },

  async deleteTask(id) {
    const original = get().data?.tasks.find((x) => x.id === id);
    const r = await withExternalConflict(() => api.deleteTask(id));
    if (r === null) return;
    await get().refresh();
    if (original) {
      get().pushToast(`已删除「${original.title || "浮动事项"}」`, "撤回", async () => {
        await withExternalConflict(() => api.saveTask(original));
        await get().refresh();
      });
    }
  },

  async updateTaskOrder(orderedIds) {
    const tasks = get().data?.tasks ?? [];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const updates = orderedIds
      .map((id, i) => {
        const t = byId.get(id);
        return t ? { ...t, sortOrder: i } : null;
      })
      .filter((x): x is Task => x != null);
    const r = await withExternalConflict(() => Promise.all(updates.map((t) => api.saveTask(t))));
    if (r === null) return;
    await get().refresh();
  },

  // ---- V1.2：长期任务 CRUD / 会话 ----

  async saveLongTask(t) {
    try {
      const saved = await withExternalConflict(() => api.saveLongTask(t));
      if (saved === null) return t;
      await get().refresh();
      return saved;
    } catch (e) {
      setError(`保存长期任务失败：${String(e)}`);
      return t;
    }
  },

  async deleteLongTask(id) {
    const original = get().data?.longTasks.find((x) => x.id === id);
    const hadTimer = Boolean(get().timers[id]);
    const prevData = get().data;
    // V1.2.2：先做本地乐观移除，列表 / 现在页立即消失；失败时回滚。
    if (prevData) {
      set({
        data: {
          ...prevData,
          longTasks: prevData.longTasks.filter((x) => x.id !== id),
        },
      });
    }
    try {
      // V1.2.1 F3：先删后端，成功后才丢弃计时——删除失败时保留进行中的计时。
      const r = await withExternalConflict(() => api.deleteLongTask(id));
      if (r === null) return;
      if (hadTimer) get().dropTimer(id);
      await get().refresh();
      // F4：删除成功后同步 / 关闭该任务的抽屉，保证所有入口一致。
      const drawer = get().drawer;
      if (drawer?.kind === "longtask" && (drawer.draft as { id?: string }).id === id) {
        get().closeDrawer();
      } else {
        get().syncLongTaskDrawer(id);
      }
      if (original) {
        const msg = hadTimer
          ? `已删除「${original.title || "长期任务"}」（进行中的计时已丢弃）`
          : `已删除「${original.title || "长期任务"}」`;
        get().pushToast(msg, "撤回", async () => {
          await withExternalConflict(() => api.saveLongTask(original));
          await get().refresh();
        });
      }
    } catch (e) {
      // 失败回滚本地移除（若此时已有刷新后的数据则不再覆盖）。
      const cur = get().data;
      if (prevData && cur?.longTasks.every((x) => x.id !== id)) {
        set({ data: { ...cur, longTasks: [...cur.longTasks, original].filter((x): x is LongTask => x != null) } });
      }
      setError(`删除长期任务失败：${String(e)}`);
    }
  },

  async endLongTask(t) {
    try {
      const saved = await withExternalConflict(() =>
        api.saveLongTask({ ...t, status: "ended", endedAt: null }),
      );
      if (saved === null) return;
      await get().refresh();
      get().syncLongTaskDrawer(t.id);
    } catch (e) {
      setError(`结束长期任务失败：${String(e)}`);
    }
  },

  async updateLongTaskSessionNote(taskId, sessionId, note) {
    try {
      const saved = await withExternalConflict(() => api.updateLongTaskSessionNote(taskId, sessionId, note));
      if (saved === null) return;
      await get().refresh();
      await get().refreshStatsIfLoaded();
      get().syncLongTaskDrawer(taskId);
    } catch (e) {
      setError(`保存收获失败：${String(e)}`);
    }
  },

  async deleteLongTaskSession(taskId, sessionId) {
    try {
      const task = get().data?.longTasks.find((x) => x.id === taskId);
      const session = task?.sessions.find((s) => s.id === sessionId);
      const r = await withExternalConflict(() => api.deleteLongTaskSession(taskId, sessionId));
      if (r === null) return;
      await get().refresh();
      await get().refreshStatsIfLoaded();
      get().syncLongTaskDrawer(taskId);
      if (session) {
        get().pushToast("已删除本次投入记录", "撤回", async () => {
          await get().undeleteLongTaskSession(taskId, sessionId);
        });
      }
    } catch (e) {
      setError(`删除投入记录失败：${String(e)}`);
    }
  },

  async undeleteLongTaskSession(taskId, sessionId) {
    try {
      const r = await withExternalConflict(() => api.undeleteLongTaskSession(taskId, sessionId));
      if (r === null) return;
      await get().refresh();
      await get().refreshStatsIfLoaded();
      get().syncLongTaskDrawer(taskId);
    } catch (e) {
      setError(`撤回投入记录失败：${String(e)}`);
    }
  },

  async completeCandidate(sourceType, sourceId, seriesId, title, suggestedDurationMinutes) {
    const data = get().data;
    if (!data) return;
    const tz = data.config.timezone;
    // V3.0 F1：若存在计时器，将实际耗时（四舍五入到分钟、至少 1 分钟）写入归档。
    const timer = get().timers[sourceId];
    let durationOverride: number | null = null;
    if (timer) {
      const elapsedMs = timer.accumulatedMs + (timer.running ? Date.now() - timer.startedAt : 0);
      durationOverride = Math.max(1, Math.round(elapsedMs / 60_000));
    }
    try {
      // 完成后端统一处理：写入归档；非重复来源标记完成；重复实例仅归档本次（§4.4）。
      const savedEntry = await withExternalConflict(() =>
        api.completeCandidate({
          sourceType,
          sourceId,
          seriesId,
          title,
          suggestedDurationMinutes,
          durationMinutesOverride: durationOverride,
        }),
      );
      if (savedEntry === null) return; // 用户选择重载，放弃本次完成操作。
      // 完成后清除该事项计时态。
      if (timer) {
        const timers = { ...get().timers };
        delete timers[sourceId];
        set({ timers });
        saveJSON(TIMER_KEY, timers);
      }
      await get().refresh();
      await get().refreshStatsIfLoaded();
      get().pushToast(`已归档「${title}」`, "撤回", async () => {
        const d = useAppStore.getState().data;
        const dayKey = d ? fmtDate(savedEntry.doneAt, d.config.timezone) : fmtDate(savedEntry.doneAt, tz);
        await get().removeArchiveEntry(dayKey, savedEntry);
        // 非重复来源：还原来源状态；重复实例无需还原序列。
        if (!seriesId) {
          if (sourceType === "event") {
            const ev = useAppStore.getState().data?.events.find((x) => x.id === sourceId);
            if (ev) await withExternalConflict(() => api.saveEvent({ ...ev, status: "active", completedAt: null }));
          } else if (sourceType === "task") {
            const t = useAppStore.getState().data?.tasks.find((x) => x.id === sourceId);
            if (t) await withExternalConflict(() => api.saveTask({ ...t, status: "active", completedAt: null }));
          }
        }
        await get().refresh();
        await get().refreshStatsIfLoaded();
      });
    } catch (e) {
      setError(`归档失败：${String(e)}`);
    }
  },

  async addManualArchive(title, time, note, date) {
    const data = get().data;
    if (!data) return;
    const tz = data.config.timezone;
    // V3.1 T1：使用归档页当前浏览日期构造 doneAt（此前误传 HH:mm 生成非法时间）。
    const doneAt = buildLocalIso(date, time, tz);
    const saved = await withExternalConflict(() =>
      api.archiveEntry({
        id: "",
        time,
        title,
        source: "manual",
        sourceId: null,
        note: note || null,
        durationMinutes: null,
        doneAt,
      }),
    );
    if (saved === null) return;
    await get().refresh();
    await get().refreshStatsIfLoaded();
    get().pushToast("已添加记录");
  },

  async updateArchiveDay(date, day) {
    const saved = await withExternalConflict(() => api.updateArchiveDay(date, day));
    if (saved === null) return;
    await get().refresh();
    // V1.2.2：归档变化后统计同步更新。
    await get().refreshStatsIfLoaded();
  },

  async removeArchiveEntry(date, entry) {
    // V1.2.2：长期任务聚合条目删除时，同步软删除当天会话，统计与归档一致。
    if (entry.source === "longtask") {
      const taskId = entry.sourceId;
      if (!taskId) {
        return { status: "cancelled", sessionIds: [] };
      }
      const r = await withExternalConflict(() => api.deleteLongTaskArchiveDay(taskId, date));
      if (r === null) return { status: "cancelled", sessionIds: [] };
      await get().refresh();
      await get().refreshStatsIfLoaded();
      return { status: "success", sessionIds: r.deletedSessionIds };
    }

    // 普通条目：按目标月份独立加载，修复非当前月删除静默失败（BUG-05）。
    const month = date.slice(0, 7);
    const af = await api.getArchiveMonth(month);
    const day = af.days[date];
    if (!day) {
      throw new Error(`归档日期 ${date} 没有记录`);
    }
    const next = { ...day, entries: day.entries.filter((x) => x.id !== entry.id) };
    const saved = await withExternalConflict(() => api.updateArchiveDay(date, next));
    if (saved === null) return { status: "cancelled", sessionIds: [] };
    await get().refresh();
    // V1.2.2：删除后统计同步变动。
    await get().refreshStatsIfLoaded();
    return { status: "success", sessionIds: [] };
  },

  async saveConfig(c) {
    const prevTagColors = get().data?.config.tagColors;
    const saved = await withExternalConflict(() => api.setConfig(c));
    if (saved === null) return;
    set({ data: get().data ? { ...get().data!, config: saved } : get().data });
    // 标签颜色变化后立即刷新 TagInfo（过滤条/搜索/设置页使用），保证颜色实时生效。
    if (JSON.stringify(prevTagColors ?? {}) !== JSON.stringify(saved.tagColors ?? {})) {
      await get().loadTags();
    }
  },

  async loadCalendar(start, end) {
    try {
      const calendar = await api.getCalendar(start, end);
      set({ calendar });
    } catch (e) {
      setError(`加载日历失败：${String(e)}`);
    }
  },

  async doSearch(q) {
    try {
      const searchResults = await api.searchData(q);
      set({ searchResults });
    } catch (e) {
      setError(`搜索失败：${String(e)}`);
    }
  },

  clearSearch() {
    set({ searchResults: null });
  },

  async loadStats(days) {
    try {
      const stats = await api.getStats(days);
      set({ stats, statsDays: days });
    } catch (e) {
      setError(`加载统计失败：${String(e)}`);
    }
  },

  async refreshStatsIfLoaded() {
    if (!get().stats) return;
    await get().loadStats(get().statsDays);
  },

  async loadReview(from, to) {
    try {
      const review = await api.getReview(from, to);
      set({ review });
    } catch (e) {
      setError(`加载复盘失败：${String(e)}`);
    }
  },

  async loadTags() {
    try {
      const tags = await api.listTags();
      set({ tags, tagsLoaded: true });
    } catch (e) {
      setError(`加载标签失败：${String(e)}`);
      // 加载失败也标记完成：用空标签列表清理失效筛选，避免日历因旧筛选恒为空。
      set({ tagsLoaded: true });
    }
  },

  async renameTag(oldName, newName) {
    const r = await withExternalConflict(() => api.renameTag(oldName, newName));
    if (r === null) return;
    await get().refresh();
    await get().loadTags();
  },

  async deleteTag(tag) {
    const r = await withExternalConflict(() => api.deleteTag(tag));
    if (r === null) return;
    await get().refresh();
    await get().loadTags();
  },

  async setDataDir(path) {
    const saved = await withExternalConflict(() => api.setDataDir(path));
    if (saved === null) return;
    set({ data: get().data ? { ...get().data!, config: saved } : get().data });
    await get().refresh();
  },

  async exportData(destDir) {
    return api.exportData(destDir);
  },

  async importData(srcDir) {
    const result = await withExternalConflict(() => api.importData(srcDir));
    if (result === null) return { events: 0, routines: 0, tasks: 0, longTasks: 0, archiveMonths: 0 };
    await get().refresh();
    return result;
  },
}));

export function useData() {
  return useAppStore((s) => s.data);
}
