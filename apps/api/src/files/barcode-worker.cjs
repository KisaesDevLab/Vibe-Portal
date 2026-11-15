// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Addendum 01, layer A: reads the PDF417 barcode on the back of a driver's licence from a
// JPEG or PNG, in a process of its own (see barcode.ts): a fault in the WebAssembly reader
// ends this process, not the server, and the decoded photo's memory goes back when it exits.
// Plain JavaScript: it is run by node itself, outside tsx.
//
// zxing-cpp finds a tilted PDF417 but seldom reads it (a few degrees is enough), and reads a
// large photo worse than a small one. So: read the picture as it is; when that fails, cut out
// the square around where the barcode was found and read it again turned upright, a degree at
// a time either way, at a few sizes.

'use strict';

const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');

const req = createRequire(__filename);

/** The longest side the first read sees: a 12 MP photo is halved, a 48 MP one quartered. */
const FIRST_SIDE = 2600;
/** Sizes (across) the cut-out square is read at, largest first. */
const CROP_SIDES = [2000, 1400, 1000];
/** Degrees either way the cut-out is turned, about the angle the barcode was found at. */
const MAX_TURN = 30;

const OPTIONS = {
  formats: ['PDF417'],
  tryHarder: true,
  tryRotate: true,
  tryDownscale: true,
  returnErrors: true,
  maxNumberOfSymbols: 2,
  // Control characters as they are (the default writes a line feed as "<LF>").
  textMode: 'Plain',
};

/** One byte a pixel (luminance) from RGBA. */
function toGray(rgba, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return { data: out, width, height };
}

/** Every `f` by `f` pixels averaged into one. */
function shrink(img, f) {
  if (f <= 1) return img;
  const width = Math.floor(img.width / f);
  const height = Math.floor(img.height / f);
  const out = new Uint8Array(width * height);
  const area = f * f;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < f; dy += 1) {
        const row = (y * f + dy) * img.width + x * f;
        for (let dx = 0; dx < f; dx += 1) sum += img.data[row + dx];
      }
      out[y * width + x] = (sum / area) | 0;
    }
  }
  return { data: out, width, height };
}

/**
 * A `side` by `side` picture of the square of `img` centred on (cx, cy), `span` across, turned
 * by `degrees` (so a barcode found at that angle comes out level). Outside the picture: grey.
 */
function cutOut(img, cx, cy, span, degrees, side) {
  const out = new Uint8Array(side * side).fill(150);
  const k = span / side;
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a) * k;
  const sin = Math.sin(a) * k;
  const half = side / 2;
  const { data, width, height } = img;
  for (let y = 0; y < side; y += 1) {
    const v = y - half;
    for (let x = 0; x < side; x += 1) {
      const u = x - half;
      const sx = cx + u * cos - v * sin;
      const sy = cy + u * sin + v * cos;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * width + x0;
      const top = data[i] + (data[i + 1] - data[i]) * fx;
      const bottom = data[i + width] + (data[i + width + 1] - data[i + width]) * fx;
      out[y * side + x] = top + (bottom - top) * fy;
    }
  }
  return { data: out, width: side, height: side };
}

/** Edges made firmer (an unsharp mask over 3 by 3): a soft phone photo reads more often. */
function sharpen(img) {
  const { data, width, height } = img;
  const out = new Uint8Array(data);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const around =
        data[i - width - 1] + data[i - width] + data[i - width + 1] +
        data[i - 1] + data[i] + data[i + 1] +
        data[i + width - 1] + data[i + width] + data[i + width + 1];
      const v = data[i] + 1.5 * (data[i] - around / 9);
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return { data: out, width, height };
}

/** RGBA again, as the reader takes it. */
function toRgba(img) {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0, p = 0; i < img.data.length; i += 1, p += 4) {
    const g = img.data[i];
    out[p] = g;
    out[p + 1] = g;
    out[p + 2] = g;
    out[p + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

function decode(bytes, kind, maxMegapixels) {
  if (kind === 'png') {
    const png = req('pngjs').PNG.sync.read(Buffer.from(bytes));
    return toGray(png.data, png.width, png.height);
  }
  const jpeg = req('jpeg-js').decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: maxMegapixels,
    maxMemoryUsageInMB: maxMegapixels * 4 + 512,
  });
  return toGray(jpeg.data, jpeg.width, jpeg.height);
}

/** `job`: { bytes, kind: 'jpeg' | 'png', maxMegapixels, budgetMs }. */
async function main(job) {
  const zxing = req('zxing-wasm/reader');
  // The package would fetch its WebAssembly from a CDN: the appliance reads its own copy.
  const wasm = readFileSync(req.resolve('zxing-wasm/reader/zxing_reader.wasm'));
  await zxing.prepareZXingModule({
    overrides: {
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    },
    fireImmediately: true,
  });
  const deadline = Date.now() + job.budgetMs;
  const read = async (img) => zxing.readBarcodes(toRgba(img), OPTIONS);
  const textOf = (results) => {
    // A soft picture now and then "reads" as noise that passes the barcode's own checks:
    // only what begins as a licence barcode does (the standard's header) counts.
    const hit = results.find((r) => r.isValid && /^@[\s\S]{0,6}(ANSI |AAMVA)/.test(r.text));
    return hit ? hit.text : null;
  };

  const full = decode(job.bytes, job.kind, job.maxMegapixels);
  const f = Math.max(1, Math.ceil(Math.max(full.width, full.height) / FIRST_SIDE));
  const first = shrink(full, f);
  const results = await read(first);
  let text = textOf(results);
  if (text) return text;

  // Where a barcode was found but not read, in the full picture's pixels; else the whole.
  const found = results.find((r) => r.position);
  let cx = full.width / 2;
  let cy = full.height / 2;
  let span = Math.max(full.width, full.height);
  let level = 0;
  if (found) {
    const p = found.position;
    const xs = [p.topLeft.x, p.topRight.x, p.bottomLeft.x, p.bottomRight.x];
    const ys = [p.topLeft.y, p.topRight.y, p.bottomLeft.y, p.bottomRight.y];
    const wide = Math.max(...xs) - Math.min(...xs);
    const tall = Math.max(...ys) - Math.min(...ys);
    if (wide > 20 && tall > 5) {
      cx = ((Math.min(...xs) + Math.max(...xs)) / 2) * f;
      cy = ((Math.min(...ys) + Math.max(...ys)) / 2) * f;
      span = Math.min(span, Math.max(wide, tall) * 1.5 * f);
      level = (Math.atan2(p.topRight.y - p.topLeft.y, p.topRight.x - p.topLeft.x) * 180) / Math.PI;
    }
  }
  // Sampled from a copy shrunk to about the size wanted, so a small cut-out of a large photo
  // is an average, not every fourth pixel.
  const sources = new Map();
  const sourceFor = (side) => {
    const g = Math.max(1, Math.floor(span / side));
    if (!sources.has(g)) sources.set(g, shrink(full, g));
    return { img: sources.get(g), g };
  };
  const sides = CROP_SIDES.filter((s, i) => i === 0 || s < span);
  for (let turn = 0; turn <= MAX_TURN; turn += 1) {
    for (const sign of turn === 0 ? [1] : [1, -1]) {
      for (const side of sides) {
        if (Date.now() > deadline) return null;
        const size = Math.min(side, Math.round(span));
        const { img, g } = sourceFor(size);
        const cut = cutOut(img, cx / g, cy / g, span / g, level + sign * turn, size);
        text = textOf(await read(cut)) || textOf(await read(sharpen(cut)));
        if (text) return text;
      }
    }
  }
  return null;
}

process.once('message', (job) => {
  main(job)
    .then((text) => ({ ok: true, text, peakMb: Math.round(process.resourceUsage().maxRSS / 1024) }))
    .catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
    .then((answer) => process.send(answer, () => process.exit(0)));
});
