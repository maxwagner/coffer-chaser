// Google Apps Script: push sheet edits to GitHub, debounced.
//
// Edited locally in the repo (scripts/sheets/) and deployed with
// `npm run sheets:push` (clasp). Do not paste by hand.
//
// What it does: every edit resets a 10-minute timer; when the sheet has been quiet
// for 10 straight minutes, it fires ONE repository_dispatch to GitHub, which runs
// .github/workflows/refresh-data.yml (fetch tabs, commit data/*.csv if changed,
// Pages redeploys). A slow hour-long editing session = one push at the end.
// Manual pushes: sidebar "Push Now" button and the menu's "Push to Site".
//
// One-time setup (already done for this sheet; here for rebuild-from-scratch):
// 1. GitHub fine-grained personal access token, repository access ONLY
//    maxwagner/coffer-chaser, permission Contents: Read and write. "Public
//    repositories" access mode is read-only and 403s repository_dispatch.
// 2. Apps Script Project Settings (gear icon) > Script Properties:
//      GH_TOKEN = <the token>
// 3. Run `setup` once in the script editor (installs the onChange trigger).
// 4. Test with the sidebar's Push Now: expect a "Refresh data snapshots" run
//    in the repo's Actions tab.

const REPO = "maxwagner/coffer-chaser";
const DEBOUNCE_MINUTES = 10;

// Run this once by hand to install the onChange trigger.
function setup() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "queuePush")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("queuePush")
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onChange()
    .create();
}

// onChange handler: trailing debounce. Delete any pending firePush timer and
// schedule a fresh one DEBOUNCE_MINUTES out, so the push only happens once the
// sheet has been idle that long.
function queuePush() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // another edit is already rescheduling
  try {
    ScriptApp.getProjectTriggers()
      .filter((t) => t.getHandlerFunction() === "firePush")
      .forEach((t) => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger("firePush")
      .timeBased()
      .after(DEBOUNCE_MINUTES * 60 * 1000)
      .create();
  } finally {
    lock.releaseLock();
  }
}

// Manual push for the sidebar: fire immediately, cancel any pending debounce timer
// (firePush deletes them), and return a result object for the sidebar to display.
function pushNow() {
  try {
    firePush();
    return { ok: true, msg: "Push sent. The refresh workflow is starting; data lands in ~2-3 min." };
  } catch (e) {
    return { ok: false, msg: String(e.message || e) };
  }
}

// Same manual push, but for the 🪙 menu (menu items can't render a sidebar msg box).
function pushToSiteMenu() {
  const res = pushNow();
  SpreadsheetApp.getUi().alert(res.ok ? "✓ " + res.msg : "Push failed: " + res.msg);
}

// The debounced payload: one repository_dispatch, then clean up our own trigger.
function firePush() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "firePush")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  const token = PropertiesService.getScriptProperties().getProperty("GH_TOKEN");
  if (!token) throw new Error("Script property GH_TOKEN is not set");
  const res = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: "post",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
    contentType: "application/json",
    payload: JSON.stringify({ event_type: "sheet-updated" }),
    muteHttpExceptions: true,
  });
  // 204 = accepted. Anything else surfaces in the Apps Script execution log.
  if (res.getResponseCode() !== 204) {
    throw new Error(`GitHub dispatch failed: HTTP ${res.getResponseCode()} ${res.getContentText()}`);
  }
}