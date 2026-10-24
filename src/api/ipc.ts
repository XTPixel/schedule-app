// IPC 封装：前端只做 UI，所有业务/存储/候选计算通过 invoke 调用 Rust 后端。
import { invoke } from "@tauri-apps/api/core";

// Rust `()` arrives as JSON null, while conflict handling reserves null for a
// cancelled edit. Normalize successful void IPC to JavaScript undefined.
async function invokeVoid(command: string, args?: Record<string, unknown>): Promise<void> {
  await invoke<void>(command, args);
}
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
  SyncConfigInput,
  SyncStatus,
  InitialSyncChoice,
} from "../types";

export const loadAllData = () => invoke<AppData>("load_all_data");

export const getNowCandidates = (now: string) =>
  invoke<CandidatesResult>("get_now_candidates", { now });

export const saveEvent = (event: Event) => invoke<Event>("save_event", { event });

export const deleteEvent = (id: string) => invokeVoid("delete_event", { id });

export const saveRoutine = (routine: Routine) => invoke<Routine>("save_routine", { routine });

export const deleteRoutine = (id: string) => invokeVoid("delete_routine", { id });

export const saveTask = (task: Task) => invoke<Task>("save_task", { task });

export const deleteTask = (id: string) => invokeVoid("delete_task", { id });

// ---- V1.2：长期任务与会话 ----

export const saveLongTask = (task: LongTask) =>
  invoke<LongTask>("save_long_task", { task });

export const deleteLongTask = (id: string) => invokeVoid("delete_long_task", { id });

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
  invokeVoid("delete_long_task_session", { input: { taskId, sessionId } });

export const undeleteLongTaskSession = (taskId: string, sessionId: string) =>
  invokeVoid("undelete_long_task_session", { input: { taskId, sessionId } });

export interface DeleteLongTaskArchiveDayResult {
  deletedSessionIds: string[];
}

export const deleteLongTaskArchiveDay = (taskId: string, date: string) =>
  invoke<DeleteLongTaskArchiveDayResult>("delete_long_task_archive_day", {
    input: { taskId, date },
  });

export const undeleteLongTaskArchiveDay = (taskId: string, date: string, sessionIds: string[]) =>
  invokeVoid("undelete_long_task_archive_day", {
    input: { taskId, date, sessionIds },
  });

export const archiveEntry = (entry: ArchiveEntry) =>
  invoke<ArchiveEntry>("archive_entry", { entry });

export const updateArchiveDay = (date: string, payload: ArchiveDay) =>
  invoke<ArchiveDay>("update_archive_day", { date, payload });

export const getArchiveMonth = (month: string) =>
  invoke<ArchiveFile>("get_archive_month", { month });

export const getConfig = () => invoke<Config>("get_config");

export const setConfig = (config: Config) => invoke<Config>("set_config", { config });

export const notify = (title: string, body: string) =>
  invokeVoid("notify", { title, body });

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
  invokeVoid("rename_tag", { old: oldName, new: newName });

export const deleteTag = (tag: string) => invokeVoid("delete_tag", { tag });

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

export const deleteTemplate = (id: string) => invokeVoid("delete_template", { id });

export const previewTemplate = (templateId: string, date: string) =>
  invoke<TemplatePreview>("preview_template_cmd", { templateId, date });

export const applyTemplate = (templateId: string, date: string) =>
  invoke<TemplateApplyResult>("apply_template_cmd", { templateId, date });

export const hooksStatus = () => invoke<HooksStatus>("hooks_status_cmd");

export const runHookTest = (hook: string, payload: string) =>
  invoke<HookRunResult[]>("run_hook_test", { hook, payload });

export const openDataDir = () => invokeVoid("open_data_dir");

// ---- V2.0 Lite：七牛快照同步 ----
export const syncGetStatus = () => invoke<SyncStatus>("sync_get_status");
export const exportBackupDocument = (passphrase?: string) => invoke<boolean>("export_backup_document", { passphrase: passphrase ?? null });
export const importBackupDocument = (passphrase?: string) => invoke<boolean>("import_backup_document", { passphrase: passphrase ?? null });
export const recoveryPoints = () => invoke<string[]>("recovery_points");
export const recoveryDetails = () => invoke<{id:string;createdAt:string;platform:string;schemaVersion:number;files:number;complete:boolean}[]>("recovery_details");
export const exportSyncDiagnostics = () => invoke<boolean>("export_sync_diagnostics");
export const restoreRecoveryPoint = (id: string) => invoke<void>("restore_recovery_point", { id });
export const notificationPermission = (request = false) => invoke<string>("notification_permission", { request });
export const notificationReminderStatus = () => invoke<{exact:boolean}>("notification_reminder_status");
export const notificationOpenSettings = (exact = false) => invoke<void>("notification_open_settings", {exact});
export const syncConfigure = (input: SyncConfigInput) =>
  invoke<SyncStatus>("sync_configure", { input });
export const syncTestConnection = () => invoke<SyncStatus>("sync_test_connection");
export const syncNow = () => invoke<SyncStatus>("sync_now");
export const syncTick = () => invoke<SyncStatus>("sync_tick");
export const syncCancel = () => invoke<SyncStatus>("sync_cancel");
export const recoveryStatus = () => invoke<{error:string|null;points:string[]}>("recovery_status");
export const syncResolveInitial = (choice: InitialSyncChoice) =>
  invoke<SyncStatus>("sync_resolve_initial", { input: { choice } });
export const syncTakeoverExpired = () => invoke<SyncStatus>("sync_takeover_expired");
export const syncDisconnect = () => invoke<void>("sync_disconnect");
export const syncExit = () => invoke<void>("sync_exit");
export const syncForceExit = () => invoke<void>("sync_force_exit");
export const saveLocalTimerExit = (draft: {updatedAt:number;timers:unknown}) => invoke<void>("save_local_timer_exit", {draft});
export const loadLocalTimerExit = () => invoke<{updatedAt:number;timers:unknown} | null>("load_local_timer_exit");

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
