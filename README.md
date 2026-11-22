# Addison Zoning Map

Detailed zoning map of Addison, TX

Static site in `docs/` (GitHub Pages). No build step: the pages read `docs/data/*.json` directly.

## Setup

```bash
npm install
python -m pip install shapely
```

Installs Prettier and a git pre-commit hook that formats staged files.

## Run

```bash
python scripts/serve.py
```

Open localhost:8000

## Data

| File                            | What                                                     | Source                                         |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `docs/data/zones.geojson`       | Zone polygons and place type                             | Town GIS, edited by hand                       |
| `docs/data/zones.json`          | Every zone: acres, place types, SUPs; PD ordinance links | Town GIS, edited by hand                       |
| `docs/data/standards.json`      | Use-specific standards, UDC Article 4 (word for word)    | UDC amendment (Dec 2026)                       |
| `docs/data/base.json`           | Uses, dimensions, place types                            | UDC amendment (Dec 2026), Advance Addison 2050 |
| `docs/data/pd/<id>-<name>.json` | One PD's changes from its base district                  | PD ordinances (`add-pd` skill)                 |

`docs/data/udc-changes.json` lists what each UDC amendment changed, shown on `udc-changes.html`. Each change has a page in the amendment PDF; changes not yet applied to the map data carry `"onSite": false`. Check it with `python scripts/check_udc_changes.py 2026-12 <amendment.pdf>`.

## Check the map against the town

```bash
python scripts/fetch_gis.py
```

Prints how the Town GIS differs from the data files (zones, acreage, place types, PD ordinances).

## Query the town GIS

```bash
python scripts/gis_api.py ordinances "ORD_ID LIKE '%23-03%'"
python scripts/gis_api.py udc_zoning "ZONE_CODE = '23-03'"
```

Run `python scripts/gis_api.py` to list the endpoints.

## Add a PD through the skill

Skill: `/add-pd PD 461`. Then manually check the draft against the PDFs
