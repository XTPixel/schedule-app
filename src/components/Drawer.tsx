import { useState } from "react";
import dayjs from "dayjs";
import { useAppStore } from "../store/useAppStore";
import { fmtDate, fmtTime, buildLocalIso, todayInTz } from "../lib/time";
import { computeLongTaskStats, fmtDurationMs } from "../lib/longTaskStats";
import { TimeField } from "./TimeField";
import { TagInput } from "./TagInput";
import { InlineEdit } from "./InlineEdit";
import { WEEKDAY_LABEL } from "../lib/format";
import type { Event, LongTask, LongTaskSession, Reminder, Repeat, Routine, Task, TimeWindow } from "../types";

const KIND_LABEL = { event: "事件", routine: "日常", task: "浮动事项", longtask: "长期任务" } as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-slate-400">{label}</label>
      {children}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-800 dark:text-slate-100 outline-none placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:border-accent-400 focus:ring-2 focus:ring-accent-100";

function PrioritySelect({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  return (
    <select
      className={inputCls}
      value={value}
      onChange={(e) => onSave(e.target.value)}
    >
      <option value="high">高</option>
      <option value="normal">中</option>
      <option value="low">低</option>
    </select>
  );
}

function TagsField({ value, onSave }: { value: string[]; onSave: (v: string[]) => void }) {
  return <TagInput value={value} onChange={onSave} />;
}

function WeekdayPicker({ days, onSave }: { days: number[]; onSave: (d: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {[1, 2, 3, 4, 5, 6, 7].map((d) => {
        const active = days.includes(d);
        return (
          <button
            key={d}
            type="button"
            className={`rounded-md px-2 py-1 text-xs transition ${
              active ? "bg-accent-500 text-white" : "bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-200"
            }`}
            onClick={() => {
              const next = active ? days.filter((x) => x !== d) : [...days, d];
              onSave(next);
            }}
          >
            {WEEKDAY_LABEL[d]}
          </button>
        );
      })}
      <button
        type="button"
        className="ml-1 rounded-md px-2 py-1 text-xs text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700"
        onClick={() => onSave([])}
      >
        每天
      </button>
    </div>
  );
}

const REPEAT_LABEL: Record<string, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
};

const REMINDER_PRESETS = [5, 10, 15, 30, 60, 120, 1440];

function reminderLabel(min: number): string {
  if (min >= 1440 && min % 1440 === 0) return `提前 ${min / 1440} 天`;
  if (min >= 60) return `提前 ${Math.round((min / 60) * 10) / 10} 小时`;
  return `提前 ${min} 分钟`;
}

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4 rounded-lg border border-gray-100 dark:border-slate-700">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700"
        onClick={() => setOpen(!open)}
      >
        <span>{title}</span>
        <span className="text-gray-400 dark:text-slate-500">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

/** 多级提醒（§4.5）：可勾选多个提前量。 */
function RemindersField({ value, onSave }: { value: Reminder[]; onSave: (v: Reminder[]) => void }) {
  function toggle(offset: number) {
    const exists = value.some((r) => r.offsetMinutes === offset);
    const next = exists ? value.filter((r) => r.offsetMinutes !== offset) : [...value, { offsetMinutes: offset }];
    onSave(next);
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {REMINDER_PRESETS.map((p) => {
        const active = value.some((r) => r.offsetMinutes === p);
        return (
          <button
            key={p}
            type="button"
            className={`rounded-md px-2 py-1 text-xs transition ${
              active ? "bg-accent-500 text-white" : "bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-200"
            }`}
            onClick={() => toggle(p)}
          >
            {reminderLabel(p)}
          </button>
        );
      })}
    </div>
  );
}

/** 重复规则（§4.1）：daily/weekly/monthly/yearly + 间隔 + 星期 + 截止。 */
function RepeatField({ value, onSave }: { value: Repeat | null; onSave: (v: Repeat | null) => void }) {
  const endDate = value?.end ? value.end.slice(0, 10) : "";
  return (
    <div className="space-y-2">
      <select
        className={inputCls}
        value={value?.type ?? ""}
        onChange={(e) => {
          const t = e.target.value;
          if (!t) {
            onSave(null);
          } else {
            onSave(value && value.type ? { ...value, type: t } : { type: t, interval: 1, daysOfWeek: [], end: null });
          }
        }}
      >
        <option value="">不重复</option>
        <option value="daily">每天</option>
        <option value="weekly">每周</option>
        <option value="monthly">每月</option>
        <option value="yearly">每年</option>
      </select>

      {value && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-slate-400">每</span>
            <input
              type="number"
              min={1}
              className={`${inputCls} w-20`}
              value={value.interval}
              onChange={(e) => onSave({ ...value, interval: Math.max(1, Number(e.target.value) || 1) })}
            />
            <span className="text-xs text-gray-500 dark:text-slate-400">{REPEAT_LABEL[value.type] ?? "周期"}</span>
          </div>

          {value.type === "weekly" && (
            <WeekdayPicker
              days={value.daysOfWeek}
              onSave={(days) => onSave({ ...value, daysOfWeek: days })}
            />
          )}

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-slate-400">截止（可选）</span>
            <input
              type="date"
              className={`${inputCls} w-40`}
              value={endDate}
              onChange={(e) => onSave({ ...value, end: e.target.value || null })}
            />
            {value.end && (
              <button type="button" className="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600" onClick={() => onSave({ ...value, end: null })}>
                清除
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 右侧 480px 非模态抽屉（V3.1 U5）：本地草稿编辑，底部「取消 / 保存」显式生效。 */
export function Drawer() {
  const drawer = useAppStore((s) => s.drawer);
  const savingDrawer = useAppStore((s) => s.savingDrawer);
  const updateDraft = useAppStore((s) => s.updateDraft);
  const requestCloseDrawer = useAppStore((s) => s.requestCloseDrawer);
  const saveDraftAndClose = useAppStore((s) => s.saveDraftAndClose);
  const closeDrawer = useAppStore((s) => s.closeDrawer);
  const askConfirm = useAppStore((s) => s.askConfirm);
  const deleteEvent = useAppStore((s) => s.deleteEvent);
  const deleteRoutine = useAppStore((s) => s.deleteRoutine);
  const deleteTask = useAppStore((s) => s.deleteTask);
  const deleteLongTask = useAppStore((s) => s.deleteLongTask);
  const endLongTask = useAppStore((s) => s.endLongTask);
  const updateLongTaskSessionNote = useAppStore((s) => s.updateLongTaskSessionNote);
  const deleteLongTaskSession = useAppStore((s) => s.deleteLongTaskSession);

  if (!drawer) return null;
  const { kind, draft, isNew } = drawer;
  const tz = useAppStore.getState().data?.config.timezone ?? "Asia/Shanghai";

  function onDelete() {
    const id = (draft as { id: string }).id;
    const title = (draft as { title: string }).title || KIND_LABEL[kind];
    askConfirm(`删除${KIND_LABEL[kind]}`, `确定删除「${title}」吗？此操作可撤回。`, () => {
      if (kind === "event") void deleteEvent(id);
      else if (kind === "routine") void deleteRoutine(id);
      else if (kind === "longtask") void deleteLongTask(id);
      else void deleteTask(id);
      closeDrawer();
    });
  }

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[480px] flex-col border-l border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-2xl">
      <div className="flex h-14 items-center justify-between border-b border-gray-100 dark:border-slate-700 px-5">
        <div className="text-sm font-semibold text-gray-800 dark:text-slate-100">
          {isNew ? `新建${KIND_LABEL[kind]}` : `编辑${KIND_LABEL[kind]}`}
        </div>
        <div className="flex items-center gap-2">
          {!isNew && (
            <button
              type="button"
              className="rounded-lg px-2 py-1 text-sm text-red-500 hover:bg-red-50"
              onClick={onDelete}
            >
              删除
            </button>
          )}
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-700"
            onClick={requestCloseDrawer}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <Field label="标题">
          <input
            className={inputCls}
            value={(draft as { title: string }).title}
            placeholder="输入标题"
            onChange={(e) => updateDraft({ title: e.target.value } as never)}
          />
        </Field>

        <Field label="备注">
          <textarea
            className={`${inputCls} resize-none`}
            rows={2}
            value={(draft as { description: string | null }).description ?? ""}
            placeholder="可选"
            onChange={(e) => updateDraft({ description: e.target.value || null } as never)}
          />
        </Field>

        {kind === "event" && <EventFields draft={draft as Event} tz={tz} updateDraft={updateDraft} />}
        {kind === "routine" && <RoutineFields draft={draft as Routine} tz={tz} updateDraft={updateDraft} />}
        {kind === "task" && <TaskFields draft={draft as Task} tz={tz} updateDraft={updateDraft} />}
        {kind === "longtask" && <LongTaskFields draft={draft as LongTask} updateDraft={updateDraft} />}

        <Field label="标签">
          <TagsField
            value={(draft as { tags: string[] }).tags}
            onSave={(tags) => updateDraft({ tags } as never)}
          />
        </Field>

        <Field label="优先级">
          <PrioritySelect
            value={(draft as { priority: string }).priority}
            onSave={(priority) => updateDraft({ priority } as never)}
          />
        </Field>

        {kind === "longtask" && !isNew && (
          <LongTaskDetailSection
            task={draft as LongTask}
            endLongTask={endLongTask}
            askConfirm={askConfirm}
            updateLongTaskSessionNote={updateLongTaskSessionNote}
            deleteLongTaskSession={deleteLongTaskSession}
          />
        )}
      </div>

      {/* V3.1 U5：底部固定操作栏，显式「取消 / 保存」。 */}
      <div className="flex items-center justify-end gap-2 border-t border-gray-100 dark:border-slate-700 px-5 py-3">
        <button
          type="button"
          disabled={savingDrawer}
          className="rounded-lg border border-gray-200 dark:border-slate-600 px-4 py-1.5 text-sm text-gray-700 dark:text-slate-200 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50"
          onClick={requestCloseDrawer}
        >
          取消
        </button>
        <button
          type="button"
          disabled={savingDrawer}
          className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          onClick={() => void saveDraftAndClose()}
        >
          {savingDrawer ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}

function EventFields({
  draft,
  tz,
  updateDraft,
}: {
  draft: Event;
  tz: string;
  updateDraft: (p: never) => void;
}) {
  const allDay = draft.allDay;
  const startDate = allDay ? draft.start : fmtDate(draft.start, tz);
  const startTime = allDay ? "00:00" : fmtTime(draft.start, tz);
  const endDate = allDay ? (draft.end ?? draft.start) : fmtDate(draft.end ?? draft.start, tz);
  const endTime = allDay ? "00:00" : fmtTime(draft.end ?? draft.start, tz);

  return (
    <>
      <Field label="全天">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => {
              const checked = e.target.checked;
              const today = todayInTz(tz);
              updateDraft({
                allDay: checked,
                start: checked ? today : buildLocalIso(today, "09:00", tz),
                end: checked ? today : buildLocalIso(today, "10:00", tz),
              } as never);
            }}
          />
          全天事件（纯日期，不随时区漂移）
        </label>
      </Field>

      <Field label="开始时间">
        <div className="flex items-center gap-2">
          <input
            type="date"
            className={inputCls}
            value={startDate}
            onChange={(e) => {
              const d = e.target.value;
              updateDraft({
                start: allDay ? d : buildLocalIso(d, startTime, tz),
              } as never);
            }}
          />
          {!allDay && (
            <TimeField
              value={startTime}
              onChange={(t) => updateDraft({ start: buildLocalIso(startDate, t, tz) } as never)}
            />
          )}
        </div>
      </Field>

      <Field label="结束时间（可选）">
        <div className="flex items-center gap-2">
          <input
            type="date"
            className={inputCls}
            value={endDate}
            onChange={(e) => {
              const d = e.target.value;
              updateDraft({ end: allDay ? d : buildLocalIso(d, endTime, tz) } as never);
            }}
          />
          {!allDay && (
            <TimeField
              value={endTime}
              onChange={(t) => updateDraft({ end: buildLocalIso(endDate, t, tz) } as never)}
            />
          )}
          {draft.end != null && (
            <button
              type="button"
              className="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600"
              onClick={() => updateDraft({ end: null } as never)}
            >
              清除
            </button>
          )}
        </div>
      </Field>

      <Collapsible title="高级：重复与提醒">
        <Field label="重复">
          <RepeatField value={draft.repeat} onSave={(repeat) => updateDraft({ repeat } as never)} />
        </Field>
        <Field label="多级提醒">
          <RemindersField value={draft.reminders} onSave={(reminders) => updateDraft({ reminders } as never)} />
        </Field>
      </Collapsible>
    </>
  );
}

function RoutineFields({
  draft,
  tz,
  updateDraft,
}: {
  draft: Routine;
  tz: string;
  updateDraft: (p: never) => void;
}) {
  function updateWindow(i: number, patch: Partial<TimeWindow>) {
    const timeWindows = draft.timeWindows.map((w, idx) => (idx === i ? { ...w, ...patch } : w));
    updateDraft({ timeWindows } as never);
  }
  function removeWindow(i: number) {
    updateDraft({ timeWindows: draft.timeWindows.filter((_, idx) => idx !== i) } as never);
  }
  function addWindow() {
    updateDraft({
      timeWindows: [
        ...draft.timeWindows,
        { daysOfWeek: [], start: "08:00", end: "09:00", everyDays: null, anchorDate: null },
      ],
    } as never);
  }
  /** V1.2.1：窗口模式切换（按星期 ↔ 每隔 N 天）。 */
  function setWindowMode(i: number, every: boolean) {
    updateWindow(i, every ? { everyDays: 1, anchorDate: todayInTz(tz), daysOfWeek: [] } : { everyDays: null, anchorDate: null });
  }

  return (
    <>
      <Field label="时间窗口">
        {draft.timeWindows.map((w, i) => (
          <div key={i} className="mb-3 rounded-lg border border-gray-100 dark:border-slate-700 p-3">
            <div className="mb-2 flex gap-1">
              <button
                type="button"
                className={`rounded-md px-2 py-1 text-xs ${w.everyDays == null ? "bg-accent-500 text-white" : "bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400"}`}
                onClick={() => setWindowMode(i, false)}
              >
                按星期
              </button>
              <button
                type="button"
                className={`rounded-md px-2 py-1 text-xs ${w.everyDays != null ? "bg-accent-500 text-white" : "bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400"}`}
                onClick={() => setWindowMode(i, true)}
              >
                每隔 N 天
              </button>
            </div>

            {w.everyDays == null ? (
              <WeekdayPicker
                days={w.daysOfWeek}
                onSave={(daysOfWeek) => {
                  updateWindow(i, { daysOfWeek });
                }}
              />
            ) : (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
                <span>从</span>
                <input
                  type="date"
                  className="rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-1.5 py-1 text-xs text-gray-700 dark:text-slate-200"
                  value={w.anchorDate ?? ""}
                  onChange={(e) => updateWindow(i, { anchorDate: e.target.value || null })}
                />
                <span>起，每隔</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  className="w-20 rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-1.5 py-1 text-xs text-gray-700 dark:text-slate-200"
                  value={w.everyDays ?? 1}
                  onChange={(e) => updateWindow(i, { everyDays: Math.min(365, Math.max(1, Number(e.target.value) || 1)) })}
                />
                <span>天一次</span>
              </div>
            )}

            <div className="mt-2 flex items-center gap-2">
              <TimeField value={w.start} onChange={(t) => updateWindow(i, { start: t })} />
              <span className="text-gray-400 dark:text-slate-500">–</span>
              <TimeField value={w.end} onChange={(t) => updateWindow(i, { end: t })} />
              <button
                type="button"
                className="ml-auto text-xs text-red-400 hover:text-red-600"
                onClick={() => removeWindow(i)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="text-sm text-accent-600 dark:text-accent-300 hover:text-accent-500"
          onClick={addWindow}
        >
          + 添加窗口
        </button>
      </Field>

      <Field label="预计时长（分钟，可选）">
        <input
          type="number"
          min={0}
          className={inputCls}
          value={draft.durationMinutes ?? ""}
          placeholder="如 30"
          onChange={(e) =>
            updateDraft({
              durationMinutes: e.target.value === "" ? null : Number(e.target.value),
            } as never)
          }
        />
      </Field>

      <Field label="启用">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => updateDraft({ enabled: e.target.checked } as never)}
          />
          参与候选推荐与提醒
        </label>
      </Field>
    </>
  );
}

function TaskFields({
  draft,
  tz,
  updateDraft,
}: {
  draft: Task;
  tz: string;
  updateDraft: (p: never) => void;
}) {
  const deadlineDate = draft.deadline ? fmtDate(draft.deadline, tz) : "";

  return (
    <Field label="截止日期（可选）">
      <div className="flex items-center gap-2">
        <input
          type="date"
          className={inputCls}
          value={deadlineDate}
          onChange={(e) => {
            // BUG-14：清空输入框直接置 null，不再对空串构造 ISO。
            if (!e.target.value) {
              updateDraft({ deadline: null } as never);
            } else {
              updateDraft({ deadline: buildLocalIso(e.target.value, "23:59", tz) } as never);
            }
          }}
        />
        {draft.deadline && (
          <button
            type="button"
            className="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600"
            onClick={() => updateDraft({ deadline: null } as never)}
          >
            清除
          </button>
        )}
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// V1.2：长期任务字段与详情
// ---------------------------------------------------------------------------

function LongTaskFields({
  draft,
  updateDraft,
}: {
  draft: LongTask;
  updateDraft: (p: never) => void;
}) {
  return (
    <>
      <Field label="计划开始日期">
        <input
          type="date"
          className={inputCls}
          value={draft.startDate}
          onChange={(e) => updateDraft({ startDate: e.target.value } as never)}
        />
      </Field>
      <Field label="截止日期">
        <input
          type="date"
          className={inputCls}
          value={draft.dueDate}
          onChange={(e) => updateDraft({ dueDate: e.target.value } as never)}
        />
      </Field>
    </>
  );
}

function LongTaskDetailSection({
  task,
  endLongTask,
  askConfirm,
  updateLongTaskSessionNote,
  deleteLongTaskSession,
}: {
  task: LongTask;
  endLongTask: (t: LongTask) => Promise<void>;
  askConfirm: ReturnType<typeof useAppStore.getState>["askConfirm"];
  updateLongTaskSessionNote: (taskId: string, sessionId: string, note: string | null) => Promise<void>;
  deleteLongTaskSession: (taskId: string, sessionId: string) => Promise<void>;
}) {
  const tz = useAppStore((s) => s.data?.config.timezone ?? "Asia/Shanghai");
  const today = todayInTz(tz);
  const stats = computeLongTaskStats(task, today, tz);
  const sessions = task.sessions
    .filter((s) => s.deletedAt == null)
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return (
    <div className="mb-4 border-t border-gray-100 dark:border-slate-700 pt-4">
      <div className="mb-3 grid grid-cols-3 gap-2">
        <MiniStat label="今日次数" value={`${stats.todayCount}`} />
        <MiniStat label="今日时长" value={fmtDurationMs(stats.todayDurationMs)} />
        <MiniStat label="累计次数" value={`${stats.sessionCount}`} />
        <MiniStat label="累计时长" value={fmtDurationMs(stats.totalDurationMs)} />
        <MiniStat label="平均每次" value={stats.sessionCount ? fmtDurationMs(stats.avgDurationMs) : "—"} />
        <MiniStat label="最后投入" value={stats.lastSessionAt ? dayjs(stats.lastSessionAt).format("MM-DD") : "—"} />
      </div>

      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-gray-500 dark:text-slate-400">投入记录（新 → 旧）</h3>
        {sessions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 dark:border-slate-600 px-3 py-4 text-center text-xs text-gray-400 dark:text-slate-500">
            还没有投入记录
          </div>
        ) : (
          <ol className="space-y-2">
            {sessions.map((s) => (
              <LongTaskSessionRow
                key={s.id}
                session={s}
                dueDate={task.dueDate}
                onSaveNote={(note) => updateLongTaskSessionNote(task.id, s.id, note)}
                onDelete={() => {
                  askConfirm("删除本次记录", "确定删除这条投入记录吗？删除后可从 Toast 撤回。", () => {
                    void deleteLongTaskSession(task.id, s.id);
                  });
                }}
              />
            ))}
          </ol>
        )}
      </div>

      {task.status === "active" && (
        <button
          type="button"
          className="w-full rounded-lg border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
          onClick={() => {
            askConfirm(
              "结束长期任务",
              "结束后该任务不再出现在「现在」页，历史投入记录会保留。确定结束吗？",
              () => void endLongTask(task),
              undefined,
              "结束任务",
              "取消",
            );
          }}
        >
          结束长期任务
        </button>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-slate-700/40 px-2 py-2 text-center">
      <div className="text-[10px] text-gray-400 dark:text-slate-500">{label}</div>
      <div className="mt-0.5 text-xs font-semibold tabular-nums text-gray-700 dark:text-slate-200">{value}</div>
    </div>
  );
}

function LongTaskSessionRow({
  session,
  dueDate,
  onSaveNote,
  onDelete,
}: {
  session: LongTaskSession;
  dueDate: string;
  onSaveNote: (note: string | null) => void;
  onDelete: () => void;
}) {
  const crossDue = dayjs(session.endedAt).format("YYYY-MM-DD") > dueDate;
  return (
    <li className="rounded-lg border border-gray-100 dark:border-slate-700 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
        <span className="tabular-nums">{dayjs(session.startedAt).format("MM-DD HH:mm")}</span>
        <span>→</span>
        <span className="tabular-nums">{dayjs(session.endedAt).format("HH:mm")}</span>
        {crossDue && (
          <span className="rounded bg-red-50 dark:bg-red-900/30 px-1 py-0.5 text-red-500">跨截止</span>
        )}
        <span className="ml-auto font-medium text-gray-700 dark:text-slate-200">{fmtDurationMs(session.durationMs)}</span>
        <button type="button" className="text-red-400 hover:text-red-600" onClick={onDelete}>
          删除
        </button>
      </div>
      <div className="mt-1 text-xs text-gray-600 dark:text-slate-300">
        <InlineEdit
          value={session.note ?? ""}
          placeholder="补填本次收获（可选）"
          className="!rounded px-1 py-0.5 text-xs"
          textClassName="text-gray-400 dark:text-slate-500"
          onSave={(v) => onSaveNote(v.trim() || null)}
        />
      </div>
    </li>
  );
}
