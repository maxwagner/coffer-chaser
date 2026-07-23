// Character save slots + built-in gear presets (SPEC §9.1).
//
// The app optimizes ONE working loadout + stat block at a time, but the player runs
// many characters with different gear. A "profile" is a named snapshot of the swap
// unit, the loadout (all slots), the hand-entered stat totals, and the completed
// manual prep-goals (Checklist tab, §14.2) whose rewards are already folded into those
// totals, so switching characters is one click instead of re-editing every slot. The
// snapshot ALSO carries three OPTIONAL Planner fields (SPEC §17.5): the owned-items
// inventory, the manual gold total, and the planner path. Only vetoes stay global.
// Legacy records saved before those fields existed simply omit them; the caller keeps the
// working values on load rather than wiping (see loadWorkingState in index.html).
//
// This module is PURE: snapshot + CRUD list transforms only. Persistence, the working
// loadout/stats wiring, and the sidebar UI live inline in index.html.

// Deep-clone the swap unit (loadout + stats + completed-goal ids, plus the optional Planner
// extras). structuredClone drops any frozen-ness, so the returned copy is independently
// mutable and detached from the source objects, editing the working state after a snapshot
// never mutates a stored profile. `checklist` is an array of checked goal ids (optional;
// defaults to []). `inventory` ({name:qty}), `gold` (number), and `path` ({v,steps}) are
// OPTIONAL (SPEC §17.5): passing null/undefined omits the field entirely so a legacy caller
// or record stays field-for-field identical. `gold` of 0 is a real value and is kept.
export function snapshotState(loadout, stats, checklist = [], inventory = null, gold = null, path = null) {
  const snap = {
    loadout: structuredClone(loadout),
    stats: structuredClone(stats),
    checklist: [...checklist],
  };
  if (inventory != null) snap.inventory = structuredClone(inventory);
  if (gold != null) snap.gold = gold;
  if (path != null) snap.path = structuredClone(path);
  return snap;
}

// Fresh unique-ish id for a new profile (local single-user tool, no collision risk).
const newId = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// Build a profile record from the current working state. The swap unit is deep-cloned so the
// record is a frozen-in-time snapshot. `id`/`savedAt` are stamped when absent (a fresh
// save-as); passing an existing `id` re-snapshots that slot in place (keeps identity, bumps
// the timestamp). `inventory`/`gold`/`path` (SPEC §17.5) are optional and, when present on the
// snapshot, copied onto the record; omitting them yields a legacy-shaped record.
export function makeProfileRecord({ id, name, loadout, stats, checklist, savedAt, inventory, gold, path } = {}) {
  const snap = snapshotState(loadout, stats, checklist || [], inventory ?? null, gold ?? null, path ?? null);
  return {
    id: id || newId(),
    name: String(name || "").trim() || "Unnamed",
    loadout: snap.loadout,
    stats: snap.stats,
    checklist: snap.checklist,
    ...(snap.inventory != null ? { inventory: snap.inventory } : {}),
    ...(snap.gold != null ? { gold: snap.gold } : {}),
    ...(snap.path != null ? { path: snap.path } : {}),
    savedAt: savedAt || Date.now(),
  };
}

// Return a NEW list with `record` replacing the same-id entry, or appended if new.
export function upsertProfile(list, record) {
  const out = (list || []).slice();
  const i = out.findIndex((p) => p.id === record.id);
  if (i >= 0) out[i] = record; else out.push(record);
  return out;
}

// Return a NEW list without the entry with `id`.
export function removeProfile(list, id) {
  return (list || []).filter((p) => p.id !== id);
}

// Return a NEW list with the entry's name changed (trimmed; blank ignored).
export function renameProfile(list, id, name) {
  const nm = String(name || "").trim();
  if (!nm) return (list || []).slice();
  return (list || []).map((p) => (p.id === id ? { ...p, name: nm } : p));
}
