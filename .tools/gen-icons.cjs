// 生成 Tauri 所需的图标（PNG + ICO）：蓝色圆角方块 + 白色圆心（代表「现在」）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(__dirname, '..', 'src-tauri', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.42; // 圆角方块内切圆半径
  const dot = size * 0.22; // 白点半径
  const corner = size * 0.22; // 圆角半径
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 圆角矩形测试
      const dx = Math.max(Math.abs(x - cx) - (size / 2 - corner), 0);
      const dy = Math.max(Math.abs(y - cy) - (size / 2 - corner), 0);
      const insideRounded = Math.sqrt(dx * dx + dy * dy) <= corner;
      const distCenter = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (insideRounded && distCenter > dot) {
        // 蓝色底
        buf[i] = 0x33;
        buf[i + 1] = 0x89;
        buf[i + 2] = 0xfb;
        buf[i + 3] = 255;
      } else if (insideRounded && distCenter <= dot) {
        // 白色圆心
        buf[i] = 255;
        buf[i + 1] = 255;
        buf[i + 2] = 255;
        buf[i + 3] = 255;
      } else {
        buf[i + 3] = 0; // 透明
      }
    }
  }
  return buf;
}

// ---- 生成 PNG ----
const png32 = encodePng(32, drawIcon(32));
const png128 = encodePng(128, drawIcon(128));
const png256 = encodePng(256, drawIcon(256));
fs.writeFileSync(path.join(OUT, '32x32.png'), png32);
fs.writeFileSync(path.join(OUT, '128x128.png'), png128);
fs.writeFileSync(path.join(OUT, '128x128@2x.png'), png256);

// ---- 生成 ICO（内嵌 PNG） ----
function icoEntry(size, data, offset) {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size;
  e[1] = size >= 256 ? 0 : size;
  e[2] = 0; // palette
  e[3] = 0;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  return e;
}
const images = [
  { size: 32, data: png32 },
  { size: 128, data: png128 },
  { size: 256, data: png256 },
];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type icon
header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = [];
for (const im of images) {
  entries.push(icoEntry(im.size, im.data, offset));
  offset += im.data.length;
}
const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);

console.log('icons generated:', fs.readdirSync(OUT).join(', '));
