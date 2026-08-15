// 下载任意 URL 到本地（用 node 自带 OpenSSL，绕开 schannel）。
const https = require('https');
const fs = require('fs');

const [url, out] = process.argv.slice(2);
if (!url || !out) { console.error('usage: node dl.cjs <url> <out>'); process.exit(1); }

function get(u, redirects) {
  return new Promise((resolve, reject) => {
    https.get(u, { headers: { 'User-Agent': 'tauri-tool-dl' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects > 5) { reject(new Error('too many redirects')); return; }
        res.resume();
        get(res.headers.location, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ' for ' + u)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

(async () => {
  console.log('downloading', url);
  const buf = await get(url, 0);
  fs.writeFileSync(out, buf);
  console.log('DONE', buf.length, 'bytes ->', out);
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
