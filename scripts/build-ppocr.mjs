// Dev-only build step (NOT run at page load). Bundles @gutenye/ocr-browser (PaddleOCR PP-OCRv4
// on onnxruntime-web) + its deps into ONE self-hosted ESM file, so the shipped site stays plain
// static files — GitHub Pages just serves the pre-built bundle + the vendored .wasm/.onnx assets.
// Rerun only when the OCR deps are bumped:  npm run build:ocr
//
// Notes:
// - opencv-js (used by the detection post-process) references node builtins (fs/path/...) behind
//   emscripten's ENVIRONMENT_IS_NODE guard; they never execute in the browser, so we stub them empty.
// - onnxruntime-web loads its .wasm at runtime from `ort.env.wasm.wasmPaths` (set in js/ppocr.js),
//   so the .wasm is NOT bundled — it's vendored under vendor/ppocr/ort/ and served as a static file.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Resolve node builtins (and their node:-prefixed forms) to an empty module for the browser build.
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(b) {
    const builtins = /^(node:)?(fs|path|crypto|os|module|worker_threads|perf_hooks|util|stream)$/;
    b.onResolve({ filter: builtins }, (args) => ({ path: args.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {}; export const __esModule = true;", loader: "js" }));
  },
};

await build({
  entryPoints: [resolve(root, "scripts/ppocr-entry.mjs")],
  outfile: resolve(root, "vendor/ppocr/ppocr.bundle.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  legalComments: "none",
  external: ["*.wasm"], // onnxruntime-web fetches its wasm at runtime via wasmPaths
  // Use the CPU './wasm' build with multi-threading (SharedArrayBuffer). Cross-origin isolation is
  // supplied by COOP/COEP headers (serve.py locally; a coi-serviceworker on GitHub Pages). Vendored
  // wasm is the 13MB ort-wasm-simd-threaded.wasm + its glue .mjs.
  alias: { "onnxruntime-web": "onnxruntime-web/wasm" },
  plugins: [stubNodeBuiltins],
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
});

console.log("built vendor/ppocr/ppocr.bundle.mjs");
