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

| File                       | What                                                     | Source                            |
| -------------------------- | -------------------------------------------------------- | --------------------------------- |
| `docs/data/zones.geojson`  | Zone polygons and place type                             | Town GIS, edited by hand          |
| `docs/data/zones.json`     | Every zone: acres, place types, SUPs; PD ordinance links | Town GIS, edited by hand          |
| `docs/data/standards.json` | Use-specific standards, UDC Article 4 (word for word)    | UDC O25-004                       |
| `docs/data/base.json`      | Uses (UDC Table 4.2-1), district dimensions, place types | UDC O25-004, Advance Addison 2050 |
| `docs/data/pd/<id>.json`   | One PD's changes from its base district                  | PD ordinances (`add-pd` skill)    |

Every value stores its source page. `review` entries flag values to double-check.

## Check the map against the town

```bash
python3 scripts/fetch_gis.py
```

Prints how the Town GIS differs from the data files (zones, acreage, place types, PD ordinances).

## Query the town GIS

```bash
python3 scripts/gis_api.py ordinances "ORD_ID LIKE '%23-03%'"
python3 scripts/gis_api.py udc_zoning "ZONE_CODE = '23-03'"
```

Run `python3 scripts/gis_api.py` to list the endpoints.

## Add a PD

In Claude Code: `/add-pd PD 461`. Check the draft against the PDFs, then commit.
