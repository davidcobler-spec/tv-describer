// Generates the app icons (black square, yellow TV with a speech wave) with no dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const Y = [255, 212, 0], B = [0, 0, 0];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let col = B;
      // TV outline
      const inOuter = u > 0.16 && u < 0.84 && v > 0.24 && v < 0.68;
      const inInner = u > 0.22 && u < 0.78 && v > 0.30 && v < 0.62;
      if (inOuter && !inInner) col = Y;
      // stand
      if (u > 0.40 && u < 0.60 && v > 0.72 && v < 0.77) col = Y;
      // sound arcs inside the screen
      const r = Math.hypot(u - 0.36, v - 0.46);
      const ang = Math.atan2(v - 0.46, u - 0.36);
      if (Math.abs(ang) < 0.8 && ((r > 0.08 && r < 0.11) || (r > 0.15 && r < 0.18) || (r > 0.22 && r < 0.25)) && inInner) col = Y;
      if (r < 0.04) col = Y;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = col[0]; raw[o + 1] = col[1]; raw[o + 2] = col[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (const [name, size] of [['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
  writeFileSync(new URL(`../public/${name}`, import.meta.url), png(size));
}
