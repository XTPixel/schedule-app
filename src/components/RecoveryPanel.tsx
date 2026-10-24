import { useState } from "react";
import { importBackupDocument, restoreRecoveryPoint } from "../api/ipc";

export function RecoveryPanel({ error, points }: { error: string; points: string[] }) {
  const [selected, setSelected] = useState(points[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState<"point" | "document" | null>(null);
  const restore = async () => {
    if (busy || !confirming || (confirming === "point" && !selected)) return;
    setBusy(true);
    setMessage("");
    try {
      if (confirming === "point") await restoreRecoveryPoint(selected);
      else if (!await importBackupDocument(password || undefined)) { setMessage("已取消文件恢复，当前数据保持不变"); return; }
      window.location.reload();
    } catch (e) { setMessage(String(e)); }
    finally { setBusy(false); setConfirming(null); }
  };
  return <main className="flex min-h-screen items-center justify-center bg-gray-50 p-6 dark:bg-slate-900">
    <section className="w-full max-w-xl space-y-4 rounded-xl border border-amber-200 bg-white p-6 text-gray-800 dark:bg-slate-800 dark:text-slate-100">
      <h1 className="text-xl font-semibold">需要恢复本地数据</h1>
      <p className="text-sm leading-6">数据文件损坏或上次数据替换未能完成，编辑已暂停。可选择本地恢复点或导入备份文件；恢复前会校验副本，当前文件和故障日志会保留。</p>
      <p role="alert" className="break-words text-sm text-red-600">{error}</p>
      {points.length > 0 ? <>
        <select aria-label="选择恢复点" disabled={busy || confirming !== null} value={selected} onChange={e=>setSelected(e.target.value)} className="w-full rounded border bg-white p-2 text-gray-900">
          {points.map(id=><option key={id} value={id}>{new Date(Number(id.split("-")[0])).toLocaleString()}</option>)}
        </select>
        <button type="button" disabled={busy || confirming !== null} onClick={()=>setConfirming("point")} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">恢复所选副本</button>
      </> : <p className="text-sm">未找到本地恢复点，可选择之前导出的日程备份文件。</p>}
      <div className="space-y-2 border-t border-gray-200 pt-3 dark:border-slate-600">
        <label className="block text-sm">备份口令（加密文件需填写）
          <input aria-label="备份口令" disabled={busy || confirming !== null} type="password" autoComplete="off" value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 w-full rounded border bg-transparent p-2" />
        </label>
        <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">口令不会保存。可读的本机设置会保留；损坏的设置使用默认值。</p>
        <button type="button" disabled={busy || confirming !== null} onClick={()=>setConfirming("document")} className="rounded border px-4 py-2 disabled:opacity-50">从备份文件恢复</button>
      </div>
      {confirming && <div role="alertdialog" aria-label="确认恢复本地数据" className="space-y-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        <p>{confirming === "point" ? "确认用所选本地副本恢复日程？" : "确认选择备份文件并恢复全部日程？"}当前文件会先保留为恢复前副本。</p>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={()=>void restore()} className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50">{busy ? "正在恢复…" : "确认恢复"}</button>
          <button type="button" disabled={busy} onClick={()=>setConfirming(null)} className="rounded border px-3 py-2 disabled:opacity-50">取消</button>
        </div>
      </div>}
      {message && <p role="alert" className="break-words text-sm text-red-600">{message}</p>}
    </section>
  </main>;
}
