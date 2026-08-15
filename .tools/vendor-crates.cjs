// 通过 crates.io 稀疏索引（index.crates.io，CDN 无限流）按 feature 精确解析依赖、
// 下载 .crate、解包，生成 cargo 目录源（离线 vendor）。
// 用于绕过沙箱中 schannel TLS 不可用的问题。
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'src-tauri', 'vendor');
const CARGO_CONFIG_DIR = path.join(ROOT, 'src-tauri', '.cargo');

// 根依赖（与 schedule-core/Cargo.toml 一致），features 为显式启用的 feature。
const ROOTS = [
  { name: 'serde', req: '1', features: ['derive'] },
  { name: 'serde_json', req: '1', features: [] },
  { name: 'chrono', req: '0.4', features: ['serde'] },
  { name: 'chrono-tz', req: '0.10', features: [] },
];

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function getText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'schedule-vendor (build tool)' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) resolve(Buffer.concat(chunks).toString('utf8'));
        else reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      });
    }).on('error', reject);
  });
}
function getBinary(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'schedule-vendor (build tool)' } }, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        https.get(res.headers.location, (r2) => {
          const chunks = [];
          r2.on('data', (c) => chunks.push(c));
          r2.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 最小 semver
// ---------------------------------------------------------------------------
function parseVer(v) {
  const noBuild = v.trim().split('+')[0];
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(noBuild);
  if (!m) throw new Error(`bad version: ${v}`);
  return { major: +m[1], minor: +(m[2] || 0), patch: +(m[3] || 0), pre: m[4] || null };
}
function cmpVer(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
}
function satisfiesOne(version, r) {
  r = r.trim();
  if (r === '' || r === '*') return true;
  if (r.endsWith('.*')) {
    const base = r.slice(0, -2);
    const parts = base.split('.');
    let low, high;
    if (parts.length === 1) {
      low = { major: +parts[0], minor: 0, patch: 0, pre: null };
      high = { major: +parts[0] + 1, minor: 0, patch: 0, pre: null };
    } else {
      low = { major: +parts[0], minor: +parts[1], patch: 0, pre: null };
      high = { major: +parts[0], minor: +parts[1] + 1, patch: 0, pre: null };
    }
    return cmpVer(version, low) >= 0 && cmpVer(version, high) < 0;
  }
  if (r.startsWith('^')) return caret(parseVer(r.slice(1)), version);
  if (r.startsWith('~')) return tilde(r.slice(1), version);
  if (r.startsWith('>=')) return cmpVer(version, parseVer(r.slice(2))) >= 0;
  if (r.startsWith('<=')) return cmpVer(version, parseVer(r.slice(2))) <= 0;
  if (r.startsWith('>')) return cmpVer(version, parseVer(r.slice(1))) > 0;
  if (r.startsWith('<')) return cmpVer(version, parseVer(r.slice(1))) < 0;
  if (r.startsWith('=')) return cmpVer(version, parseVer(r.slice(1))) === 0;
  return caret(parseVer(r), version);
}
function satisfies(version, reqStr) {
  for (const r of reqStr.split(',')) {
    if (r.trim() && !satisfiesOne(version, r)) return false;
  }
  return true;
}
function caret(req, version) {
  if (cmpVer(version, req) < 0) return false;
  let high;
  if (req.major > 0) high = { major: req.major + 1, minor: 0, patch: 0, pre: null };
  else if (req.minor > 0) high = { major: 0, minor: req.minor + 1, patch: 0, pre: null };
  else high = { major: 0, minor: 0, patch: req.patch + 1, pre: null };
  return cmpVer(version, high) < 0;
}
function tilde(reqStr, version) {
  const req = parseVer(reqStr);
  if (cmpVer(version, req) < 0) return false;
  const parts = reqStr.split('.');
  let high;
  if (parts.length >= 3) high = { major: req.major, minor: req.minor + 1, patch: 0, pre: null };
  else if (parts.length === 2) high = { major: req.major, minor: req.minor + 1, patch: 0, pre: null };
  else high = { major: req.major + 1, minor: 0, patch: 0, pre: null };
  return cmpVer(version, high) < 0;
}

// ---------------------------------------------------------------------------
// 稀疏索引
// ---------------------------------------------------------------------------
function indexPath(name) {
  const l = name.length;
  if (l === 1) return `1/${name}`;
  if (l === 2) return `2/${name}`;
  if (l === 3) return `3/${name[0]}/${name}`;
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}

const indexCache = {};
async function getIndex(name) {
  if (indexCache[name]) return indexCache[name];
  let text;
  try {
    text = await getText(`https://index.crates.io/${indexPath(name)}`);
  } catch (e) {
    if (String(e.message).includes('404')) {
      indexCache[name] = [];
      return [];
    }
    throw e;
  }
  const arr = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  indexCache[name] = arr;
  return arr;
}
function getEntry(name, ver) {
  return (indexCache[name] || []).find((v) => v.vers === ver);
}

const NON_WIN_MARKERS = [
  'unix', 'macos', 'darwin', 'ios', 'android', 'linux', 'freebsd', 'openbsd',
  'netbsd', 'dragonfly', 'solaris', 'illumos', 'redox', 'wasi', 'wasm',
  'emscripten', 'fuchsia', 'hermit', 'uefi', 'watchos', 'tvos', 'visionos',
  'vxworks', 'aix', 'hurd', 'haiku', 'espidf', 'vita', 'psp', 'horizon', 'nintendo',
];
function isWindowsTarget(target) {
  if (!target) return true;
  const t = target.toLowerCase();
  if (t.includes('not(windows)') || t.includes('not(target_os = "windows")')) return false;
  if (t.includes('windows')) return true;
  return !NON_WIN_MARKERS.some((m) => t.includes(m));
}
const BUILTIN = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);
function realDep(d) { return d.package || d.name; }

// ---------------------------------------------------------------------------
// Feature-aware 解析
// ---------------------------------------------------------------------------
const versionResolved = new Map(); // `${name} ${req}` → version
const featureRequests = new Map(); // `${name}@${version}` → Set<feature>
const activated = new Set(); // `${name}@${version}` 已处理
const packages = new Map(); // `${name}@${version}` → { name, version, cksum }

async function resolveVersion(name, req) {
  const key = `${name} ${req}`;
  if (versionResolved.has(key)) return versionResolved.get(key);
  const entries = await getIndex(name);
  const versions = entries.filter((v) => !v.yanked).map((v) => v.vers);
  const wantsPre = req.includes('-');
  const rel = versions.filter((v) => {
    const core = v.split('+')[0];
    if (core.includes('-') && !wantsPre) return false;
    return satisfies(parseVer(v), req);
  });
  rel.sort((a, b) => {
    const metaA = a.includes('+') ? 1 : 0;
    const metaB = b.includes('+') ? 1 : 0;
    return metaA - metaB || cmpVer(parseVer(b), parseVer(a));
  });
  if (rel.length === 0) {
    versionResolved.set(key, null);
    return null;
  }
  const ver = rel[0];
  versionResolved.set(key, ver);
  const entry = getEntry(name, ver);
  packages.set(`${name}@${ver}`, { name, version: ver, cksum: entry?.cksum || null });
  return ver;
}

function addFeatureRequest(name, ver, feat) {
  const key = `${name}@${ver}`;
  if (!featureRequests.has(key)) featureRequests.set(key, new Set());
  featureRequests.get(key).add(feat);
}

async function activate(name, req, requestedFeatures) {
  if (BUILTIN.has(name)) return;
  const ver = await resolveVersion(name, req);
  if (ver == null) return;
  const key = `${name}@${ver}`;
  for (const f of requestedFeatures || []) addFeatureRequest(name, ver, f);
  if (activated.has(key)) return;
  activated.add(key);

  const entry = getEntry(name, ver);
  if (!entry) return;
  const feats = { ...(entry.features || {}), ...(entry.features2 || {}) };
  const byAlias = new Map((entry.deps || []).map((d) => [d.name, d]));

  const enabled = new Set(feats.default || []);
  for (const f of featureRequests.get(key) || []) enabled.add(f);
  const queue = [...enabled];
  const activeOptional = new Set(); // 已激活的可选依赖（别名）
  const depFeatReq = new Map(); // realName → Set<feat>

  function reqDepFeat(alias, feat) {
    const d = byAlias.get(alias);
    const real = d ? realDep(d) : alias;
    if (d && d.optional) activeOptional.add(alias);
    if (feat) {
      if (!depFeatReq.has(real)) depFeatReq.set(real, new Set());
      depFeatReq.get(real).add(feat);
    }
  }

  while (queue.length) {
    const f = queue.shift();
    for (const item of feats[f] || []) {
      // 1. "dep:foo" → 激活可选依赖 foo（新语法）
      if (item.startsWith('dep:')) {
        const alias = item.slice(4);
        const d = byAlias.get(alias);
        if (d && d.optional) activeOptional.add(alias);
        continue;
      }
      // 2. "foo/bar" 或 "foo?/bar"
      const slash = item.indexOf('/');
      if (slash >= 0) {
        let alias = item.slice(0, slash);
        const feat = item.slice(slash + 1);
        if (alias.endsWith('?')) alias = alias.slice(0, -1);
        reqDepFeat(alias, feat);
        continue;
      }
      // 3. "foo"（旧语法激活可选依赖）或同 crate 的 feature
      let alias = item;
      if (alias.endsWith('?')) alias = alias.slice(0, -1);
      const d = byAlias.get(alias);
      if (d) {
        activeOptional.add(d.name);
      } else if (!enabled.has(item)) {
        enabled.add(item);
        queue.push(item);
      }
    }
  }

  // 解析依赖：非可选 + 已激活的可选（覆盖全部目标，cargo 锁文件需要跨平台完整解析）
  for (const d of entry.deps || []) {
    if (d.kind === 'dev') continue;
    const isActive = !d.optional || activeOptional.has(d.name);
    if (!isActive) continue;
    const real = realDep(d);
    const featsFor = new Set(d.features || []);
    for (const f of depFeatReq.get(real) || []) featsFor.add(f);
    await activate(real, d.req, [...featsFor]);
  }
}

// ---------------------------------------------------------------------------
// 下载 + 解包 + 校验
// ---------------------------------------------------------------------------
function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

async function downloadPackage(pkg) {
  const { name, version } = pkg;
  const dirName = `${name}-${version}`;
  const dest = path.join(VENDOR_DIR, dirName);
  if (fs.existsSync(path.join(dest, '.cargo-checksum.json'))) {
    console.log('skip', dirName);
    return;
  }
  const url = `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
  const body = await getBinary(url);
  if (body.length === 0) throw new Error(`empty download ${url}`);
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const crateFile = path.join(VENDOR_DIR, `${dirName}.crate`);
  fs.writeFileSync(crateFile, body);
  execFileSync('tar', ['-xzf', crateFile, '-C', VENDOR_DIR], { stdio: 'ignore' });
  fs.unlinkSync(crateFile);

  const pkgSha = pkg.cksum || crypto.createHash('sha256').update(body).digest('hex');
  const files = {};
  for (const f of walkFiles(dest)) {
    files[path.relative(dest, f).split(path.sep).join('/')] = sha256File(f);
  }
  fs.writeFileSync(path.join(dest, '.cargo-checksum.json'), JSON.stringify({ package: pkgSha, files }, null, 1));
  console.log('vendored', dirName, Object.keys(files).length, 'files');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  for (const r of ROOTS) {
    await activate(r.name, r.req, r.features);
  }
  console.log(`\n共 ${packages.size} 个 crate，开始下载...`);
  const list = [...packages.values()];
  for (let i = 0; i < list.length; i++) {
    await downloadPackage(list[i]);
  }
  fs.mkdirSync(CARGO_CONFIG_DIR, { recursive: true });
  const cfg = `# 由 vendor-crates.cjs 生成：离线目录源（沙箱 schannel 不可用）
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "vendor"
`;
  fs.writeFileSync(path.join(CARGO_CONFIG_DIR, 'config.toml'), cfg);
  console.log('\n完成。已写入 .cargo/config.toml');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
