# Addison Zoning

Zoning map of Addison, TX. Hover for the zone name, click for uses, limits, place type, and source links.

Static site in `docs/` (GitHub Pages). No build step: the pages read `docs/data/*.json` directly.

## Setup

```bash
npm install
```

Installs Prettier and a git pre-commit hook that formats staged files.

## Preview

```bash
python3 -m http.server 8765 -d docs
```

Open http://127.0.0.1:8765

## Data

| File                      | What                                                     | Source                            |
| ------------------------- | -------------------------------------------------------- | --------------------------------- |
| `docs/data/zones.geojson` | Zone polygons, place type, SUP code                      | Town GIS (`scripts/fetch_gis.py`) |
| `docs/data/zones.json`    | Every zone: acres, place types, SUPs; PD ordinance links | Town GIS (`scripts/fetch_gis.py`) |
| `docs/data/base.json`     | Uses (UDC Table 4.2-1), district dimensions, place types | UDC O25-004, Advance Addison 2050 |
| `docs/data/pd/<id>.json`  | One PD's changes from its base district                  | PD ordinances (`add-pd` skill)    |

Every value stores its source page. `review` entries flag values to double-check.

## Refresh the map

```bash
python3 scripts/fetch_gis.py
```

Keeps PD names, bases, and done flags.

## Add a PD

In Claude Code: `/add-pd PD 461` (or "add the next PD"). Uses `scripts/pd.py fetch` and `scripts/pd.py check`. Review the draft against the PDFs, then commit.
