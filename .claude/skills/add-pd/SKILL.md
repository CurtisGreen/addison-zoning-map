---
name: add-pd
description: Add one Addison Planned Development (PD) to the zoning site. Use when the user says "add PD 461", "/add-pd PD 93-018", "populate the next PD", or asks to fill in data for a PD. Downloads the PD's ordinances, reads them, writes docs/data/pd/<id>.json with an ordinance, page, and verbatim quote for every value, then runs the checker. Never commits.
---

# Add a Planned Development

Goal: one draft file, `docs/data/pd/<id>.json`, that the user can check against the PDFs quickly. Accuracy beats completeness: leave a value out and add a `review` note rather than guess.

## 1. Pick the PD

- The id must match a PD key in `docs/data/zones.json` exactly (for example `PD 461`, `PD O16-040`, `PD 007-034`).
- If the user gives only a number, find the matching key. If several match or none do, list them and ask.
- "Next PD" means the largest PD (by `acres`) with `done: false`.

## 2. Fetch

```bash
python3 scripts/pd.py fetch "PD 461"
```

It downloads each ordinance in the PD's chain to `pdfs/<id>/`, writes page text to `pdfs/<id>/<ordinance>/pNNN.txt` (OCR for scanned pages, marked `[OCR]`), and creates the skeleton JSON if it is missing. If an ordinance has no URL, tell the user; do not search the web for it unless they ask.

## 3. Read

- Read every ordinance, oldest first. A later ordinance amends earlier ones; the latest wording wins.
- Some ordinances in the chain are the zoning before the PD existed (for example, an old apartment rezoning). Note them in `review` and ignore their standards.
- Read the page text files. If OCR text is garbled, read the PDF page itself (Read tool on the PDF with `pages`).
- OCR drops lines silently, most often in tables and at page bottoms. For every page you take a value from, compare the text against the PDF page itself.
- Exhibits (site plans, development standards tables) are often at the end. Read them.

## 4. Write `docs/data/pd/<slug>.json`

Slug = id with spaces as `-` and `?` removed (`PD 461` -> `PD-461.json`).

```json
{
  "id": "PD 461",
  "name": "Brookhaven Club",
  "base": "CL",
  "usesOnly": false,
  "purpose": "",
  "uses": [
    {
      "name": "Hotel, Full Service",
      "permission": "P",
      "ordinance": "078-461",
      "page": 3,
      "quote": "hotels shall be permitted"
    }
  ],
  "otherUses": [
    {
      "text": "Health club",
      "ordinance": "078-461",
      "page": 3,
      "quote": "a health club or spa"
    }
  ],
  "dimensions": {
    "heightMax": {
      "value": 70,
      "ordinance": "078-461",
      "page": 4,
      "quote": "shall not exceed seventy (70) feet"
    }
  },
  "review": { "heightMax": "Exhibit B shows 6 stories; text says 70 ft" },
  "notes": "Building locations follow the approved site plan."
}
```

Rules:

- **Evidence on every entry.** `ordinance` = ordinance id from the PD's `ordinances` in `docs/data/zones.json`; `page` = page number within that ordinance PDF (1-based, as in `pNNN.txt`); `quote` = exact text copied from that page, 12 to 200 characters, specific enough to prove the value (include the number or the use wording, not just "Bank"). The checker rejects quotes it cannot find or that are too short.
- **`base`** = the UDC district the PD explicitly builds on ("uses permitted in the LR district", "C-1 standards apply"). Old ordinances name pre-UDC districts: map them with the table below and say which old district was named in `review.base`.
  - The zoning _before_ the PD (earlier ordinances in the chain) is not a base.
  - The base's uses, dimensions, and review notes all show on the PD's page, so a wrong base shows wrong limits. When unsure, use `null` and explain in `review.base`.
- **`uses`** = changes from the base: added or changed (`permission` = `P` by right, `S` special use permit, `A` accessory, `T` temporary) or removed (`permission` = `"none"`). `name` must be an exact use name from `docs/data/base.json` → `uses[].name`.
  - One ordinance use that spans UDC size or type classes (retail by floor area, hotel types): add each class the wording covers, and note the mapping in `review.uses`.
  - Several ordinance items that fit one UDC use: one entry with the clearest quote; put the rest in `otherUses` only if they add meaning.
- **`usesOnly: true`** when the PD gives a complete list of allowed uses instead of adding to a base district. Then list every allowed use (usually with `base: null`).
- **`otherUses`** for ordinance uses with no clear UDC match: `{text, permission?, ordinance, page, quote}`. `permission` is optional (`P` default, or `S`, `A`, `T`). Do not force a match.
- **`dimensions`**: keys must be one of `base.json` → `dimensionFields` (for example `heightMax`, `frontSetbackMin`, `buildTo`, `lotCoverageMax`, `unitSizeMin`, `floorAreaMax`); each field there has its label and unit. `value` is a number, `"none"`, a short string (`"5-15"`), or an object for values that vary by area, use, or building type (`{"Tract A": 70, "Tract B": 45}`). Include only values the PD itself sets. A value you calculate (e.g. 70% from "no more than 30% may vary") needs a `review` note showing the math. Standards with no field (block length, parking): put in `notes`.
- **`review`** = anything the user should check: conflicts, amendments that cover only part of the PD, unreadable pages, values only shown on a site plan, guessed mappings. Any key works. Keys that match a `dimensions` field show next to that value; all others show under the PD's rules.
- **`name`** = the development name the ordinance uses, if any. Otherwise `""`.
- **`purpose`** = the ordinance's own purpose or intent sentence, word for word (the site shows it in quotation marks). Shorten only by cutting words and marking the cut with `…`. Use `""` if the ordinance states none. The checker looks for it in the ordinance text.
- Plain short text in neutral terms (house, townhouse, apartment, condominium), except inside quotes. No marketing words.

### Old district → UDC district (typical, from the current GIS map; not an official table)

| Old       | UDC   |     | Old         | UDC                      |
| --------- | ----- | --- | ----------- | ------------------------ |
| R-16, R-1 | R-1   |     | C-1         | CG                       |
| MXR       | R-2   |     | C-2         | CG (sometimes LI)        |
| A         | A     |     | I-1, I-2    | LI                       |
| LR        | CL    |     | I-3         | AA                       |
| BL        | M-2   |     | UC          | M-4                      |
| PD-TH     | PD-TH |     | P (parking) | varies: say so in review |

## 5. Check

```bash
python3 scripts/pd.py check "PD 461"
```

Fix every `ERROR` and run again. On a clean run the script marks the PD `done` in `zones.json` (so the map colors it by base and the site loads its details).

## 6. Report

Tell the user, in a few lines:

- base district (and the old district it came from), or why it is `null`
- number of use changes (or allowed uses, if `usesOnly`) and dimension values
- every `review` item
- the local preview command: `python3 -m http.server 8765 -d docs` then open `zone.html?id=<id>`

Remind them the file is a draft to check against the PDFs. Do not commit or push.
