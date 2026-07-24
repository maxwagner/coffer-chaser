// Google Apps Script: push sheet edits to GitHub, debounced.
//
// Lives IN THE SPREADSHEET (Extensions > Apps Script), not in this repo's runtime.
// This file is the reference copy. Paste it into the sheet's script editor.
//
// What it does: every edit resets a 10-minute timer; when the sheet has been quiet
// for 10 straight minutes, it fires ONE repository_dispatch to GitHub, which runs
// .github/workflows/refresh-data.yml (fetch tabs, commit data/*.csv if changed,
// Pages redeploys). A slow hour-long editing session = one push at the end.
//
// One-time setup:
// 1. Create a GitHub fine-grained personal access token:
//    github.com > Settings > Developer settings > Fine-grained tokens.
//    Repository access: only maxwagner/coffer-chaser.
//    Permissions: Contents: Read and write (repository_dispatch needs it).
// 2. In the sheet: Extensions > Apps Script, paste this file.
// 3. Project Settings (gear icon) > Script Properties > add:
//      GH_TOKEN = <the token>
// 4. Back in the editor: run `setup` once (grants permissions, installs the
//    onChange trigger). Approve the authorization prompts.
// 5. Test: edit a cell, wait ~10 min, check the repo's Actions tab for a
//    "Refresh data snapshots" run. Or run `firePush` manually for an instant test.

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
