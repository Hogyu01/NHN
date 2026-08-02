# Guest Sprites V2

Six guest archetypes from `data/guests.json`, redesigned as four-direction walk-cycle sheets.

## Runtime Files

Use the PNG files in `game_ready/`. Every sheet is `1256 x 1256` with transparent pixels and a strict `4 x 4` grid. Each frame is `314 x 314`.

Rows are ordered `DOWN`, `LEFT`, `RIGHT`, `UP`. Each row contains four locomotion phases from left to right.

## Character Cues

- `human_adventurer`: round backpack, blue scarf, rookie travel gear
- `dwarf_courier`: oversized strapped wooden parcel, copper beard
- `goblin_scholar`: green skin, brass glasses, book, burgundy robe
- `slime_gourmand`: turquoise slime, cream napkin, golden spoon
- `kobold_porter`: orange kobold, long tail, strapped wooden crate
- `mushroom_traveler`: red spotted cap, moss shawl, small steam wisps

## Source Files

- `chroma/`: original built-in ImageGen outputs on magenta backgrounds
- `transparent/`: background-removed outputs at the generated dimensions
- `game_ready/`: transparent sheets padded to dimensions divisible by four

Generated with OpenAI built-in ImageGen on 2026-08-01. The supplied game assets were used only as style, proportion, palette, and layout references. Chroma-key removal used the local OpenAI imagegen helper with soft matte and despill.
