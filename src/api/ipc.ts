// IPC 封装：前端只做 UI，所有业务/存储/候选计算通过 invoke 调用 Rust 后端。
import { invoke } from "@tauri-apps/api/core";
import type {
  AppData,
  ArchiveDay,
  ArchiveEntry,
  ArchiveFile,
  CalendarData,
  CandidatesResult,
  Config,
  Event,
  HookRunResult,
  HooksStatus,
  ImportResult,
  LongTask,
  LongTaskSession,
  NlpEvent,
  ReviewResult,
  Routine,
  SearchQuery,
  SearchResult,
  StatsResult,
  TagInfo,
  Task,
  Template,
  TemplateApplyResult,
  TemplateKind,
  TemplatePreview,
} from "../types";

export const loadAllData = () => invoke<AppData>("load_all_data");

export const getNowCandidates = (now: string) =>
  invoke<CandidatesResult>("get_now_candidates", { now });

export const saveEvent = (event: Event) => invoke<Event>("save_event", { event });

export const deleteEvent = (id: string) => invoke<void>("delete_event", { id });

export const saveRoutine = (routine: Routine) => invoke<Routine>("save_routine", { routine });

export const deleteRoutine = (id: string) => invoke<void>("delete_routine", { id });

export const saveTask = (task: Task) => invoke<Task>("save_task", { task });

export const deleteTask = (id: string) => invoke<void>("delete_task", { id });

// ---- V1.2：长期任务与会话 ----

export const saveLongTask = (task: LongTask) =>
  invoke<LongTask>("save_long_task", { task });

export const deleteLongTask = (id: string) => invoke<void>("delete_long_task", { id });

export interface AddLongTaskSessionInput {
  taskId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  note?: string | null;
  /** V1.2.1：前端生成的幂等键。 */
  sessionId: string;
}

export const addLongTaskSession = (input: AddLongTaskSessionInput) =>
  invoke<LongTaskSession>("add_long_task_session", { input });

export const updateLongTaskSessionNote = (
  taskId: string,
  sessionId: string,
  note: string | null,
) => invoke<LongTaskSession>("update_long_task_session_note", { input: { taskId, sessionId, note } });

export const deleteLongTaskSession = (taskId: string, sessionId: string) =>
  invoke<void>("delete_long_task_session", { input: { taskId, sessionId } });

export const undeleteLongTaskSession = (taskId: string, sessionId: string) =>
  invoke<void>("undelete_long_task_session", { input: { taskId, sessionId } });

export const archiveEntry = (entry: ArchiveEntry) =>
  invoke<ArchiveEntry>("archive_entry", { entry });

export const updateArchiveDay = (date: string, payload: ArchiveDay) =>
  invoke<ArchiveDay>("update_archive_day", { date, payload });

export const getArchiveMonth = (month: string) =>
  invoke<ArchiveFile>("get_archive_month", { month });

export const getConfig = () => invoke<Config>("get_config");

export const setConfig = (config: Config) => invoke<Config>("set_config", { config });

export const notify = (title: string, body: string) =>
  invoke<void>("notify", { title, body });

// ---- Phase 1 / Phase 2 ----

export const parseNl = (text: string) => invoke<NlpEvent>("parse_nl", { text });

export const getCalendar = (start: string, end: string) =>
  invoke<CalendarData>("get_calendar", { start, end });

export const searchData = (query: SearchQuery) =>
  invoke<SearchResult>("search_data", { query });

export const getStats = (days: number) => invoke<StatsResult>("get_stats", { days });

export const getReview = (from: string, to: string) =>
  invoke<ReviewResult>("get_review", { from, to });

export const listTags = () => invoke<TagInfo[]>("list_tags");

export const renameTag = (oldName: string, newName: string) =>
  invoke<void>("rename_tag", { old: oldName, new: newName });

export const deleteTag = (tag: string) => invoke<void>("delete_tag", { tag });

export const pickDirectory = () => invoke<string | null>("pick_directory");

export const setDataDir = (path: string) => invoke<Config>("set_data_dir", { path });

export const exportData = (destDir: string) =>
  invoke<string[]>("export_data", { destDir });

export const importData = (srcDir: string) =>
  invoke<ImportResult>("import_data", { srcDir });

// ---- Phase 3（V2.0）+ V3.1 ----

export const listTemplates = () => invoke<Template[]>("list_templates");

export const makeTemplateDefault = (kind: TemplateKind) =>
  invoke<Template>("make_template_default", { kind });

export const saveTemplate = (template: Template) =>
  invoke<Template>("save_template", { template });

export const deleteTemplate = (id: string) => invoke<void>("delete_template", { id });

export const previewTemplate = (templateId: string, date: string) =>
  invoke<TemplatePreview>("preview_template_cmd", { templateId, date });

export const applyTemplate = (templateId: string, date: string) =>
  invoke<TemplateApplyResult>("apply_template_cmd", { templateId, date });

export const hooksStatus = () => invoke<HooksStatus>("hooks_status_cmd");

export const runHookTest = (hook: string, payload: string) =>
  invoke<HookRunResult[]>("run_hook_test", { hook, payload });

export const openDataDir = () => invoke<void>("open_data_dir");

// ---- V3.1 ----

export const resolveExternalChange = (choice: "reload" | "overwrite") =>
  invoke<void>("resolve_external_change", { choice });

export interface CompleteCandidateInput {
  sourceType: string;
  sourceId: string;
  seriesId: string | null;
  title: string;
  suggestedDurationMinutes: number | null;
  /** V3.0 F1：计时器实际耗时（分钟），优先于 suggestedDurationMinutes。 */
  durationMinutesOverride?: number | null;
}

export const completeCandidate = (input: CompleteCandidateInput) =>
  invoke<ArchiveEntry>("complete_candidate", { input });
