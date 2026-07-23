// Infusion (SPEC §14). A random secondary stat line rolled onto gear (weapon/armor/accessories).
// Nexon does not publish infusion success rates and the crowd-sourced ones are unreliable, so an
// infusion is NOT modeled as a costed gold-per-point move. Instead it surfaces as a pre-Upgrades
// CHECKLIST of per-slot GOALS: record what a piece currently has (folded into stat totals like
// tuning) and see which slots still fall short of the usual target. All logic here is pure; the
// recorded value lives on the loadout entry (`entry.infusion = { stat, amount }`).

// A piece holds ONE infusion line. Which scored stats a slot CAN roll, and the allowed amounts
// (game data, SPEC §14). Weapons + accessories share the same option set; armor is distinct;
// rhod/artifact cannot be infused.
export const INFUSION_STAT_LABEL = { bal: "Bal", crit: "Crit", critRes: "Crit Res", attSpd: "Att Spd", def: "Def" };

const ARMOR_SLOTS = new Set(["helm", "chest", "pant", "hand", "feet"]);
const NON_INFUSABLE = new Set(["rhod", "artifact"]);

// The infusion "kind" of a slot: "weapon" | "armor" | "accessory" | null (can't be infused).
export function infusionKind(slotId) {
  if (slotId === "weapon") return "weapon";
  if (ARMOR_SLOTS.has(slotId)) return "armor";
  if (NON_INFUSABLE.has(slotId)) return null;
  return "accessory"; // rings, belt, brooch, totem, necklace, earrings
}

// The stats a slot may be infused with → allowed amounts (for the checklist's dropdowns).
export function infusionOptions(slotId) {
  const k = infusionKind(slotId);
  if (!k) return {};
  if (k === "armor") return { critRes: [1, 2], def: [98, 99, 100, 101, 102, 103, 104, 105, 106, 107] };
  return { bal: [1, 2, 3], crit: [1, 2, 3], attSpd: [1] }; // weapon + accessory
}

// The RECOMMENDED target(s) for a slot (SPEC §14). The stat+amount the player usually aims for.
// EVERY non-armor piece (weapon + all accessories) aims for +2 Bal OR +2 Crit (a choice); armor →
// +2 Crit Res. Def is a POSSIBLE roll but never a recommended target.
export function infusionTargets(slotId) {
  const k = infusionKind(slotId);
  if (!k) return [];
  if (k === "armor") return [{ stat: "critRes", amount: 2 }];
  return [{ stat: "bal", amount: 2 }, { stat: "crit", amount: 2 }]; // weapon + accessories
}

// Status of a slot's CURRENT infusion vs its recommended target(s) (SPEC §14):
//   { applicable, status: "met" | "partial" | "none", met, suggested: [{stat, amount}…] }
//   - "met":     the slot has ≥ a target's amount of a target stat (e.g. +2 Bal, or +2 Crit Res).
//   - "partial": the slot has exactly +1 of a target stat (bal/crit for non-armor, crit res for
//                armor). On the right track, chase +2 of THAT committed stat (the alternative is
//                suppressed once committed).
//   - "none":    nothing on-goal (empty, or only an off-goal roll like Def) → suggest a first step.
// `met` is kept as a boolean alias of `status === "met"`.
export function infusionStatus(slotId, infusion) {
  const targets = infusionTargets(slotId);
  if (!targets.length) return { applicable: false, status: "none", met: false, suggested: [] };
  const cur = infusion && infusion.stat && infusion.amount ? infusion : null;
  const onTarget = cur && targets.some((t) => t.stat === cur.stat) ? cur : null; // on a goal stat
  if (onTarget && onTarget.amount >= 2)
    return { applicable: true, status: "met", met: true, suggested: [] };
  if (onTarget && onTarget.amount === 1) // +1 of a goal stat → chase +2 of the committed stat
    return { applicable: true, status: "partial", met: false, suggested: targets.filter((t) => t.stat === onTarget.stat) };
  return { applicable: true, status: "none", met: false, suggested: targets };
}
