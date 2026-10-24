// For this project's local debug WebViews only.
const assert = require('node:assert/strict');
class Client {
  static assertPortFree(port) {
    assert.ok([9225,9226,9228,9229].includes(port),'Explicit Windows QA port required');
    return new Promise((resolve,reject)=>{const server=require('node:net').createServer();server.once('error',()=>reject(Error('QA port '+port+' is occupied')));server.listen(port,'127.0.0.1',()=>server.close(resolve));});
  }
  constructor(socket) {
    this.socket=socket;this.next=1;this.pending=new Map();
    socket.onmessage=event=>{const m=JSON.parse(event.data);const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)};
    socket.onclose=()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('debug WebView closed'))}this.pending.clear()};
  }
  static async connect(port) {
    assert.ok([9223,9224,9225,9226,9227,9228,9229,9231,9232].includes(port),'QA port must be explicit');
    const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(3000)})).json();
    const page=pages.find(p=>p.type==='page'&&/tauri\.localhost|^https?:\/\/localhost/.test(p.url));
    assert.ok(page,'owned application page required');
    const socket=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
    const client=new Client(socket);
    try {
      assert.equal(await client.evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke)'),true);
      return client;
    } catch(error) { client.close(); throw error; }
  }
  command(method,params) {
    if(this.socket.readyState!==WebSocket.OPEN)return Promise.reject(Error('debug WebView closed'));
    const id=this.next++;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('QA command timeout: '+method))},120000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}))});
  }
  async evaluate(expression) {
    const result=await this.command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  invoke(name,args={}) { return this.evaluate('window.__TAURI_INTERNALS__.invoke('+JSON.stringify(name)+','+JSON.stringify(args)+')'); }
  async assertWindowsIsolation() {
    assert.equal(await this.invoke('plugin:window|title',{label:'main'}),'此刻（隔离测试）','Refusing writes to a window without the native QA marker');
    assert.match(await this.evaluate('navigator.userAgent'),/Windows NT/,'Windows QA endpoint required');
    assert.equal(await this.invoke('plugin:app|version'),require('../package.json').version,'Native version must match the current source');
  }
  close(){this.socket.close();}
}
module.exports={Client};
