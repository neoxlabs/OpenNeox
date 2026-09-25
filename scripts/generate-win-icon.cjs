const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SRC_PNG = path.join(ROOT, 'assets/brand/neox-logo/official-vortex/app-icon-windows.png');

/** 黑底白漩涡接近灰度; 蓝紫 3D N 饱和度很高. 均值 > 28 就是又烤成 N 了. */
async function assertVortexNotLetterN(pngBuf, label) {
  const { data, info } = await sharp(pngBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let chromaSum = 0, n = 0;
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    if (data[i + 3] < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    chromaSum += Math.max(r, g, b) - Math.min(r, g, b);
    n++;
  }
  const mean = n ? chromaSum / n : 999;
  if (mean > 28) {
    throw new Error(`${label}: mean chroma ${mean.toFixed(1)} — this is the 3D N letter, not the black/white vortex`);
  }
  console.log(`${label}: mean chroma ${mean.toFixed(1)} (vortex ok)`);
}
const TARGET_RATIO = 0.94; // plate fills this fraction of the frame (was ~0.81)
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const OUT_ICOS = [
  path.join(ROOT, 'build/icon.ico'),
  path.join(ROOT, 'assets/brand/neox-logo/official-vortex/app-icons-platform/icon.ico'),
  path.join(ROOT, 'apps/desktop/src/ui/renderer/assets/icon.ico'),
];
const OUT_SRC_PNG = SRC_PNG;

async function opaqueBBox(img) {
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * ch + 3] > 8) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, w, h };
}

// Build an ICO (multi-size, 32bpp BMP frames) from PNG buffers per size.
function buildIco(frames) {
  const N = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = icon
  header.writeUInt16LE(N, 4);   // count

  const entries = [];
  const datas = [];
  for (const f of frames) {
    /* Win10 Explorer 拒收 ICO 里的 256×256 BMP (目录项 width=0, 未压缩 ~270KB)。
     * 整份 ICO 解析失败时壳层掉回 Electron 默认原子标。256 必须是 PNG。 */
    if (f.png) {
      datas.push({ w: f.width, h: f.height, data: f.png });
      continue;
    }
    const w = f.width, h = f.height;
    // BITMAPINFOHEADER
    const bih = Buffer.alloc(40);
    bih.writeUInt32LE(40, 0);          // biSize
    bih.writeInt32LE(w, 4);            // biWidth
    bih.writeInt32LE(h * 2, 8);        // biHeight (double: XOR + AND mask)
    bih.writeUInt16LE(1, 12);          // biPlanes
    bih.writeUInt16LE(32, 14);         // biBitCount
    bih.writeUInt32LE(0, 16);          // biCompression
    bih.writeUInt32LE(w * h * 4, 20);  // biSizeImage
    // XOR: BGRA bottom-up
    const rowBytes = w * 4;
    const xor = Buffer.alloc(h * rowBytes);
    for (let y = 0; y < h; y++) {
      const dstRow = (h - 1 - y) * rowBytes; // bottom-up
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4;           // top-down source RGBA
        xor[dstRow + x * 4] = f.rgba[s + 2];     // B
        xor[dstRow + x * 4 + 1] = f.rgba[s + 1]; // G
        xor[dstRow + x * 4 + 2] = f.rgba[s];     // R
        xor[dstRow + x * 4 + 3] = f.rgba[s + 3]; // A
      }
    }
    // AND mask: 1bpp, each row padded to 4 bytes, all zeros (alpha handles it)
    const andRowBytes = ((w + 31) >> 5) * 4;
    const andMask = Buffer.alloc(h * andRowBytes);
    const data = Buffer.concat([bih, xor, andMask]);
    datas.push({ w, h, data });
  }

  let offset = 6 + N * 16;
  for (const d of datas) {
    const e = Buffer.alloc(16);
    e.writeUInt8(d.w === 256 ? 0 : d.w, 0);
    e.writeUInt8(d.h === 256 ? 0 : d.h, 1);
    e.writeUInt8(0, 2);   // colors
    e.writeUInt8(0, 3);   // reserved
    e.writeUInt16LE(1, 4);   // planes
    e.writeUInt16LE(32, 6);  // bitCount
    e.writeUInt32LE(d.data.length, 8); // bytesInRes
    e.writeUInt32LE(offset, 12);       // offset
    entries.push(e);
    offset += d.data.length;
  }
  return Buffer.concat([header, ...entries, ...datas.map((d) => d.data)]);
}

async function main() {
  await assertVortexNotLetterN(fs.readFileSync(SRC_PNG), SRC_PNG);
  const src = sharp(SRC_PNG);
  const bbox = await opaqueBBox(src);
  const gw = bbox.maxX - bbox.minX + 1;
  const gh = bbox.maxY - bbox.minY + 1;
  console.log(`source ${bbox.w}x${bbox.h} opaque bbox ${gw}x${gh} @(${bbox.minX},${bbox.minY})`);

  const crop = sharp(SRC_PNG)
    .extract({ left: bbox.minX, top: bbox.minY, width: gw, height: gh });

  // Enlarged source: plate fills TARGET_RATIO of a 1024 canvas.
  const CANVAS = 1024;
  const platePx = Math.round(CANVAS * TARGET_RATIO);
  const enlarged = await sharp({
    create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{
      input: await crop.resize(platePx, platePx, { kernel: 'lanczos3' }).png().toBuffer(),
      left: Math.round((CANVAS - platePx) / 2),
      top: Math.round((CANVAS - platePx) / 2),
    }])
    .png()
    .toBuffer();

  fs.writeFileSync(OUT_SRC_PNG, enlarged);
  console.log(`wrote ${OUT_SRC_PNG} (plate ${TARGET_RATIO} of ${CANVAS})`);

  // Frames for ICO: resize the enlarged 1024 source to each size.
  // 256 must be PNG (Win10); smaller sizes stay 32bpp BMP.
  const frames = [];
  for (const size of SIZES) {
    if (size === 256) {
      const png = await sharp(enlarged)
        .resize(size, size, { kernel: 'lanczos3' })
        .png()
        .toBuffer();
      frames.push({ width: size, height: size, png });
      continue;
    }
    const { data } = await sharp(enlarged)
      .resize(size, size, { kernel: 'lanczos3' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    frames.push({ width: size, height: size, rgba: data });
  }

  const png256 = frames.find((f) => f.width === 256)?.png;
  if (!png256) throw new Error('missing 256 PNG frame');
  await assertVortexNotLetterN(png256, 'ico 256 frame');

  for (const out of OUT_ICOS) {
    const ico = buildIco(frames);
    fs.writeFileSync(out, ico);
    console.log(`wrote ${out} (${ico.length} bytes, ${SIZES.length} frames)`);
  }

  const extraPngs = [
    path.join(ROOT, 'build/icon-win.png'),
    path.join(ROOT, 'apps/desktop/src/ui/renderer/assets/icon-win.png'),
  ];
  for (const outPng of extraPngs) {
    fs.writeFileSync(outPng, png256);
    console.log(`wrote ${outPng}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
