// Run against an emulator, or an explicitly selected device with an unconfigured
// sync profile. Never replace a user's real cloud configuration.
// Uses the debug WebView's DevTools endpoint to exercise the actual Rust IPC.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const serial = process.env.MOMENT_DEVICE || process.env.MOMENT_EMULATOR || 'emulator-5554';
if(!serial.startsWith('emulator-'))assert.equal(serial,require('./authorized-phone.cjs').authorizedPhone());
const qaPort=Number(process.env.MOMENT_ANDROID_QA_PORT||9223);assert.ok([9223,9227].includes(qaPort));
const out = path.join(root, '.build-cache', serial.startsWith('emulator-') ? 'android-evidence' : 'honor70-evidence');
fs.mkdirSync(out, { recursive: true });
const adb = path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe');
const shell = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let socket, nextId = 1;
const waiting = new Map();
async function connect() {
  const pid = shell('shell', 'pidof', 'com.personal.schedule').trim();
  assert.match(pid, /^\d+$/, 'app must be running');
  shell('forward', 'tcp:'+qaPort, `localabstract:webview_devtools_remote_${pid}`);
  const pages = await (await fetch('http://127.0.0.1:'+qaPort+'/json')).json();
  const page = pages.find(p => p.type === 'page');
  assert.ok(page, 'debug WebView page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const value = JSON.parse(event.data); if (value.id && waiting.has(value.id)) { const entry = waiting.get(value.id); waiting.delete(value.id); clearTimeout(entry.timer); value.error ? entry.reject(Error(JSON.stringify(value.error))) : entry.resolve(value.result); } };
}
function command(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(Error(`timeout ${method}`)); }, 35000);
    waiting.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const ipc = (name, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
async function waitForApp() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await connect();
      if (await evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke)')) return;
    } catch { /* Process, WebView and bridge become ready independently. */ }
    if (socket) { socket.close(); socket = null; }
    await delay(1000);
  }
  throw Error('native WebView bridge did not become ready');
}
async function test(name, work) {
  const started = Date.now();
  try { await work(); results.push({ name, passed: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); console.log(`FAIL ${name}: ${error}`); }
}
async function main() {
  if (serial.startsWith('emulator-')) shell('shell','input','keyevent','KEYCODE_WAKEUP');
  await waitForApp();
  if (!serial.startsWith('emulator-')) assert.doesNotMatch(shell('shell','dumpsys','window','policy'), /mIsShowing=true|^\s+showing=true/m, 'Please unlock the test phone before visual regression');
  assert.equal((await ipc('sync_get_status')).configured, false, 'Refusing QA changes to an already configured sync profile');
  const stamp = Date.now(); const tag = `QA-${stamp}`; const now = new Date().toISOString();
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const common = { description: null, tags: [tag], priority: 'normal', createdAt: now, updatedAt: now, deletedAt: null };
  let event, task, longTask;
  await test('native boot and local edit authorization', async () => {
    const status = await ipc('sync_get_status'); assert.equal(status.configured, false); assert.equal(status.editable, true);
    assert.match(await evaluate('document.body.innerText'), /MOMENT|现在/);
  });
  await test('natural language keeps half-hour', async () => {
    const result = await ipc('parse_nl', { text: '明天下午3点半开会' });
    assert.ok(JSON.stringify(result).includes('15:30'), JSON.stringify(result));
  });
  await test('save and reload event + floating task', async () => {
    event = await ipc('save_event', { event: { ...common, id: '', title: `${tag}-event`, start: now, end: null, allDay: false, reminders: [], repeat: null, status: 'active', completedAt: null } });
    task = await ipc('save_task', { task: { ...common, id: '', title: `${tag}-task`, deadline: null, sortOrder: 0, status: 'active', completedAt: null } });
    const data = await ipc('load_all_data'); assert.ok(data.events.some(x => x.id === event.id)); assert.ok(data.tasks.some(x => x.id === task.id));
  });
  await test('long task valid elapsed time and session idempotency', async () => {
    longTask = await ipc('save_long_task', { task: { ...common, id: '', title: `${tag}-long`, startDate: date, dueDate: date, status: 'active', endedAt: null, sessions: [] } });
    const sessionEnd = Date.now();
    const input = { taskId: longTask.id, startedAt: new Date(sessionEnd - 120000).toISOString(), endedAt: new Date(sessionEnd).toISOString(), durationMs: 60000, note: 'QA pause interval', sessionId: `qa-session-${stamp}` };
    await ipc('add_long_task_session', { input }); await ipc('add_long_task_session', { input });
    const data = await ipc('load_all_data'); const saved = data.longTasks.find(x => x.id === longTask.id);
    assert.equal(saved.sessions.length, 1); assert.equal(saved.sessions[0].durationMs, 60000);
  });
  await test('search includes every saved entity', async () => {
    const result = await ipc('search_data', { query: { text: tag, tags: [], dateFrom: null, dateTo: null } });
    assert.ok(result.events.some(x => x.id === event.id)); assert.ok(result.tasks.some(x => x.id === task.id)); assert.ok(result.longTasks.some(x => x.id === longTask.id));
  });
  await test('archive stats and month validation', async () => {
    const stats = await ipc('get_stats', { days: 30 }); assert.ok(stats.totals);
    await assert.rejects(() => ipc('get_archive_month', { month: '../../escape' }));
  });
  await test('cross-midnight routine and repeated event calendar', async () => {
    const routine=await ipc('save_routine',{routine:{...common,id:'',title:tag+'-routine',timeWindows:[{daysOfWeek:[],start:'23:00',end:'01:00',everyDays:2,anchorDate:date}],durationMinutes:30,enabled:true}});
    const repeated=await ipc('save_event',{event:{...common,id:'',title:tag+'-daily',start:now,end:null,allDay:false,reminders:[],repeat:{type:'daily',interval:1,daysOfWeek:[],end:null},status:'active',completedAt:null}});
    const through=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
    const calendar=await ipc('get_calendar',{start:date,end:through});
    assert.ok(calendar.occurrences.filter(o=>o.event.id===repeated.id).length>=3);
    assert.ok(calendar.routineWindows.some(w=>JSON.stringify(w).includes(routine.id)));
    await ipc('delete_routine',{id:routine.id});await ipc('delete_event',{id:repeated.id});
  });
  await test('template preview apply and cleanup', async () => {
    let template=await ipc('make_template_default',{kind:'custom'});template.title=tag+'-template';template.items[0].title=tag+'-templated';
    template=await ipc('save_template',{template});
    const preview=await ipc('preview_template_cmd',{templateId:template.id,date});
    assert.equal(preview.events.length+preview.routines.length,1);
    const applied=await ipc('apply_template_cmd',{templateId:template.id,date});assert.equal(applied.eventsCreated+applied.routinesCreated,1);
    const data=await ipc('load_all_data');
    for(const e of data.events.filter(e=>e.title===tag+'-templated'))await ipc('delete_event',{id:e.id});
    for(const r of data.routines.filter(r=>r.title===tag+'-templated'))await ipc('delete_routine',{id:r.id});
    await ipc('delete_template',{id:template.id});
  });
  await test('long task session delete and undo keep effective duration', async () => {
    const sessionId='qa-session-'+stamp;
    await ipc('delete_long_task_session',{input:{taskId:longTask.id,sessionId}});
    let saved=(await ipc('load_all_data')).longTasks.find(t=>t.id===longTask.id);assert.ok(saved.sessions[0].deletedAt);
    await ipc('undelete_long_task_session',{input:{taskId:longTask.id,sessionId}});
    saved=(await ipc('load_all_data')).longTasks.find(t=>t.id===longTask.id);assert.equal(saved.sessions[0].deletedAt,null);assert.equal(saved.sessions[0].durationMs,60000);
  });
  await test('mobile navigation and backup controls', async () => {
    await evaluate(`document.querySelector('button[aria-label="打开导航"]').click()`); await delay(250);
    const labels = await evaluate(`[...document.querySelectorAll('nav button')].map(x=>x.innerText.trim())`); assert.ok(labels.some(x => x.includes('设置')));
    await evaluate(`[...document.querySelectorAll('nav button')].find(x=>x.innerText.includes('设置')).click()`); await delay(500);
    assert.match(await evaluate('document.body.innerText'), /导出备份/); assert.match(await evaluate('document.body.innerText'), /系统通知权限/);
    assert.equal(await evaluate(`document.querySelector('aside').className.includes('-translate-x-full')`), true);
    if (serial.startsWith('emulator-')) {
      const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(out, 'settings.png'), Buffer.from(image.data, 'base64'));
    } else {
      // adb pull cannot reliably create Unicode Windows paths. Keep PNG bytes
      // on stdout and let Node write the D: evidence file without conversion.
      fs.writeFileSync(path.join(out,'settings.png'),execFileSync(adb,['-s',serial,'exec-out','screencap','-p'],{timeout:30000,maxBuffer:16*1024*1024}));
    }
  });
  await test('frontend timer persists across background and resume', async () => {
    await evaluate("[...document.querySelectorAll('nav button')].find(x=>x.innerText.includes('现在')).click()");await delay(200);
    await evaluate("window.dispatchEvent(new Event('focus'))");
    for (let n=0;n<15;n++) { if(await evaluate("[...document.querySelectorAll('main button')].some(x=>x.innerText.trim()==='开始')"))break;await delay(200); }
    await evaluate("[...document.querySelectorAll('main button')].find(x=>x.innerText.trim()==='开始').click()");
    const running=await evaluate("Object.values(JSON.parse(localStorage.getItem('schedule.timers.v1')||'{}')).some(x=>x.running)");assert.equal(running,true);
    shell('shell','input','keyevent','3');await delay(1200);shell('shell','am','start','-n','com.personal.schedule/.MainActivity');await delay(700);
    assert.equal(await evaluate("Object.values(JSON.parse(localStorage.getItem('schedule.timers.v1')||'{}')).some(x=>x.running)"),true);
  });
  await test('native back returns to now and closes mobile navigation',async()=>{
    await evaluate("[...document.querySelectorAll('nav button')].find(x=>x.innerText.includes('设置')).click()");await delay(200);
    shell('shell','input','keyevent','KEYCODE_BACK');await delay(400);
    assert.match(await evaluate("document.querySelector('main').innerText"),/此刻最该做/);
    await evaluate("document.querySelector('button[aria-label=\"打开导航\"]').click()");await delay(200);
    shell('shell','input','keyevent','KEYCODE_BACK');await delay(300);
    assert.equal(await evaluate("document.querySelector('aside').className.includes('-translate-x-full')"),true);
  });
  await test('Android credentials, offline read-only enforcement, disconnect', async () => {
    assert.equal((await ipc('sync_get_status')).configured,false,'Cloud configuration changed while QA was running');
    const status=await ipc('sync_configure',{input:{bucket:'moment-qa-only',downloadDomain:'https://moment-qa.invalid',prefix:'qa/v2',deviceName:'QA emulator',accessKey:'qa-not-a-real-access-key',secretKey:'qa-not-a-real-secret-key',passphrase:'qa-password-for-isolated-tests'}});
    assert.equal(status.configured,true);assert.equal(status.editable,false);
    await delay(250);assert.equal(await evaluate("Object.values(JSON.parse(localStorage.getItem('schedule.timers.v1')||'{}')).some(x=>x.running)"),false);
    await assert.rejects(()=>ipc('save_task',{task:{...common,id:'',title:tag+'-must-be-rejected',deadline:null,sortOrder:0,status:'active',completedAt:null}}));
    await evaluate('window.__qaSyncPromise=window.__TAURI_INTERNALS__.invoke("sync_now").then(()=>"unexpected-success").catch(()=>"offline-error"); undefined');
    assert.ok((await evaluate('document.body.innerText')).length>10);
    assert.equal(await evaluate('window.__qaSyncPromise'),'offline-error');
    assert.equal((await ipc('sync_get_status')).editable,false);
    await ipc('sync_disconnect');assert.equal((await ipc('sync_get_status')).editable,true);
  });
  await test('recovery and cancellation diagnostics are available',async()=>{
    assert.equal((await ipc('recovery_status')).error,null);
    assert.ok(Array.isArray(await ipc('recovery_details')));
    assert.equal((await ipc('sync_cancel')).syncing,false);
  });
  socket.close(); socket = null;
  await test('process death preserves saved data', async () => {
    shell('shell', 'am', 'force-stop', 'com.personal.schedule');
    shell('shell', 'am', 'start', '-n', 'com.personal.schedule/.MainActivity');
    await waitForApp();
    const data = await ipc('load_all_data'); assert.ok(data.events.some(x => x.id === event.id)); assert.equal(data.longTasks.find(x => x.id === longTask.id).sessions.length, 1);
  });
  fs.writeFileSync(path.join(out, 'smoke-results.json'), JSON.stringify({ recordedAt: new Date().toISOString(), device: shell('shell', 'getprop', 'ro.build.version.release').trim(), serial, tag, results }, null, 2));
  if (socket) socket.close();
  if (results.some(x => !x.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error); if (socket) socket.close(); process.exitCode = 1; });
