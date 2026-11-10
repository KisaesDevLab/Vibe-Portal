// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Where the watermark goes on a page (P49). Plain JavaScript, so the worker that marks PDFs
// (watermark-worker.mjs) can load it without a TypeScript loader; types in the .d.mts beside it.
//
// The mark is centred on the page's visible area (the crop box, which need not start at 0,0),
// reads at 35 degrees whatever the page's /Rotate, and is made small enough that its whole
// box fits inside the visible area with a margin.

export const MARK_ANGLE = 35;
/** Share of the visible width and height the mark may take. */
const FILL = 0.85;
/** Largest letters, in points, on a big page. */
const MAX_SIZE = 40;
/** The text box in units of the font size: Helvetica's descender and cap height. */
const BELOW = 0.22;
const ABOVE = 0.72;

/**
 * @param {{ x: number, y: number, width: number, height: number }} box  the crop box
 * @param {number} rotation  the page's /Rotate, in degrees
 * @param {number} widthAtOne  the text's width at a font size of 1
 */
export function markLayout(box, rotation, widthAtOne) {
  // The viewer turns the page clockwise by /Rotate: drawing at 35 + rotation shows it at 35.
  const angle = (((MARK_ANGLE + rotation) % 360) + 360) % 360;
  const rad = (angle * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const tall = BELOW + ABOVE;
  // The rotated box of text `size` points high is size*(k|c| + t|s|) wide, size*(k|s| + t|c|) high.
  const size = Math.min(
    MAX_SIZE,
    (FILL * box.width) / (widthAtOne * Math.abs(c) + tall * Math.abs(s)),
    (FILL * box.height) / (widthAtOne * Math.abs(s) + tall * Math.abs(c)),
  );
  // The middle of the text, from where it starts on the baseline, after turning.
  const along = (widthAtOne * size) / 2;
  const up = ((ABOVE - BELOW) / 2) * size;
  const x = box.x + box.width / 2 - (along * c - up * s);
  const y = box.y + box.height / 2 - (along * s + up * c);
  return { x, y, size, angle };
}

/**
 * The four corners of the text's box once drawn, for tests: each must lie inside the crop box.
 * @param {{ x: number, y: number, size: number, angle: number }} at
 * @param {number} widthAtOne
 */
export function markCorners(at, widthAtOne) {
  const rad = (at.angle * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const w = widthAtOne * at.size;
  return [
    [0, -BELOW * at.size],
    [w, -BELOW * at.size],
    [w, ABOVE * at.size],
    [0, ABOVE * at.size],
  ].map(([u, v]) => [at.x + u * c - v * s, at.y + u * s + v * c]);
}
