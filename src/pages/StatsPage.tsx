import { useEffect, useState } from "react";
import dayjs from "dayjs";
import { useAppStore } from "../store/useAppStore";
import { todayInTz } from "../lib/time";
import { SOURCE_LABEL } from "../lib/format";
import type { ReviewResult, StatsResult } from "../types";

function fmtDuration(min: number): string {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function addDays(d: string, n: number) {
  return dayjs(d).add(n, "day").format("YYYY-MM-DD");
}
function weekStart(d: string) {
  const j = dayjs(d);
  const dow = (j.day() + 6) % 7;
  return j.subtract(dow, "day").format("YYYY-MM-DD");
}

/** 统计页（V1.5）：完成趋势、标签耗时占比、日常完成率 + 日/周复盘。 */
export function StatsPage() {
  const [tab, setTab] = useState<"charts" | "review">("charts");
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-slate-100">统计</h1>
        <div className="flex rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-0.5">
          <button
            type="button"
            onClick={() => setTab("charts")}
            className={`rounded-md px-3 py-1 text-sm ${tab === "charts" ? "bg-accent-500 text-white" : "text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"}`}
          >
            图表
          </button>
          <button
            type="button"
            onClick={() => setTab("review")}
            className={`rounded-md px-3 py-1 text-sm ${tab === "review" ? "bg-accent-500 text-white" : "text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"}`}
          >
            复盘
          </button>
        </div>
      </div>
      {tab === "charts" ? <ChartsTab /> : <ReviewTab />}
    </div>
  );
}

function ChartsTab() {
  const stats = useAppStore((s) => s.stats);
  const loadStats = useAppStore((s) => s.loadStats);
  const [days, setDays] = useState(30);

  useEffect(() => {
    void loadStats(days);
  }, [days, loadStats]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500 dark:text-slate-400">统计范围</span>
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={`rounded-md border px-2.5 py-1 text-xs ${days === d ? "border-accent-400 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-200" : "border-gray-200 dark:border-slate-600 text-gray-600 dark:text-slate-300"}`}
          >
            近 {d} 天
          </button>
        ))}
      </div>

      {stats ? <ChartBody stats={stats} /> : <Empty />}
    </div>
  );
}

function ChartBody({ stats }: { stats: StatsResult }) {
  const maxCount = Math.max(1, ...stats.trend.map((t) => t.count));
  const maxTag = Math.max(1, ...stats.tagDurations.map((t) => t.minutes));
  const totalMin = stats.totals.durationMinutes;

  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="完成事项" value={String(stats.totals.completedCount)} />
        <StatCard label="总耗时" value={fmtDuration(stats.totals.durationMinutes)} />
        <StatCard label="活跃天数" value={`${stats.totals.activeDays} 天`} />
      </div>

      {/* 完成趋势 */}
      <Section title="完成趋势">
        <div className="flex h-32 items-end gap-px overflow-x-auto">
          {stats.trend.map((t) => (
            <div key={t.date} className="group flex min-w-2 flex-1 flex-col items-center" title={`${t.date}：${t.count} 项`}>
              <div className="w-full rounded-t bg-accent-400 transition group-hover:bg-accent-500" style={{ height: `${(t.count / maxCount) * 100}px` }} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-gray-400 dark:text-slate-500">
          <span>{stats.trend[0]?.date}</span>
          <span>{stats.trend[stats.trend.length - 1]?.date}</span>
        </div>
      </Section>

      {/* 标签耗时占比 */}
      <Section title="标签耗时占比">
        {stats.tagDurations.length === 0 ? (
          <div className="text-sm text-gray-400 dark:text-slate-500">暂无耗时数据（归档时填入「耗时」后生成）</div>
        ) : (
          <div className="flex flex-col gap-2">
            {stats.tagDurations.map((t) => (
              <div key={t.tag} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate text-xs text-gray-600 dark:text-slate-300">#{t.tag}</span>
                <div className="h-4 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-slate-700">
                  <div className="h-full rounded bg-emerald-400" style={{ width: `${(t.minutes / maxTag) * 100}%` }} />
                </div>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-gray-500 dark:text-slate-400">
                  {fmtDuration(t.minutes)} · {t.count} 项
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-1 text-xs text-gray-400 dark:text-slate-500">合计 {fmtDuration(totalMin)}</div>
      </Section>

      {/* 日常完成率 */}
      <Section title="日常完成率">
        {stats.routineCompletion.length === 0 ? (
          <div className="text-sm text-gray-400 dark:text-slate-500">暂无日常</div>
        ) : (
          <div className="flex flex-col gap-2">
            {stats.routineCompletion.map((r) => (
              <div key={r.routineId} className="flex items-center gap-2">
                <span className="w-32 truncate text-xs text-gray-600 dark:text-slate-300">{r.title || "（未命名）"}</span>
                <div className="h-4 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-slate-700">
                  <div className="h-full rounded bg-sky-400" style={{ width: `${(r.rate * 100).toFixed(1)}%` }} />
                </div>
                <span className="w-28 shrink-0 text-right text-xs tabular-nums text-gray-500 dark:text-slate-400">
                  {r.doneDays}/{r.scheduledDays} · {(r.rate * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function ReviewTab() {
  const data = useAppStore((s) => s.data);
  const review = useAppStore((s) => s.review);
  const loadReview = useAppStore((s) => s.loadReview);
  const tz = data?.config.timezone ?? "Asia/Shanghai";
  const [mode, setMode] = useState<"day" | "week">("day");
  const [date, setDate] = useState(() => todayInTz(tz));

  useEffect(() => {
    if (mode === "day") void loadReview(date, date);
    else {
      const s = weekStart(date);
      void loadReview(s, addDays(s, 6));
    }
  }, [mode, date, loadReview]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-0.5">
          {(["day", "week"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 text-sm ${mode === m ? "bg-accent-500 text-white" : "text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700"}`}
            >
              {m === "day" ? "日复盘" : "周复盘"}
            </button>
          ))}
        </div>
        <input
          type="date"
          className="rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-sm text-gray-800 dark:text-slate-100"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />
      </div>

      {review ? <ReviewBody review={review} /> : <Empty />}
    </div>
  );
}

function ReviewBody({ review }: { review: ReviewResult }) {
  const maxTag = Math.max(1, ...review.tagDurations.map((t) => t.minutes));
  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="完成事项" value={String(review.totals.completedCount)} />
        <StatCard label="总耗时" value={fmtDuration(review.totals.durationMinutes)} />
        <StatCard label="活跃天数" value={`${review.totals.activeDays} 天`} />
      </div>

      <Section title={review.days.length > 1 ? "每日概览" : "当日流水"}>
        {review.days.map((d) => (
          <div key={d.date} className="mb-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-medium text-gray-700 dark:text-slate-200">{dayjs(d.date).format("M月D日 ddd")}</span>
              <span className="text-xs text-gray-400 dark:text-slate-500">{d.completedCount} 项 · {fmtDuration(d.durationMinutes)}</span>
              {d.summary && <span className="text-xs text-amber-600">小结：{d.summary}</span>}
            </div>
            {d.entries.length === 0 ? (
              <div className="text-xs text-gray-400 dark:text-slate-500">无记录</div>
            ) : (
              <ol className="space-y-1">
                {d.entries.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-slate-200">
                    <span className="w-12 shrink-0 tabular-nums text-gray-500 dark:text-slate-400">{e.time}</span>
                    <span className="text-xs text-gray-400 dark:text-slate-500">{SOURCE_LABEL[e.source]}</span>
                    <span className="truncate">{e.title}</span>
                    {e.durationMinutes != null && (
                      <span className="ml-auto shrink-0 text-xs text-gray-400 dark:text-slate-500">{fmtDuration(e.durationMinutes)}</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </Section>

      {review.tagDurations.length > 0 && (
        <Section title="标签耗时">
          <div className="flex flex-col gap-2">
            {review.tagDurations.map((t) => (
              <div key={t.tag} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate text-xs text-gray-600 dark:text-slate-300">#{t.tag}</span>
                <div className="h-4 flex-1 overflow-hidden rounded bg-gray-100 dark:bg-slate-700">
                  <div className="h-full rounded bg-emerald-400" style={{ width: `${(t.minutes / maxTag) * 100}%` }} />
                </div>
                <span className="w-24 shrink-0 text-right text-xs text-gray-500 dark:text-slate-400">{fmtDuration(t.minutes)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 shadow-sm">
      <div className="text-xs text-gray-400 dark:text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-gray-900 dark:text-slate-100">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800 p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-gray-800 dark:text-slate-100">{title}</h2>
      {children}
    </div>
  );
}

function Empty() {
  return <div className="rounded-xl border border-dashed border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-10 text-center text-gray-400 dark:text-slate-500">暂无数据</div>;
}
