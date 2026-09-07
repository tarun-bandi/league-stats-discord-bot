// Small server-side raster renderer: PNG attachments without a chart service,
// native binaries, external fonts, or exposing player history in public URLs.
const FONT = {
  '0':'01110100011001110101110011000101110','1':'00100011000010000100001000010001110','2':'01110100010000100010001000100011111','3':'11110000010000101110000010000111110','4':'00010001100101010010111110001000010','5':'11111100001000011110000010000111110','6':'01110100001000011110100011000101110','7':'11111000010001000100010000100001000','8':'01110100011000101110100011000101110','9':'01110100011000101111000010000101110',
  A:'01110100011000111111100011000110001',B:'11110100011000111110100011000111110',C:'01111100001000010000100001000001111',D:'11110100011000110001100011000111110',E:'11111100001000011110100001000011111',F:'11111100001000011110100001000010000',G:'01111100001000010111100011000101111',H:'10001100011000111111100011000110001',I:'01110001000010000100001000010001110',J:'00111000100001000010100101001001100',K:'10001100101010011000101001001010001',L:'10000100001000010000100001000011111',M:'10001110111010110101100011000110001',N:'10001110011010110011100011000110001',O:'01110100011000110001100011000101110',P:'11110100011000111110100001000010000',Q:'01110100011000110001101011001001101',R:'11110100011000111110101001001010001',S:'01111100001000001110000010000111110',T:'11111001000010000100001000010000100',U:'10001100011000110001100011000101110',V:'10001100011000110001100010101000100',W:'10001100011000110101101011101110001',X:'10001100010101000100010101000110001',Y:'10001100010101000100001000010000100',Z:'11111000010001000100010001000011111',
  '-':'00000000000000011111000000000000000','+':'00000001000010011111001000010000000','/':'00001000010001000100010001000010000',':':'00000001000010000000001000010000000','.':'00000000000000000000000000011000110',
};
const W = 960, H = 420;
const TEXT = 1, MUTED = 2, GRID = 3, INK = 4;
const PALETTE = [16, 23, 38, 221, 232, 247, 141, 159, 183, 45, 59, 79];
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const concat = (arrays) => { const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0)); let at = 0; for (const a of arrays) { out.set(a, at); at += a.length; } return out; };
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function chunk(type, data) {
  const bytes = concat([new TextEncoder().encode(type), data]); let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >>> 8);
  return concat([u32(data.length), bytes, u32((crc ^ 0xffffffff) >>> 0)]);
}
export function axisRank(score) {
  const n = Math.max(0, Math.round(score));
  if (n >= 2800) return `MASTER+ ${n - 2800}`;
  const tiers = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLAT', 'EMERALD', 'DIAMOND'];
  return `${tiers[Math.floor(n / 400)]} ${['IV', 'III', 'II', 'I'][Math.floor(n % 400 / 100)]} ${n % 100}`;
}

export async function renderLpChart(series, start, end, label, color = [83, 191, 242]) {
  const pixels = new Uint8Array(W * H);
  const rect = (x, y, w, h, c) => { const x1 = Math.max(0, Math.round(x)), x2 = Math.min(W, Math.round(x + w)); if (x2 <= x1) return; for (let yy = Math.max(0, Math.round(y)); yy < Math.min(H, Math.round(y + h)); yy++) pixels.fill(c, yy * W + x1, yy * W + x2); };
  const text = (s, x, y, scale = 2, c = TEXT) => { for (const char of s.toUpperCase()) { const glyph = FONT[char]; if (glyph) for (let i = 0; i < 35; i++) if (glyph[i] === '1') rect(x + i % 5 * scale, y + Math.floor(i / 5) * scale, scale, scale, c); x += 6 * scale; } };
  const line = (x1, y1, x2, y2, c, width = 1) => {
    // Every edge is horizontal or vertical (axes and observed step lines).
    rect(Math.min(x1, x2) - width / 2, Math.min(y1, y2) - width / 2,
      Math.abs(x2 - x1) + width, Math.abs(y2 - y1) + width, c);
  };
  const values = series.points.map((p) => p.score);
  const min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 100;
  const pad = Math.max(20, (max - min) * 0.15), low = Math.max(0, Math.floor((min - pad) / 10) * 10), high = Math.ceil((max + pad) / 10) * 10;
  const left = 200, right = 920, top = 90, bottom = 330;
  const x = (at) => left + (at - start) / (end - start) * (right - left);
  const y = (score) => bottom - (score - low) / (high - low) * (bottom - top);
  text(`${label} - LP HISTORY`, 28, 22, 3);
  text('RANK + LP', 28,  60, 2, MUTED);
  for (let i = 0; i <= 4; i++) {
    const value = low + (high - low) * i / 4, yy = y(value);
    line(left, yy, right, yy, GRID); text(axisRank(value), 20, yy - 7, 2, MUTED);
    const at = start + (end - start) * i / 4, xx = x(at), date = new Date(at).toISOString().slice(5, 10);
    line(xx, top, xx, bottom, GRID); text(date, xx - 30, bottom + 18, 2, MUTED); text(new Date(at).toISOString().slice(11, 16), xx - 30, bottom + 38, 2, MUTED);
  }
  for (const segment of series.segments) {
    for (let i = 1; i < segment.length; i++) {
      const a = segment[i - 1], b = segment[i];
      // Step at the next observation; never smooth/interpolate LP changes.
      line(x(a.at), y(a.score), x(b.at), y(a.score), INK, 2);
      line(x(b.at), y(a.score), x(b.at), y(b.score), INK, 2);
    }
    for (const p of segment) rect(x(p.at) - 2, y(p.score) - 2, 5, 5, INK);
  }
  if (!values.length) text('NO RANK OBSERVATIONS IN THIS PERIOD', left + 20, 190, 2, MUTED);
  text('UTC DATES / DOTS ARE OBSERVATIONS / BREAKS ARE GAPS OR RESETS', 28, 390, 2, MUTED);
  const scanlines = new Uint8Array((W + 1) * H);
  for (let row = 0; row < H; row++) scanlines.set(pixels.subarray(row * W, (row + 1) * W), row * (W + 1) + 1);
  const compressed = new Uint8Array(await new Response(new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', concat([u32(W), u32(H), new Uint8Array([8, 3, 0, 0, 0])])), chunk('PLTE', new Uint8Array([...PALETTE, ...color])), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())]);
}
