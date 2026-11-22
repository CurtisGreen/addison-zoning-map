---
name: add-pd
description: Add one Addison Planned Development (PD) to the zoning site. Use when the user says "add PD 461", "/add-pd PD 93-018", "populate the next PD", or asks to fill in data for a PD. Downloads the PD's ordinances, reads them, writes docs/data/pd/<id>.json with an ordinance, page, and verbatim quote for every value, then runs the checker. Never commits.
---

# Add a Planned Development

**Before anything else, check the tools.** Required: `pdftotext`, `pdftoppm` (poppler) and `tesseract`. The scripts, and the Read tool's PDF page rendering that step 3 depends on, all need them. Run `pdftoppm -v` and `tesseract --version`; if either fails, stop and give the user the install command. Do not work around a missing tool, and do not read values from extracted text alone.

- macOS: `brew install poppler tesseract`
- Windows: `scoop install poppler tesseract` (or `choco install poppler tesseract`), then reopen the terminal

Goal: one draft file, `docs/data/pd/<slug>.json` (named as in step 4), that the user can check against the PDFs quickly. Accuracy beats completeness: leave a value out and add a `review` note rather than guess.

## 1. Pick the PD

- The id must match a PD key in `docs/data/zones.json` exactly (for example `PD 461`, `PD O16-040`, `PD 007-034`).
- If the user gives only a number, find the matching key. If several match or none do, list them and ask.
- "Next PD" means the largest PD (by `acres`) with `done: false`.

## Town GIS lookups (use `scripts/gis_api.py`, do not write ad-hoc queries)

Every town ArcGIS endpoint has a function in `scripts/gis_api.py` (JSON, paging handled). Call it from the shell or import it; never hand-write curl or urllib code for the town GIS.

```bash
python scripts/gis_api.py udc_zoning "ZONE_CODE = '23-03'" --fields ZONE_CODE,ZCODE_TOT,ZONE_HIST   # ordinance chain
python scripts/gis_api.py ordinances "ORD_ID LIKE '%23-03%'"                              # id, date, description, PDF url
python scripts/gis_api.py                                                                 # list endpoints
```

- `ZCODE_TOT` is the polygon's ordinance chain but is cut off at 36 characters. `ZONE_HIST` is the full chain only where the town filled it in (PD 23-03 does; most PDs have blank, `*` or free text). Fetch both. If either names an ordinance that `zones.json` lacks for the PD, tell the user and look it up with `ordinances`. Ids are zero-padded or prefixed with `O` ('096-003', 'O26-022'): search with `LIKE '%23-03%'`.
- An ordinance in `ZONE_HIST` with no `ordinances` row has no PDF on the town map (for example `O20-08`). Say so in the report; do not guess a URL.
- A row with no `HYPERLINK` or `DESCRIPTIO` is new and unpublished. Do not add it to the chain.
- Individual restaurant or alcohol SUP ordinances at an address are per-tenant permits, not PD changes. Mention them in `review` only when the PD lists that use as a special use.

## 2. Fetch

```bash
python scripts/pd.py fetch "PD 461"
```

It downloads each ordinance in the PD's chain to `pdfs/<id>/`, writes page text to `pdfs/<id>/<ordinance>/pNNN.txt` (OCR for scanned pages, marked `[OCR]`), into the ignored `pdfs/` folder. It never writes under `docs/data`; create `docs/data/pd/<id>.json` yourself. If an ordinance has no URL, tell the user; do not search the web for it unless they ask.

## 3. Read

- Read every ordinance, oldest first. A later ordinance amends earlier ones; the latest wording wins.
- Some ordinances in the chain are the zoning before the PD existed (for example, an old apartment rezoning). Note them in `review` and ignore their standards.
- Read the page text files. If OCR text is garbled, read the PDF page itself (Read tool on the PDF with `pages`).
- OCR drops lines silently, most often in tables and at page bottoms. For every page you take a value from, compare the text against the PDF page itself.
- Exhibits (site plans, development standards tables) are often at the end. Read them.

## 4. Write `docs/data/pd/<slug>.json`

Slug = id with spaces as `-` and `?` removed, then `-` and the PD's name with each run of other characters as `-` (`PD 461`, "Midway Meadows" -> `PD-461-Midway-Meadows.json`). A PD with no name uses just the id (`PD-461.json`). The site finds the file by the `name` in `zones.json`, so when the name is set or changed, rename the file to match with `git mv`; `scripts/pd.py check` prints a `RENAME` line when they differ.

Scripts never write to `docs/data`. If you generate the JSON with a script, write it to `tmp/<slug>/` (ignored by git), then write `docs/data/pd/<slug>.json` yourself using that as the reference. Temporary files go in `tmp/` or `pdfs/` inside the repo, never the system scratchpad.

```json
{
  "id": "PD 461",
  "name": "Brookhaven Club",
  "base": "CL",
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
  "notes": ["Building locations follow the approved site plan."]
}
```

Rules:

- **Evidence on every entry.** `ordinance` = ordinance id from the PD's `ordinances` in `docs/data/zones.json`; `page` = page number within that ordinance PDF (1-based, as in `pNNN.txt`); `quote` = exact text copied from that page, 12 to 200 characters, specific enough to prove the value (include the number or the use wording, not just "Bank"). The checker rejects quotes it cannot find or that are too short.
- **`base`** = the UDC district the PD explicitly builds on ("uses permitted in the LR district", "C-1 standards apply"). Old ordinances name pre-UDC districts: map them with the table below and say which old district was named in `review.base`. When the ordinance names no district, write no `review.base` note.
  - The zoning _before_ the PD (earlier ordinances in the chain) is not a base.
  - The base's uses, dimensions, and review notes all show on the PD's page, so a wrong base shows wrong limits. When unsure, use `null` and explain in `review.base`.
- **`uses`** = changes from the base: added or changed (`permission` = `P` by right, `S` special use permit, `D` development plan approval, `A` accessory, `T` temporary) or removed (`permission` = `"none"`). `name` must be an exact use name from `docs/data/base.json` → `uses[].name`. Add `text` (the ordinance's own wording) to show that wording in the "Changes from base" table instead of the UDC name; entries with the same `text` show as one row.
  - One ordinance use that spans UDC size or type classes (retail by floor area, hotel types): add each class the wording covers, and note the mapping in `review.uses`.
  - Several ordinance items that fit one UDC use: one entry with the clearest quote; put the rest in `otherUses` only if they add meaning.
- **`family`** (optional): `residential`, `mixed`, `commercial`, `industrial`, `airport`, or `planned`. Sets the PD's map color when the PD has no base district. Copy it to the PD's entry in `zones.json`.
- **`pdUsesOnly: true`** when the ordinance lists every use the PD allows and excludes all others, even if it also builds on a base district for dimensions and other standards. The page then shows only the PD's own uses and not the base district's. List every allowed use. Leave it out when the PD allows the base district's uses plus changes.
- **`parking`**: the PD's own parking ratios, one row per use: `{use, requirement, rates, ordinance, page, quote}`. `requirement` is the display text. Floor-area ratios are always written "X per 1,000 sq ft ...", with X rounded to one decimal (1 per 300 sq ft -> "3.3 per 1,000 sq ft"); the rest of the wording follows the ordinance (`"5 per 1,000 sq ft floor area"`, `"3.3 per 1,000 sq ft GFA"`). Ratios on other units keep the ordinance's form (`"1 per 4 seats"`, `"1 per room"`). `rates` is the exact ratio as numbers, `[{spaces: 1, per: 250, unit: "sq ft GFA"}]`, with a unit that starts "sq ft" for floor areas; `pd.py check` verifies X against `rates`; add `maxPerUnit` or `basis` (for example `"parking demand study"`) when the ordinance says so. Shown as a Parking table.
- **Use conditions** on a `uses` entry: `onlyBlocks: ["211"]` when allowed only in named blocks, `requires: "mixed use"` with `exceptBlocks` when it needs another use. Data only; say it in a note too.
- **`notes`** items may be a string or `{heading, items: [strings]}` to group related items (for example everything specific to one block). Write only requirements this PD sets. Do not state the absence of something (no height limit, no setbacks), the obvious (listed uses are the only ones allowed), or town-wide rules that apply to every PD (landscaping fees, standard plan approval), even when the ordinance repeats them.
- **`otherUses`** for ordinance uses with no clear UDC match: `{text, permission?, group?, ordinance, page, quote}`. `permission` is optional (`P` default, or `S`, `D`, `A`, `T`). Do not force a match. Give each one its `permission` (`S` or `A` when the ordinance says so) and keep it out of `text`. Use `D` for a use that is allowed in the PD but needs development plan approval (a site-plan review by the Planning and Zoning Commission or City Council) and keep that wording out of `text`; use `S` only when the use needs a special use permit. Explain who approves it in a note. For a `pdUsesOnly` PD they show under Allowed uses, in groups named by `group` (default "Other uses"). When a `pdUsesOnly` PD has no base district, do not map its uses to UDC names: put every use in `otherUses`, in the ordinance's own wording, with `group` set to the ordinance's own heading (for example "Retail", "Office", "Special uses"), and leave `uses` empty.
- **`dimensions`**: keys must be one of `base.json` → `dimensionFields` (for example `heightMax`, `frontSetbackMin`, `buildTo`, `lotCoverageMax`, `unitSizeMin`, `floorAreaMax`); each field there has its label and unit. `value` is a number, `"none"`, a range `{"min": 5, "max": 15}`, a choice `{"options": [10, 20]}`, or an object of those for values that vary by area, use, or building type (`{"Tract A": 70, "Tract B": 45}`). Values are always stored as numbers so they can drive calculations later; the page builds the display text from them. Add `"except": ["Block 211"]` when named areas are exempt. Include only values the PD itself sets. A value you calculate (e.g. 70% from "no more than 30% may vary") needs a `review` note showing the math. Standards with no field (sidewalks, shared parking, bicycle parking) go in `notes`: a list, one short sentence per item, shown under an "Other requirements" heading.
- **`review`** = notes for readers of the site, shown next to the value they are about. Write what a reader needs to know about the zoning (a condition, an exception, a conflict in the ordinance). Do not describe how you got the data (OCR, text quality, reading page images, mapping choices, the ordinance's history, or how the base district was chosen). Put anything the user should verify in your report instead. Other guidance on what to flag: conflicts, amendments that cover only part of the PD, unreadable pages, values only shown on a site plan, guessed mappings. Any key works. Keys that match a `dimensions` field show next to that value; all others show under the PD's rules.
- **`acresWithRoads`** = the acreage the ordinance states, only when its boundary encloses the roads inside the PD (the map's acreage leaves roads out). The site shows it as "46.4 acres (59.6 including roads)". Leave it out otherwise.
- **`acres` in `zones.json`** = the acreage stated in the latest ordinance that gives one, rounded to 0.1 (31.608 -> 31.6). No `review` note for differing acreages in older ordinances or the map.
- **`curtisNotes`** = the user's own commentary, shown above Allowed uses. Never write or change it.
- **`history`** (optional) = a short description per ordinance, keyed by ordinance id, for the "History" list at the bottom of the page. Without it the page shows the town map's own description of the ordinance. Write what the ordinance did, in under 15 words, leading with its most substantive change (height or parking only when that was the change). No trailing period on a single sentence.
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
python scripts/pd.py check "PD 461"
```

Fix every `ERROR` and run again. The script never edits `docs/data`. On a clean run it prints any `UPDATE zones.json` lines (`done`, `name`, `base`); make those edits yourself so the map colors the PD by base and the site loads its details.

Then run `python scripts/build_popups.py` to add the PD's map-popup summary (`popup` in `zones.json`). It only fills zones that have none, so hand edits are kept. Check the values against the ordinance and edit them in `zones.json` where the uses don't map cleanly to UDC names (for example a PD that lists "Multifamily" in `otherUses`).

## 6. Report

Tell the user, in a few lines:

- base district (and the old district it came from), or why it is `null`
- number of use changes (or allowed uses, if `pdUsesOnly`) and dimension values
- every `review` item
- the local preview command: `python scripts/serve.py` then open `zone.html?id=<id>`

Remind them the file is a draft to check against the PDFs. Do not commit or push.
