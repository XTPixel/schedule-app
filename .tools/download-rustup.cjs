const https = require('https');
const fs = require('fs');
const path = require('path');

const url = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe';
const out = path.join(__dirname, 'rustup-init.exe');

https.get(url, (res) => {
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    console.log('redirect to', res.headers.location);
    https.get(res.headers.location, (r2) => {
      pipeToFile(r2, out);
    }).on('error', (e) => { console.error('ERR2', e.message); process.exit(1); });
    return;
  }
  console.log('status', res.statusCode);
  pipeToFile(res, out);
}).on('error', (e) => { console.error('ERR', e.message); process.exit(1); });

function pipeToFile(res, out) {
  const f = fs.createWriteStream(out);
  res.pipe(f);
  f.on('finish', () => { f.close(); console.log('DONE', out, fs.statSync(out).size, 'bytes'); });
  f.on('error', (e) => { console.error('FILEERR', e.message); process.exit(1); });
}
