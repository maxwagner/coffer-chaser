// In-browser PP-OCRv4 (PaddleOCR on onnxruntime-web), self-hosted. Replaces the Tesseract.js
// engine for the Scanner (SPEC §16). The heavy runtime + models are a pre-built, vendored bundle
// (vendor/ppocr/, produced by `npm run build:ocr`); nothing is fetched from a CDN. Paths are
// resolved from this module's URL so they work at any site base (local, GitHub Pages subpath).
import Ocr, { ortEnv } from "../vendor/ppocr/ppocr.bundle.mjs";
import { ppDetectionsToWords, parseDetections, detectionsToLines } from "./scanner.js";

const asset = (p) => new URL(p, import.meta.url).href;

// Point onnxruntime-web at the vendored wasm and run multi-threaded. Threads need cross-origin
// isolation (SharedArrayBuffer) — supplied by COOP/COEP (serve.py locally, coi-serviceworker on
// GitHub Pages). Cap threads so we don't oversubscribe on high-core machines.
ortEnv.wasm.wasmPaths = asset("../vendor/ppocr/ort/");
ortEnv.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8);

let _ocrPromise = null;
function getOcr(onProgress) {
  if (!_ocrPromise) {
    onProgress?.({ status: "loading models" });
    _ocrPromise = Ocr.create({
      models: {
        detectionPath: asset("../vendor/ppocr/assets/ch_PP-OCRv4_det_infer.onnx"),
        recognitionPath: asset("../vendor/ppocr/assets/ch_PP-OCRv4_rec_infer.onnx"),
        dictionaryPath: asset("../vendor/ppocr/assets/ppocr_keys_v1.txt"),
      },
    });
  }
  return _ocrPromise;
}

// Run PP-OCR on an image blob → raw detections [{ text, mean (confidence 0..1), box }],
// where box is 4 corner points [[x0,y0],[x1,y0],[x1,y1],[x0,y1]].
export async function ppocrDetect(blob, { onProgress } = {}) {
  const ocr = await getOcr(onProgress);
  const url = URL.createObjectURL(blob);
  try {
    onProgress?.({ status: "recognizing" });
    return await ocr.detect(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// OCR one image blob → { entries, unpriced, review, height } (SPEC §16). PP-OCR gives clean
// per-line text + boxes; the pure adapter + parseDetections reuse the whole Tesseract-era
// post-processing (row grouping, wrapped-name continuation, cleanName, the caller's canonicalize +
// vocab-guarded `repair`). Name resolution is all done HERE (canonicalize → alias → repair) so the
// caller gets final names. Rows whose final name still isn't a known item are returned in `review`
// (with the row's `y` + `top`/`bottom` extent so the caller can crop that strip) for the human-in-the-loop alias UI; a
// bare fragment ("see", "ise") with no price is filtered out. `unpriced` = a KNOWN name whose price
// didn't parse (surfaced separately). `height` rides along for cropping.
// Map PP-OCR detection boxes from the lib's processed space (each dim ceil'd to a multiple of 32)
// back to true image (w×h) space. No-op when the image is already a multiple of 32. See scanImage.
function scaleDetections(detections, w, h) {
  const sx = w / (Math.ceil(w / 32) * 32), sy = h / (Math.ceil(h / 32) * 32);
  if (sx === 1 && sy === 1) return detections;
  return (detections || []).map((d) => ({ ...d, box: (d.box || []).map(([x, y]) => [x * sx, y * sy]) }));
}

export async function scanImage(blob, { canonicalize = (n) => n, isKnown = () => true, repair = (n) => n, onProgress } = {}) {
  const detections = await ppocrDetect(blob, { onProgress });
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, h = bmp.height;
  bmp.close?.();
  // PP-OCR (the @gutenye/ocr-browser lib) returns box coordinates in its DETECTION space, which is
  // each image dimension rounded UP to the next multiple of 32 (verified: 417→448, 798→800,
  // 1039→1056). Scale the boxes back to true image space so ABSOLUTE positions are right — the
  // review-row crop uses them, and the error grows with y (a bottom row lands ~half a row too low).
  // Relative logic (row grouping, price column) is unaffected either way; only the crop needs this.
  const scaled = scaleDetections(detections, w, h);
  const rows = await parseDetections(ppDetectionsToWords(scaled, w), w, h, { keepUnpriced: true });
  const entries = [];
  const unpricedNames = new Set();
  const review = [];
  const substantial = (n) => n.split(/\s+/).filter((s) => s.length >= 3).length >= 2;
  for (const r of rows) {
    let name = canonicalize(r.name);
    // A permanent-variant row whose name we couldn't resolve to a known item is noise: its base
    // scroll is listed separately (and is cheaper, so it wins the min). Drop it rather than surface
    // a garbled "…Enchant Scroll (Pe manent)" as "not in app".
    if (r.permanent && !isKnown(name)) continue;
    name = repair(name); // vocab-guarded junk repair may still snap it to a known item
    if (r.price != null) entries.push({ name, price: r.price });
    else if (name) unpricedNames.add(name);
    // Not a known item → hand to the review UI, but only if it's worth a human's time (has a price,
    // or reads like a real multi-word name — not a stray OCR fragment).
    if (!isKnown(name) && (r.price != null || substantial(name))) review.push({ name, price: r.price ?? null, y: r.y, top: r.top, bottom: r.bottom });
  }
  const priced = new Set(entries.map((e) => e.name.toLowerCase()));
  const unpriced = [...unpricedNames].filter((n) => !priced.has(n.toLowerCase()));
  return { entries, unpriced, review, height: h };
}

// OCR one raid-drop CHAT-LOG screenshot → { lines } (SPEC §16.8). The drop tracker parses the
// SYSTEM chat log, not the auction table, so this returns the raw joined text lines (via the pure
// detectionsToLines) and the caller runs parseDrops with its own actor matcher + price valuation.
export async function scanDropImage(blob, { onProgress } = {}) {
  const detections = await ppocrDetect(blob, { onProgress });
  const bmp = await createImageBitmap(blob);
  const h = bmp.height;
  bmp.close?.();
  return { lines: detectionsToLines(detections, h) };
}
