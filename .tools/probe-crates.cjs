const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'schedule-vendor-probe' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

(async () => {
  try {
    const api = await get('https://crates.io/api/v1/crates/itoa');
    console.log('crates.io API status', api.status, 'len', api.data.length);
    const j = JSON.parse(api.data);
    console.log('itoa max_version', j.crate && j.crate.max_version, 'newest', j.crate && j.crate.newest_version);

    // download a .crate from static.crates.io
    const c = await get('https://static.crates.io/crates/itoa/itoa-1.0.14.crate');
    console.log('static.crates.io status', c.status, 'bytes', c.data.length);
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
})();
