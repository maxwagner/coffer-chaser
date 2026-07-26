# Coffer Chaser

A tool for figuring out the cheapest way to upgrade your gear in Vindictus.

**[Open the app](https://maxwagner.github.io/coffer-chaser/)**

## What it does

Every upgrade you can make (crafting a gear tier, applying an enchant, enhancing an accessory) costs some gold and gives you some ranking points. Coffer Chaser looks at all of them and sorts them by gold spent per point gained, so you can see which upgrades give you the most for your money. Prices come from a community Google Sheet, so the numbers stay close to the real marketplace.

## How to use it

[Open the app](https://maxwagner.github.io/coffer-chaser/) in your browser. It loads the price data and then shows you a ranked list of upgrades, cheapest first. Set up your character by editing your gear and stats in the sidebar on the right, and the whole list updates to match. From there you can plan out a path, check how much each stat is worth against a boss, or track your drops.

Your character, gear, and settings are saved in your browser, so nothing gets lost when you close the tab.

## Running it locally

It is just static files, so you can host it anywhere or run it on your own machine:

```
python serve.py 8000
```

Then open http://localhost:8000.

## The tabs

**Upgrades** is the main screen. It is the ranked list of your cheapest upgrades, sorted by gold per ranking point.

**Target** lets you set a goal, like a stat number or a raid requirement, and it works out the cheapest set of upgrades to get you there.

**Planner** is where you build your own upgrade path step by step. It tracks what materials you need, what you can afford, and how your stats change along the way.

**Damage** shows how much each stat point is actually worth against a specific boss, so you can see where your damage is really coming from.

**Appraiser** helps you decide whether to buy an item or craft it yourself, and compares the cost either way.

**Items** is a searchable catalog of gear, enchants, materials, and prices, with what you own and how each price has been trending.

**Tracker** reads screenshots of the auction house and your raid drops to pull in prices and log what you have earned per run.

**Checklist** covers the one-time prep goals and infusions you should knock out before the ranked upgrades are worth chasing.
