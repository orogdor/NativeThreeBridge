// Rasterises a UI display list (js/webapp-ui.js -> __nt.submitUi) into a PNG
// with a tiny software renderer, to eyeball layout without Windows.
// Text is drawn as bars (no fonts) and images as hatched placeholders.
//   import { previewPng } from './tools/ui-preview.mjs';
//   writeFileSync('ui.png', previewPng(floats, strings, width, height));
import { deflateSync } from 'node:zlib';

const OP = { CLIP: 1, RECT: 2, BORDER: 3, IMAGE: 4, TEXT: 5, LGRAD: 6, RGRAD: 7, SHADOW: 8 };
export const OP_SIZE = { 1: 6, 2: 13, 3: 29, 4: 13, 5: 16, 8: 14 };

// Walks the command stream; `visit(op, args)` receives the raw floats.
export function decodeUi(floats, visit) {
  const count = floats[3];
  let o = floats[0] >= 2 ? 8 : 4;
  for (let i = 0; i < count; i++) {
    const op = floats[o];
    let size = OP_SIZE[op];
    if (op === OP.LGRAD) size = 14 + floats[o + 13] * 5;
    if (op === OP.RGRAD) size = 14 + floats[o + 13] * 5;
    if (!size) throw new Error(`bad op ${op} at ${o}`);
    visit(op, floats.subarray(o + 1, o + size));
    o += size;
  }
  return o;
}

export function previewPng(floats, strings, width, height, background = [40, 60, 90]) {
  const px = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) { px[i * 3] = background[0] / 255; px[i * 3 + 1] = background[1] / 255; px[i * 3 + 2] = background[2] / 255; }
  let clip = null;
  const blend = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= width || y >= height || a <= 0) return;
    if (clip && (x < clip[0] || y < clip[1] || x >= clip[0] + clip[2] || y >= clip[1] + clip[3])) return;
    const i = (y * width + x) * 3;
    px[i] = px[i] * (1 - a) + r * a; px[i + 1] = px[i + 1] * (1 - a) + g * a; px[i + 2] = px[i + 2] * (1 - a) + b * a;
  };
  const inRound = (x, y, rx, ry, rw, rh, rad) => {
    const corner = (cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    if (x < rx + rad[0] && y < ry + rad[0]) return corner(rx + rad[0], ry + rad[0], rad[0]);
    if (x > rx + rw - rad[1] && y < ry + rad[1]) return corner(rx + rw - rad[1], ry + rad[1], rad[1]);
    if (x > rx + rw - rad[2] && y > ry + rh - rad[2]) return corner(rx + rw - rad[2], ry + rh - rad[2], rad[2]);
    if (x < rx + rad[3] && y > ry + rh - rad[3]) return corner(rx + rad[3], ry + rh - rad[3], rad[3]);
    return true;
  };
  const fill = (rx, ry, rw, rh, rad, color) => {
    for (let y = Math.floor(ry); y < Math.ceil(ry + rh); y++) for (let x = Math.floor(rx); x < Math.ceil(rx + rw); x++) {
      if (inRound(x + 0.5, y + 0.5, rx, ry, rw, rh, rad)) blend(x, y, ...color(x + 0.5, y + 0.5));
    }
  };
  const gradColor = (stops, t) => {
    t = Math.max(0, Math.min(1, t));
    let i = 0;
    while (i < stops.length - 1 && stops[i + 1].p < t) i++;
    const a = stops[i], b = stops[Math.min(stops.length - 1, i + 1)];
    const f = b.p > a.p ? (t - a.p) / (b.p - a.p) : 0;
    return [0, 1, 2, 3].map((k) => a.c[k] + (b.c[k] - a.c[k]) * Math.max(0, Math.min(1, f)));
  };
  const readStops = (a, at, n) => { const s = []; for (let k = 0; k < n; k++) s.push({ p: a[at + k * 5], c: [a[at + k * 5 + 1], a[at + k * 5 + 2], a[at + k * 5 + 3], a[at + k * 5 + 4]] }); return s; };
  decodeUi(floats, (op, a) => {
    switch (op) {
      case OP.CLIP: clip = a[2] < 0 ? null : [a[0], a[1], a[2], a[3]]; break;
      case OP.RECT: fill(a[0], a[1], a[2], a[3], [a[4], a[5], a[6], a[7]], () => [a[8], a[9], a[10], a[11]]); break;
      case OP.SHADOW: fill(a[0], a[1], a[2], a[3], [a[4], a[5], a[6], a[7]], () => [a[9], a[10], a[11], a[12] * 0.35]); break;
      case OP.BORDER: {
        const [x, y, w, h] = a;
        const wt = [a[8], a[9], a[10], a[11]];
        const col = (i) => [a[12 + i * 4], a[13 + i * 4], a[14 + i * 4], a[15 + i * 4]];
        if (wt[0]) fill(x, y, w, wt[0], [0, 0, 0, 0], () => col(0));
        if (wt[1]) fill(x + w - wt[1], y, wt[1], h, [0, 0, 0, 0], () => col(1));
        if (wt[2]) fill(x, y + h - wt[2], w, wt[2], [0, 0, 0, 0], () => col(2));
        if (wt[3]) fill(x, y, wt[3], h, [0, 0, 0, 0], () => col(3));
        break;
      }
      case OP.IMAGE: fill(a[0], a[1], a[2], a[3], [0, 0, 0, 0], (x, y) => (((x + y) >> 2) & 1 ? [0.95, 0.4, 0.85, 0.75 * a[9]] : [0.4, 0.1, 0.4, 0.75 * a[9]])); break;
      case OP.TEXT: {
        const size = a[6];
        const top = a[1] + (a[3] - size * 0.72) / 2;
        fill(a[0], top, Math.max(1, a[2] - 2), size * 0.72, [0, 0, 0, 0], () => [a[9], a[10], a[11], a[12] * 0.85]);
        break;
      }
      case OP.LGRAD: {
        const stops = readStops(a, 13, a[12]);
        const [x0, y0, x1, y1] = [a[8], a[9], a[10], a[11]];
        const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
        fill(a[0], a[1], a[2], a[3], [a[4], a[5], a[6], a[7]], (x, y) => gradColor(stops, ((x - x0) * dx + (y - y0) * dy) / len2));
        break;
      }
      case OP.RGRAD: {
        const stops = readStops(a, 13, a[12]);
        fill(a[0], a[1], a[2], a[3], [a[4], a[5], a[6], a[7]], (x, y) => gradColor(stops, Math.hypot((x - a[8]) / (a[10] || 1), (y - a[9]) / (a[11] || 1))));
        break;
      }
    }
  });
  void strings;
  // PNG (RGB, filter 0)
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) for (let k = 0; k < 3; k++) raw[y * (width * 3 + 1) + 1 + x * 3 + k] = Math.round(Math.max(0, Math.min(1, px[(y * width + x) * 3 + k])) * 255);
  }
  const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
