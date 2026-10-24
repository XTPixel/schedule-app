// Inspect/interact with this project's debug WebView on the dedicated emulator.
const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
const adb=path.join(process.env.ANDROID_HOME,'platform-tools','adb.exe');
const serial=process.env.MOMENT_EMULATOR||'emulator-5554';
const expression=process.argv[2]||fs.readFileSync(0,'utf8');
let socket;
(async()=>{
  const pid=execFileSync(adb,['-s',serial,'shell','pidof','com.personal.schedule'],{encoding:'utf8',timeout:15000}).trim();
  if(!/^\d+$/.test(pid))throw Error('Test app is not running');
  execFileSync(adb,['-s',serial,'forward','tcp:9223',`localabstract:webview_devtools_remote_${pid}`]);
  const pages=await(await fetch('http://127.0.0.1:9223/json')).json();const page=pages.find(p=>p.type==='page');
  if(!page)throw Error('No debug WebView page');socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('WebView evaluation timeout')),45000);
    socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id===1){clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result)}};
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  });
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  console.log(JSON.stringify(result.result.value,null,2));socket.close();
})().catch(error=>{console.error(error);if(socket)socket.close();process.exitCode=1});
