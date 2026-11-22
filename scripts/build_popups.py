"""Fill in the static map-popup summary (`popup`) of each zone in docs/data/zones.json.

  python scripts/build_popups.py            add `popup` to every zone that has data and none yet
  python scripts/build_popups.py --force    recompute every zone, replacing hand edits
  python scripts/build_popups.py --dry-run  print what would be added, change nothing

The map popup shows these values exactly as stored, so a zone's popup changes only when someone edits
`popup` in zones.json. Existing values are never overwritten unless you pass --force.
Zones whose data is not written yet (a PD with no docs/data/pd file) get no `popup`.

`popup` fields:
  residential        building sizes allowed by right, such as "1 unit" or "5+ units"; "" if none
  residentialPermit  sizes that need a special use permit; "" if none
  adu                P, S or "" for an accessory dwelling; shown only when residentialPermit is empty
  retail, restaurant, office, industry   P, S, A, T or "" (not allowed)
  limits             text such as "Height 35 ft, Front 30 ft"
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"

DWELLING_SIZES = [
    ("1", "Dwelling, single-family (detached)"),
    ("2", "Dwelling, duplex"),
    ("3", "Dwelling, triplex"),
    ("4", "Dwelling, fourplex"),
    ("5+", "Dwelling, multifamily"),
]
HEADLINE = {
    "retail": "Retail sales, less than 15,000 sq. ft. GFA",
    "restaurant": "Restaurant",
    "office": "Office",
    "industry": "Manufacturing, low-impact",
}
ADU_USE = "Dwelling, accessory (ADU)"
LIMITS = [
    ("Height", ["heightMax", "heightMaxStories"]),
    ("Front", ["frontSetbackMin"]),
    ("Build-to", ["buildTo"]),
]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def number(n):
    return f"{n:,}"


def with_unit(text, unit):
    if not unit:
        return text
    return f"{text}%" if unit == "%" else f"{text} {unit}"


def is_split(value):
    return isinstance(value, dict) and "min" not in value and "options" not in value


def format_value(value, unit):
    if is_split(value):
        return ", ".join(f"{part} {format_value(v, unit)}" for part, v in value.items())
    if value == "none":
        return "None"
    if isinstance(value, (int, float)):
        return with_unit(number(value), unit)
    if "min" in value:
        return with_unit(f"{number(value['min'])}–{number(value['max'])}", unit)
    return with_unit(" or ".join(number(o) for o in value["options"]), unit)


def numbers_in(value):
    if isinstance(value, (int, float)):
        return [value]
    if "min" in value:
        return [value["min"], value["max"]]
    return value["options"]


def summarize_value(value, unit):
    if not is_split(value):
        return format_value(value, unit)
    parts = list(value.values())
    if all(p == "none" for p in parts):
        return "None"
    if "none" in parts:
        return "varies"
    nums = [n for p in parts for n in numbers_in(p)]
    low, high = min(nums), max(nums)
    return format_value(low if low == high else {"min": low, "max": high}, unit)


def dwelling_sizes(uses, code):
    runs = []
    for index, (_, use) in enumerate(DWELLING_SIZES):
        if uses.get(use) != code:
            continue
        if runs and runs[-1][1] == index - 1:
            runs[-1][1] = index
        else:
            runs.append([index, index])
    if not runs:
        return ""
    last = len(DWELLING_SIZES) - 1
    texts = []
    for start, end in runs:
        first = DWELLING_SIZES[start][0]
        if start == end:
            texts.append(first)
        elif end == last:
            texts.append(f"{first}+")
        else:
            texts.append(f"{first}–{DWELLING_SIZES[end][0]}")
    return f"{', '.join(texts)} {'unit' if texts == ['1'] else 'units'}"


def zone_data(zone_id, base, index):
    """(uses, dimensions) for a zone, as the site shows them, or None when the zone has no data yet."""
    district = base["districts"].get(zone_id)
    if district:
        return district["uses"], district["dimensions"]
    if index.get("kind") != "pd" or not index.get("done"):
        return None
    slug = zone_id.replace("?", "").replace(" ", "-")
    label = re.sub(r"[^A-Za-z0-9]+", "-", index.get("name") or "").strip("-")
    pd_data = read_json(DATA / "pd" / (f"{slug}-{label}.json" if label else f"{slug}.json"))
    base_district = base["districts"].get(pd_data.get("base"))
    uses = {} if pd_data.get("pdUsesOnly") or not base_district else dict(base_district["uses"])
    for use in pd_data["uses"]:
        if use["permission"] == "none":
            uses.pop(use["name"], None)
        else:
            uses[use["name"]] = use["permission"]
    dimensions = {**(base_district or {}).get("dimensions", {}), **pd_data["dimensions"]}
    return uses, dimensions


def build_popup(uses, dimensions, base):
    allowed = dwelling_sizes(uses, "P")
    permit = dwelling_sizes(uses, "S")
    adu = uses.get(ADU_USE)
    limits = []
    for label, fields in LIMITS:
        field = next((f for f in fields if f in dimensions), None)
        if field:
            unit = base["dimensionFields"][field]["unit"]
            text = summarize_value(dimensions[field]["value"], unit)
            limits.append("No height limit" if label == "Height" and text == "None" else f"{label} {text}")
    popup = {
        "residential": allowed,
        "residentialPermit": permit,
        "adu": "P" if adu in ("P", "A") else (adu or ""),
    }
    for key, use in HEADLINE.items():
        popup[key] = uses.get(use, "")
    popup["limits"] = ", ".join(limits)
    return popup


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    force, dry_run = "--force" in sys.argv, "--dry-run" in sys.argv
    base = read_json(DATA / "base.json")
    index = read_json(DATA / "zones.json")
    added = []
    for zone_id, entry in index["zones"].items():
        if "popup" in entry and not force:
            continue
        found = zone_data(zone_id, base, entry)
        if not found:
            continue
        entry["popup"] = build_popup(*found, base)
        added.append(zone_id)
        print(f"{zone_id}: {json.dumps(entry['popup'], ensure_ascii=False)}")
    if dry_run or not added:
        print(f"{len(added)} zones {'would be ' if dry_run else ''}updated." if added else "Nothing to add.")
        return
    with open(DATA / "zones.json", "w", encoding="utf-8", newline="\n") as file:
        json.dump(index, file, indent=2, ensure_ascii=False)
        file.write("\n")
    print(f"Added popup to {len(added)} zones. Run `npm run format` to restore Prettier formatting.")


if __name__ == "__main__":
    main()
