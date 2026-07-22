// GIF frame decoding for the Scanner raid-drop tracker (SPEC §16.8). A GIF is just a sequence of
// frames; decode them with the browser-native WebCodecs ImageDecoder (no library) → PNG blobs, one
// per KEPT frame, to feed the same per-image OCR path as a screenshot. A cheap average-hash
// frame-diff drops frames that look unchanged from the last kept one (nothing new scrolled in) so a
// long GIF doesn't explode OCR time; the caller then dedups at the LINE level (mergeGifFrameLines
// in scanner.js) to absorb the scroll overlap between the frames we do keep. Browser-only
// (ImageDecoder/canvas) — not unit-tested; the line dedup that follows IS pure + tested.

// True for a GIF blob/File (by MIME, falling back to the .gif extension for pasted/renamed files).
export function isGif(blob) {
  return !!blob && (blob.type === "image/gif" || /\.gif$/i.test(blob?.name || ""));
}

// 8×8 grayscale average-hash of a drawable source → Uint8Array(64) of 0/1 bits (each pixel vs the
// frame mean). Hamming distance between two hashes is a robust "did the picture change" signal.
function aHash(source) {
  const n = 8;
  const c = document.createElement("canvas"); c.width = n; c.height = n;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  const gray = new Array(n * n);
  let sum = 0;
  for (let i = 0; i < n * n; i++) { const g = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; gray[i] = g; sum += g; }
  const mean = sum / (n * n);
  const bits = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) bits[i] = gray[i] >= mean ? 1 : 0;
  return bits;
}
function hamming(a, b) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }

const canvasToBlob = (canvas) => new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));

// Decode a GIF blob → array of frame PNG blobs. Consecutive frames whose 8×8 average-hash is within
// `hashTol` of the last KEPT frame are skipped (visually unchanged → nothing new to OCR); at most
// `maxFrames` are kept, so a long GIF can't run away (the earliest frames win — a chat log only
// grows downward, so the tail is captured by later kept frames scrolling into view).
export async function gifToFrames(blob, { maxFrames = 60, hashTol = 4, onProgress } = {}) {
  if (typeof ImageDecoder === "undefined") throw new Error("This browser can't decode GIFs (needs WebCodecs ImageDecoder).");
  const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type: "image/gif" });
  await dec.tracks.ready;
  const total = dec.tracks.selectedTrack?.frameCount || 0; // 0 → unknown; decode until RangeError
  const frames = [];
  let lastHash = null;
  for (let i = 0; total ? i < total : true; i++) {
    let result;
    try { result = await dec.decode({ frameIndex: i }); }
    catch { break; } // past the last frame when frameCount was unknown
    const img = result.image;
    const w = img.displayWidth || img.codedWidth;
    const h = img.displayHeight || img.codedHeight;
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const hash = aHash(canvas);
    img.close();
    if (lastHash && hamming(hash, lastHash) <= hashTol) continue; // unchanged frame — don't OCR it
    lastHash = hash;
    frames.push(await canvasToBlob(canvas));
    onProgress?.({ frame: frames.length });
    if (frames.length >= maxFrames) break;
  }
  dec.close?.();
  return frames;
}
