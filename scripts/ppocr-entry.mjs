// Bundle entry: re-export the OCR class PLUS onnxruntime-web's `env` (the SAME instance the
// bundled library uses), so js/ppocr.js can point `env.wasm.wasmPaths` at the self-hosted wasm
// and force single-threaded (no worker file to host) before creating any inference session.
import Ocr from "@gutenye/ocr-browser";
import { env } from "onnxruntime-web";

export default Ocr;
export { env as ortEnv };
