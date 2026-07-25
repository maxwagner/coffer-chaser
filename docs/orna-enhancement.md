# Orna +12 → +15 enhancement

Reference for the Orna weapon/armor enhancement mechanic, and a record of how the
app models it.

## Why this file exists

Orna gear used to be the app's one special case. Every other gear upgrade is a row
on the **Crafting** tab (previous tier listed as a material, `craftCost` recurses
down the chain); Orna's +12 → +15 climb instead lived on its own **Orna** tab with
its own loader, its own expected-value coster, and its own move kind.

We folded Orna into Crafting like everything else by **baking the expected number
of attempts into the recipe quantities**. The rates below no longer live in the app
at all — they are pre-multiplied into the numbers on the Crafting tab.

This is safe because Orna's rates are fixed game data that has never changed, and
Orna is on its way out: once base Uaithne becomes the free starting set, Orna
leaves the app entirely.

## The mechanic

Enhancing a piece one `+` level is a single attempt that costs a flat gold fee plus
materials. **Failure keeps the level** — you lose the fee and the materials but not
the item, so there is no risk of destruction and no downgrade. Each consecutive
failure raises the success rate, and the last rate in a step is 100% (guaranteed),
so a step always terminates.

Rates are community-sourced; Nexon does not publish them in-game.

### Success rates (absolute, per attempt)

| Step | 1st | after 1 fail | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| +12 → +13 | 20% | 22% | 25% | 100% | — | — |
| +13 → +14 | 16% | 18% | 21% | 26% | 100% | — |
| +14 → +15 | 12% | 14% | 17% | 22% | 25% | 100% |

These are **absolute** per-attempt rates, not additive pity bonuses. (The accessory
enhancement table on the Accessories tab uses additive bonuses — different shape,
don't mix them up.)

### Per-attempt cost

| Step | Gold | Superior Enhancement Elixir | New Era Stone |
|---|---|---|---|
| +12 → +13 | 96,300 | 8 | 8 |
| +13 → +14 | 110,700 | 9 | 9 |
| +14 → +15 | 126,900 | 10 | 10 |

Identical for all six slots (Weapon, Helm, Mail, Greaves, Gauntlets, Boots).

## Expected attempts

Because failure keeps the level, a step is a finite series:

```
E[attempts] = Σ_k P(reaching attempt k) = Σ_k Π_{j<k} (1 − p_j)
```

terminating at the guaranteed attempt.

| Step | Series | E[attempts] |
|---|---|---|
| +12 → +13 | 1 + 0.800 + 0.624 + 0.468 | **2.892** |
| +13 → +14 | 1 + 0.840 + 0.6888 + 0.544152 + 0.40267248 | **3.47562448** |
| +14 → +15 | 1 + 0.880 + 0.7568 + 0.628144 + 0.48995232 + 0.36746424 | **4.12236056** |

## What the Crafting tab holds

Per-attempt cost × E[attempts], with the previous tier consumed **once** (it
survives failures, so it is not multiplied).

| Step | Gold | Elixir | Stone |
|---|---|---|---|
| +12 → +13 | 278,500 | 23 | 23 |
| +13 → +14 | 384,752 | 31 | 31 |
| +14 → +15 | 523,128 | 41 | 41 |
| **full +12 → +15** | **1,186,380** | **95** | **95** |

Material quantities are rounded to whole numbers: `toInt` in `js/sheet.js` strips
every non-digit, so a fractional cell like `23.14` would parse as `2314`. Exact
values are 23.136 / 31.281 / 41.224, so rounding understates materials by 0.59% /
0.90% / 0.54%. Gold carries the full expected value.

`+12 Orna <slot>` is the free starting piece (Lv.115 box) and has no market price,
so it gets a Crafting row of its own: `Gold` 0 and **no materials**. That is how the
sheet declares a free-issue item — obtainable at a flat fee with nothing consumed.
Without it, `cost()` returns null for the +12 and the whole chain above it,
including every Uaithne recipe, is unpriceable.

A material-less row counts as a recipe only when its `Gold` cell is explicitly
filled (see `rowsToRecipes` in `js/recipes.js`). A row with just a name and nothing
else is still ignored, so a stray entry in column A can't silently zero an item's
cost.

## If the rates ever change

Recompute `E[attempts]` per step, multiply the per-attempt gold and materials
through, and update the Crafting tab rows. Nothing in the code needs to change.

If Orna ever needs *live* rates again — or another upgrade turns out to be
probabilistic — the alternative we passed on was adding optional `Base` / `Fail1..5`
columns to the Crafting tab and having the coster multiply the fee and every
non-previous-tier material by `E[attempts]`. That keeps exact math and a per-step
"expected attempts" breakdown in the UI, at the cost of a schema change and a
coster rule. The removed `expectedTriesFromRates` helper (git history, `js/cost.js`)
is the maths.
