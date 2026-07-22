/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
// Enables cross-origin isolation (crossOriginIsolated → SharedArrayBuffer → onnxruntime-web wasm
// THREADS) on hosts that can't send COOP/COEP headers, notably GitHub Pages. It injects those
// headers via a service worker. Locally, serve.py already sends the headers, so this registers as
// a no-op (it bails when crossOriginIsolated is already true). The Scanner's PP-OCR needs threads;
// without isolation the wasm falls back to one unusable core.
let coepCredentialless = false;
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (!ev.data) return;
    if (ev.data.type === "deregister") {
      self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => clients.forEach((client) => client.navigate(client.url)));
    } else if (ev.data.type === "coepCredentialless") {
      coepCredentialless = ev.data.value;
    }
  });

  self.addEventListener("fetch", function (event) {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
    const request = (coepCredentialless && r.mode === "no-cors") ? new Request(r, { credentials: "omit" }) : r;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response;
          const newHeaders = new Headers(response.headers);
          newHeaders.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
          if (!coepCredentialless) newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
        })
        .catch((e) => console.error(e))
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    const coi = {
      shouldRegister: () => !reloadedBySelf,
      shouldDeregister: () => false,
      coepCredentialless: () => !(window.chrome !== undefined || window.netscape !== undefined),
      coepDegrade: () => true,
      doReload: () => window.location.reload(),
      quiet: false,
      ...window.coi,
    };

    const n = navigator;
    if (n.serviceWorker && n.serviceWorker.controller) {
      n.serviceWorker.controller.postMessage({ type: "coepCredentialless", value: coi.coepCredentialless() });
      if (coi.shouldDeregister()) n.serviceWorker.controller.postMessage({ type: "deregister" });
    }

    // If we're already coi: do nothing. Perhaps it's due to serving over https (or localhost with headers).
    if (window.crossOriginIsolated !== false || !coi.shouldRegister()) return;

    if (!window.isSecureContext) {
      !coi.quiet && console.log("COOP/COEP Service Worker not registered, a secure context is required.");
      return;
    }

    // In some environments (e.g. Firefox private mode) this won't be available
    if (!n.serviceWorker) {
      !coi.quiet && console.error("COOP/COEP Service Worker not registered, perhaps due to private mode.");
      return;
    }

    n.serviceWorker.register(window.document.currentScript.src).then(
      (registration) => {
        !coi.quiet && console.log("COOP/COEP Service Worker registered", registration.scope);
        registration.addEventListener("updatefound", () => {
          !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");
          window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");
          coi.doReload();
        });
        if (registration.active && !n.serviceWorker.controller) {
          !coi.quiet && console.log("Reloading page to make use of COOP/COEP Service Worker.");
          window.sessionStorage.setItem("coiReloadedBySelf", "notcontrolling");
          coi.doReload();
        }
      },
      (err) => {
        !coi.quiet && console.error("COOP/COEP Service Worker failed to register:", err);
      }
    );
  })();
}
