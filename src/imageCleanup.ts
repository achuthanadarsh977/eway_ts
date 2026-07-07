/**
 * Auto-cleanup for photographed (as opposed to already-scanned) e-Way Bill
 * images: detect the document's edges against a cluttered background
 * (desk/wood table, other papers), deskew/crop to just the document, then
 * enhance contrast/sharpness and upscale small photos — all before the
 * image is ever sent to the vision model. Pure JS (Jimp), no native
 * binaries, so it runs fine in Netlify Functions.
 *
 * This generalizes the manual point-picking + line-fitting approach used
 * to clean up a specific hard photo during development: sample brightness
 * transitions along many rows/columns, fit a line per edge with one round
 * of outlier rejection, and only trust the result if it's a plausible
 * document-sized quadrilateral. If detection isn't confident, the image is
 * passed through with just mild enhancement rather than risking a bad crop.
 */
import Jimp = require("jimp");
import exifr from "exifr";

type Point = [number, number];

export interface CleanupResult {
  buffer: Buffer;
  mime: string;
  cleaned: boolean;
  reason: string;
}

// Consecutive dark pixels required to call it "background" once we're
// walking outward from inside the document. Needs to be comfortably wider
// than any solid-black interior feature (QR finder-pattern squares, thick
// table rules) so it isn't mistaken for the document's actual edge.
const RUN_LENGTH = 35;
const SAMPLE_LINES = 24; // columns/rows sampled per edge

// ---------- small linear-algebra helpers ----------

function fitLineWithOutlierRejection(pts: Point[]): { m: number; b: number; pts: Point[] } | null {
  if (pts.length < 4) return null;
  const fit = (p: Point[]) => {
    const n = p.length;
    const sx = p.reduce((s, [x]) => s + x, 0);
    const sy = p.reduce((s, [, y]) => s + y, 0);
    const sxx = p.reduce((s, [x]) => s + x * x, 0);
    const sxy = p.reduce((s, [x, y]) => s + x * y, 0);
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-6) return null;
    const m = (n * sxy - sx * sy) / denom;
    const b = (sy - m * sx) / n;
    return { m, b };
  };
  let current = pts;
  let result = fit(current);
  if (!result) return null;
  // Two rounds of reject-and-refit catches the case where one outlier
  // masks another until the first is removed.
  for (let round = 0; round < 2; round++) {
    const residuals = current.map(([x, y]) => y - (result!.m * x + result!.b));
    const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
    const std = Math.sqrt(residuals.reduce((s, r) => s + (r - mean) ** 2, 0) / residuals.length) || 1;
    const kept = current.filter((_, i) => Math.abs(residuals[i] - mean) <= 2 * std);
    if (kept.length < 4 || kept.length === current.length) break;
    const refit = fit(kept);
    if (!refit) break;
    current = kept;
    result = refit;
  }
  return { ...result, pts: current };
}

function gaussianSolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-9) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

// Solves the homography H (3x3, h33=1) with dst = H(src) for 4 point pairs,
// returned as [h11,h12,h13,h21,h22,h23,h31,h32].
function solveHomography(srcPts: Point[], dstPts: Point[]): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = srcPts[i];
    const [X, Y] = dstPts[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  return gaussianSolve(A, b);
}

function applyHomography(h: number[], x: number, y: number): Point {
  const [h11, h12, h13, h21, h22, h23, h31, h32] = h;
  const denom = h31 * x + h32 * y + 1;
  return [(h11 * x + h12 * y + h13) / denom, (h21 * x + h22 * y + h23) / denom];
}

// ---------- edge detection on a raw luminance buffer ----------

function luminance(data: Buffer | Uint8Array, idx: number): number {
  const r = data[idx],
    g = data[idx + 1],
    b = data[idx + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function otsuThreshold(data: Buffer | Uint8Array, w: number, h: number): number {
  const hist = new Array(256).fill(0);
  const stepX = Math.max(1, Math.floor(w / 200));
  const stepY = Math.max(1, Math.floor(h / 400));
  let total = 0;
  for (let y = 0; y < h; y += stepY) {
    for (let x = 0; x < w; x += stepX) {
      const lum = luminance(data, (y * w + x) * 4);
      hist[Math.min(255, Math.max(0, Math.round(lum)))]++;
      total++;
    }
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0,
    wB = 0,
    maxVar = 0,
    threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

// Walks outward from a point already known to be inside the document,
// tracking the last "bright" (paper) pixel seen. Stops at the first
// SUSTAINED run of dark pixels — that's the true document edge. A short
// dark run (a text stroke, a table rule, a QR module) is skipped rather
// than mistaken for the edge. Critically, this can't be fooled by a second
// bright object (another paper, a reflection) further out past the real
// edge, because it never gets that far — unlike scanning inward from the
// frame border, which stops at the FIRST bright run it meets, whichever
// object that happens to be.
function boundaryOutward(lumAt: (i: number) => number, start: number, dir: 1 | -1, limit: number, thresh: number): number | null {
  // The anchor itself might land on a stray dark pixel (a text stroke, a
  // QR module) even though it's well inside the document — nudge outward
  // a little first to find solid ground before walking to the real edge.
  let anchor = -1;
  for (let d = 0; d <= 20; d++) {
    const a = start + d * dir;
    if (a >= 0 && a < limit && lumAt(a) >= thresh) {
      anchor = a;
      break;
    }
  }
  if (anchor === -1) return null;
  let i = anchor;
  let lastBright = anchor;
  while (i >= 0 && i < limit) {
    if (lumAt(i) >= thresh) {
      lastBright = i;
      i += dir;
      continue;
    }
    let run = 0;
    let probe = i;
    while (probe >= 0 && probe < limit && run < RUN_LENGTH) {
      if (lumAt(probe) < thresh) {
        run++;
        probe += dir;
      } else {
        break;
      }
    }
    if (run >= RUN_LENGTH) return lastBright;
    i = probe + dir; // skip past the short dark speck and keep going
  }
  return lastBright;
}

function columnBoundaryOutward(
  data: Buffer | Uint8Array,
  w: number,
  h: number,
  x: number,
  yStart: number,
  dir: 1 | -1,
  thresh: number
): number | null {
  return boundaryOutward((y) => luminance(data, (y * w + x) * 4), yStart, dir, h, thresh);
}

function rowBoundaryOutward(
  data: Buffer | Uint8Array,
  w: number,
  y: number,
  xStart: number,
  dir: 1 | -1,
  thresh: number
): number | null {
  return boundaryOutward((x) => luminance(data, (y * w + x) * 4), xStart, dir, w, thresh);
}

interface DetectedQuad {
  corners: [Point, Point, Point, Point]; // TL, TR, BR, BL
  fractionOfFrame: number;
  allEdgesAtFrame: boolean;
}

function detectDocumentQuad(data: Buffer | Uint8Array, w: number, h: number): DetectedQuad | null {
  const thresh = otsuThreshold(data, w, h) * 0.92;

  const yCenter = Math.round(h * 0.5);
  const xCenter = Math.round(w * 0.5);

  const topPts: Point[] = [];
  const botPts: Point[] = [];
  for (let i = 0; i < SAMPLE_LINES; i++) {
    const x = Math.round(((i + 0.5) / SAMPLE_LINES) * (w - 1));
    const yTop = columnBoundaryOutward(data, w, h, x, yCenter, -1, thresh);
    if (yTop !== null) topPts.push([x, yTop]);
    const yBot = columnBoundaryOutward(data, w, h, x, yCenter, 1, thresh);
    if (yBot !== null) botPts.push([x, yBot]);
  }

  const topFit = fitLineWithOutlierRejection(topPts);
  const botFit = fitLineWithOutlierRejection(botPts);

  // Sample left/right only within the vertical span the document actually
  // occupies (inset a bit) — rows above/below that are background by
  // definition and have no real side edge to find, so including them just
  // risks anchoring on unrelated clutter.
  const approxTop = topFit ? topFit.m * xCenter + topFit.b : 0;
  const approxBot = botFit ? botFit.m * xCenter + botFit.b : h - 1;
  const inset = (approxBot - approxTop) * 0.12;
  const yLo = Math.max(0, Math.min(h - 1, approxTop + inset));
  const yHi = Math.max(0, Math.min(h - 1, approxBot - inset));

  const leftPts: Point[] = [];
  const rightPts: Point[] = [];
  for (let i = 0; i < SAMPLE_LINES; i++) {
    const y = Math.round(yLo + ((i + 0.5) / SAMPLE_LINES) * (yHi - yLo));
    const xLeft = rowBoundaryOutward(data, w, y, xCenter, -1, thresh);
    if (xLeft !== null) leftPts.push([y, xLeft]); // stored as (y, x) so the same fitter works
    const xRight = rowBoundaryOutward(data, w, y, xCenter, 1, thresh);
    if (xRight !== null) rightPts.push([y, xRight]);
  }

  const leftFit = fitLineWithOutlierRejection(leftPts);
  const rightFit = fitLineWithOutlierRejection(rightPts);

  if (process.env.DEBUG_QUAD) {
    console.error("thresh", thresh);
    console.error("topPts", topPts.length, topPts.slice(0, 5), "...");
    console.error("botPts", botPts.length, botPts.slice(0, 5), "...");
    console.error("leftPts", leftPts.length, leftPts.slice(0, 5), "...");
    console.error("rightPts", rightPts.length, rightPts.slice(0, 5), "...");
    console.error("topFit", topFit);
    console.error("botFit", botFit);
    console.error("leftFit", leftFit);
    console.error("rightFit", rightFit);
  }

  if (!topFit || !botFit) return null; // top/bottom are required; sides may fall back to frame edges

  const yAt = (fit: { m: number; b: number }, x: number) => fit.m * x + fit.b;
  const xAt = (fit: { m: number; b: number }, y: number) => fit.m * y + fit.b; // left/right fits are in (y,x) space

  const leftAtFrame = !leftFit;
  const rightAtFrame = !rightFit;

  // Approximating each corner as the fitted edge evaluated at the
  // frame-relative position is sufficient for the mild tilts this handles,
  // and matches the manually-validated approach from development.
  const TLx = leftAtFrame ? 0 : xAt(leftFit!, yAt(topFit, 0));
  const TLy = yAt(topFit, TLx);
  const TRx = rightAtFrame ? w - 1 : xAt(rightFit!, yAt(topFit, w - 1));
  const TRy = yAt(topFit, TRx);
  const BRx = rightAtFrame ? w - 1 : xAt(rightFit!, yAt(botFit, w - 1));
  const BRy = yAt(botFit, BRx);
  const BLx = leftAtFrame ? 0 : xAt(leftFit!, yAt(botFit, 0));
  const BLy = yAt(botFit, BLx);

  const corners: [Point, Point, Point, Point] = [
    [TLx, TLy],
    [TRx, TRy],
    [BRx, BRy],
    [BLx, BLy],
  ];

  const shoelace = (pts: Point[]) => {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area) / 2;
  };
  const fractionOfFrame = shoelace(corners) / (w * h);

  const nearFrame = (v: number, edge: number, tol: number) => Math.abs(v - edge) <= tol;
  const tolX = w * 0.015;
  const tolY = h * 0.015;
  const allEdgesAtFrame =
    nearFrame(TLy, 0, tolY) &&
    nearFrame(TRy, 0, tolY) &&
    nearFrame(BLy, h - 1, tolY) &&
    nearFrame(BRy, h - 1, tolY) &&
    nearFrame(TLx, 0, tolX) &&
    nearFrame(BLx, 0, tolX) &&
    nearFrame(TRx, w - 1, tolX) &&
    nearFrame(BRx, w - 1, tolX);

  if (process.env.DEBUG_QUAD) {
    console.error("corners", corners);
    console.error("fractionOfFrame", fractionOfFrame);
  }

  return { corners, fractionOfFrame, allEdgesAtFrame };
}

// ---------- perspective warp (bilinear, operates on raw RGBA buffers) ----------

function bilinearSample(data: Buffer | Uint8Array, w: number, h: number, sx: number, sy: number): [number, number, number, number] {
  const cx = Math.min(Math.max(sx, 0), w - 1.001);
  const cy = Math.min(Math.max(sy, 0), h - 1.001);
  const x0 = Math.floor(cx),
    y0 = Math.floor(cy);
  const x1 = x0 + 1,
    y1 = y0 + 1;
  const fx = cx - x0,
    fy = cy - y0;
  const px = (xx: number, yy: number, c: number) => data[(yy * w + xx) * 4 + c];
  const out: number[] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = px(x0, y0, c) * (1 - fx) + px(x1, y0, c) * fx;
    const bot = px(x0, y1, c) * (1 - fx) + px(x1, y1, c) * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out as [number, number, number, number];
}

function warpPerspective(
  src: Buffer,
  srcW: number,
  srcH: number,
  corners: [Point, Point, Point, Point],
  dstW: number,
  dstH: number
): Buffer {
  const dstCorners: Point[] = [
    [0, 0],
    [dstW - 1, 0],
    [dstW - 1, dstH - 1],
    [0, dstH - 1],
  ];
  const H = solveHomography(dstCorners, corners); // dest -> source
  const out = Buffer.alloc(dstW * dstH * 4);
  if (!H) return out;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const [sx, sy] = applyHomography(H, dx, dy);
      const [r, g, b, a] = bilinearSample(src, srcW, srcH, sx, sy);
      const o = (dy * dstW + dx) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return out;
}

// ---------- public API ----------

export async function cleanupImage(inputBuffer: Buffer): Promise<CleanupResult> {
  let oriented = inputBuffer;
  try {
    const orientation = await exifr.orientation(inputBuffer);
    if (orientation && orientation !== 1) {
      const img: any = await Jimp.read(inputBuffer);
      const rotateMap: Record<number, number> = { 3: 180, 6: 90, 8: 270 };
      const deg = rotateMap[orientation];
      if (deg) {
        img.rotate(deg);
        oriented = await img.getBufferAsync(Jimp.MIME_JPEG);
      }
    }
  } catch {
    // No EXIF or unreadable — proceed with the buffer as-is.
  }

  const img: any = await Jimp.read(oriented);
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const data = img.bitmap.data;

  const quad = detectDocumentQuad(data, w, h);

  let working: any = img;
  let cleaned = false;
  let reason = "no document edges confidently detected — passed through with light enhancement only";

  if (quad && quad.fractionOfFrame >= 0.2 && quad.fractionOfFrame <= 1.02 && !quad.allEdgesAtFrame) {
    const outW = Math.round(
      Math.max(
        Math.hypot(quad.corners[1][0] - quad.corners[0][0], quad.corners[1][1] - quad.corners[0][1]),
        Math.hypot(quad.corners[2][0] - quad.corners[3][0], quad.corners[2][1] - quad.corners[3][1])
      )
    );
    const outH = Math.round(
      Math.max(
        Math.hypot(quad.corners[3][0] - quad.corners[0][0], quad.corners[3][1] - quad.corners[0][1]),
        Math.hypot(quad.corners[2][0] - quad.corners[1][0], quad.corners[2][1] - quad.corners[1][1])
      )
    );
    const warped = warpPerspective(Buffer.from(data), w, h, quad.corners, outW, outH);
    working = new Jimp({ data: warped, width: outW, height: outH });
    cleaned = true;
    reason = "detected a tilted/cropped document against a cluttered background — deskewed and cropped";
  } else if (quad && quad.allEdgesAtFrame) {
    reason = "document already fills the frame with no background clutter — skipped crop";
  }

  // Mild "scanner-style" enhancement always applied; upscale only if the
  // working image is small enough that a vision model would struggle with
  // fine print (GSTINs, IRNs).
  working.contrast(0.12).brightness(0.06);
  working.convolute([
    [0, -1, 0],
    [-1, 5, -1],
    [0, -1, 0],
  ]);
  if (Math.max(working.bitmap.width, working.bitmap.height) < 1400) {
    working.scale(2, Jimp.RESIZE_BILINEAR);
    cleaned = true;
  }

  working.quality(92);
  const outBuffer: Buffer = await working.getBufferAsync(Jimp.MIME_JPEG);
  return { buffer: outBuffer, mime: "image/jpeg", cleaned, reason };
}
