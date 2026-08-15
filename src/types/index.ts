// 前端类型定义，与 Rust 后端 struct（serde camelCase）一一对应。

export type Priority = "high" | "normal" | "low";
export type ItemStatus = "active" | "completed" | "cancelled";
export type ArchiveSource = "event" | "routine" | "task" | "manual";
export type CandidateSource = "event" | "routine" | "task";

export interface Reminder {
  offsetMinutes: number;
}

export interface Repeat {
  type: string; // daily | weekly | monthly | yearly | custom
  interval: number;
  daysOfWeek: number[];
  end: string | null;
}

export interface Event {
  id: string;
  title: string;
  description: string | null;
  /** 绝对时刻（UTC Z）或全天事件的纯日期 YYYY-MM-DD。 */
  start: string;
  end: string | null;
  allDay: boolean;
  reminders: Reminder[];
  repeat: Repeat | null;
  tags: string[];
  priority: Priority;
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
}

export interface TimeWindow {
  daysOfWeek: number[]; // 1=周一 ... 7=周日
  start: string; // HH:mm
  end: string; // HH:mm
}

export interface Routine {
  id: string;
  title: string;
  description: string | null;
  timeWindows: TimeWindow[];
  durationMinutes: number | null;
  tags: string[];
  priority: Priority;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: Priority;
  deadline: string | null; // 绝对时刻（UTC Z）
  tags: string[];
  status: ItemStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
}

export interface ArchiveEntry {
  id: string;
  time: string; // HH:mm 显示用时间
  title: string;
  source: ArchiveSource;
  sourceId: string | null;
  note: string | null;
  durationMinutes: number | null;
  doneAt: string; // 绝对时刻（UTC Z）
}

export interface ArchiveDay {
  entries: ArchiveEntry[];
  summary: string | null;
  updatedAt: string;
}

export interface ArchiveFile {
  version: number;
  month: string; // YYYY-MM
  days: Record<string, ArchiveDay>;
}

export interface Config {
  version: number;
  timezone: string;
  notifications: {
    enabled: boolean;
    sound: boolean;
    doNotDisturb: { enabled: boolean; start: string; end: string };
    priorityPolicy: { high: NotifyLevel; normal: NotifyLevel; low: NotifyLevel };
  };
  appearance: { theme: string };
  behavior: {
    minimizeToTray: boolean;
    launchAtStartup: boolean;
    globalHotkey: string;
  };
  candidate: { missedRoutineGraceHours: number };
  hooks: HooksConfig;
  /** V3.1：标签名 → 颜色 token。 */
  tagColors: Record<string, string>;
  dataDir: string;
}

// ---- Phase 3（V2.0）新增类型 ----
// （V3.1 新增 Config.tagColors / ReminderNotice.dedupKey / TagInfo.color）

export type NotifyLevel = "system" | "app" | "off";

export interface HooksConfig {
  enabled: boolean;
}

export type TemplateKind = "workday" | "weekend" | "custom";
export type TemplateItemKind = "event" | "routine";

export interface TemplateItem {
  kind: TemplateItemKind;
  title: string;
  description: string | null;
  tags: string[];
  priority: Priority;
  allDay: boolean;
  startTime: string | null; // HH:mm
  endTime: string | null; // HH:mm
  durationMinutes: number | null;
  daysOfWeek: number[]; // 1=周一..7=周日
  windowStart: string | null; // HH:mm
  windowEnd: string | null; // HH:mm
}

export interface Template {
  id: string;
  name: string;
  kind: TemplateKind;
  items: TemplateItem[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface TemplatePreview {
  events: Event[];
  routines: Routine[];
}

export interface TemplateApplyResult {
  eventsCreated: number;
  routinesCreated: number;
}

export interface HookInfo {
  file: string;
  functions: string[];
  error: string | null;
}

export interface HookRunResult {
  file: string;
  hook: string;
  output: string | null;
  error: string | null;
}

export interface HooksStatus {
  enabled: boolean;
  directory: string;
  scripts: HookInfo[];
  supportedHooks: string[];
}

export interface AppData {
  events: Event[];
  routines: Routine[];
  tasks: Task[];
  config: Config;
  archive: ArchiveFile; // 当前月份归档
}

export interface Candidate {
  sourceType: CandidateSource;
  /** 完成归档时的来源键：一次性事件 = id；重复实例 = `{id}#{日期}`。 */
  sourceId: string;
  /** 重复事件的序列 id（仅重复实例非空）。 */
  seriesId: string | null;
  title: string;
  description: string | null;
  score: number;
  layer: number;
  reason: string;
  suggestedDurationMinutes: number | null;
  priority: Priority;
  timeLabel: string | null;
}

// ---- Phase 1 / Phase 2 新增类型 ----

export interface Occurrence {
  key: string;
  seriesId: string | null;
  localDate: string;
  event: Event;
}

export interface CalendarRoutineWindow {
  date: string;
  routineId: string;
  title: string;
  start: string;
  end: string;
  priority: Priority;
  tags: string[];
}

export interface CalendarData {
  occurrences: Occurrence[];
  routineWindows: CalendarRoutineWindow[];
}

export interface NlpEvent {
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  matched: boolean;
  date: string | null;
  time: string | null;
}

export interface SearchQuery {
  text: string;
  tags: string[];
  dateFrom: string | null;
  dateTo: string | null;
}

export interface SearchResult {
  events: Event[];
  tasks: Task[];
  routines: Routine[];
}

export interface DayCount {
  date: string;
  count: number;
  durationMinutes: number;
}

export interface TagDuration {
  tag: string;
  minutes: number;
  count: number;
}

export interface RoutineCompletion {
  routineId: string;
  title: string;
  doneDays: number;
  scheduledDays: number;
  rate: number;
}

export interface StatsTotals {
  completedCount: number;
  durationMinutes: number;
  activeDays: number;
}

export interface StatsResult {
  from: string;
  to: string;
  trend: DayCount[];
  tagDurations: TagDuration[];
  routineCompletion: RoutineCompletion[];
  totals: StatsTotals;
}

export interface ReviewDay {
  date: string;
  entries: ArchiveEntry[];
  completedCount: number;
  durationMinutes: number;
  summary: string | null;
}

export interface ReviewResult {
  from: string;
  to: string;
  days: ReviewDay[];
  totals: StatsTotals;
  tagDurations: TagDuration[];
  routineCompletion: RoutineCompletion[];
}

export interface TagInfo {
  tag: string;
  count: number;
  /** V3.1：颜色 token（未设置时为 null）。 */
  color: string | null;
}

export interface ImportResult {
  events: number;
  routines: number;
  tasks: number;
  archiveMonths: number;
}

export interface RoutineWindowView {
  routineId: string;
  title: string;
  start: string;
  end: string;
  priority: Priority;
  doneToday: boolean;
}

export interface Timeline {
  date: string;
  events: Event[];
  routineWindows: RoutineWindowView[];
  archive: ArchiveEntry[];
}

export interface ReminderNotice {
  kind: string;
  title: string;
  body: string;
  sourceId: string;
  /** V3.1：后端生成的细粒度去重键（同源多级提醒互不屏蔽）。 */
  dedupKey: string;
  priority: Priority;
  shouldNotify: boolean;
}

export interface CandidatesResult {
  now: string;
  localDate: string;
  localTime: string;
  main: Candidate | null;
  secondary: Candidate[];
  timeline: Timeline;
  dueReminders: ReminderNotice[];
}
