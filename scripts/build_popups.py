"""Fill in the static map-popup summary (`popup`) of each zone in docs/data/zones.json.

  python scripts/build_popups.py            add `popup` to every zone that has data and none yet, and any
                                            new field to popups written before it existed
  python scripts/build_popups.py --force    recompute every zone, replacing hand edits
  python scripts/build_popups.py --dry-run  print what would be added, change nothing

The map popup shows these values exactly as stored, so a zone's popup changes only when someone edits
`popup` in zones.json. Existing values are never overwritten unless you pass --force.
Zones whose data is not written yet (a PD with no docs/data/pd file) get no `popup`.

`popup` fields:
  residential        building sizes allowed by right, such as "1 unit" or "5+ units"; "" if none
  residentialCode    "P*" for a PD with mustFollowPlan (sizes allowed by right, exactly as the plan shows); left out otherwise
  mustFollowPlan     true for a PD with mustFollowPlan, shown as the last line before the links; left out otherwise
  residentialPermit  sizes that need a special use permit; "" if none
  adu                P, S or "" for an accessory dwelling; shown only when residentialPermit is empty
  retail, restaurant, office, industry, hotel, daycare   P, P*, S, D, A, T or "" (not allowed)
  limits             text such as "Height 35 ft, Front 30 ft"
"""
import json
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
    "hotel": "Hotel, Full Service",
    "daycare": "Day care center, adult or child",
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


def zone_data(zone_id, base, zone):
    """(uses, dimensions, must_follow_plan) for a zone, as the site shows them, or None when the zone has no data yet."""
    district = base["districts"].get(zone_id)
    if district:
        return district["uses"], district["dimensions"], False
    if zone.get("kind") != "pd" or not zone.get("done"):
        return None
    pd_data = read_json(DATA / "pd" / zone["file"])
    base_district = base["districts"].get(pd_data.get("base"))
    plan_only = pd_data.get("pdUsesOnly") or pd_data.get("mustFollowPlan")  # only the PD's own uses count
    uses = {} if plan_only or not base_district else dict(base_district["uses"])
    for use in [use for use in pd_data["uses"] if use.get("name")]:  # text-only uses have no UDC name to change
        if use["permission"] == "none":
            uses.pop(use["name"], None)
        else:
            uses[use["name"]] = use["permission"]
    must_follow_plan = bool(pd_data.get("mustFollowPlan"))
    if must_follow_plan:  # by right becomes P*: allowed by right, but exactly as the development plan shows
        uses = {name: "P*" if code == "P" else code for name, code in uses.items()}
    dimensions = {**(base_district or {}).get("dimensions", {}), **pd_data["dimensions"]}
    return uses, dimensions, must_follow_plan


def build_popup(uses, dimensions, must_follow_plan, base):
    allowed = dwelling_sizes(uses, "P*" if must_follow_plan else "P")
    permit = dwelling_sizes(uses, "S")
    adu = uses.get(ADU_USE)
    limits = []
    for label, fields in LIMITS:
        field = next((f for f in fields if f in dimensions), None)
        if field:
            unit = base["dimensionFields"][field]["unit"]
            text = summarize_value(dimensions[field]["value"], unit)
            if label == "Height" and text == "None":  # no maximum: say so, or give the minimum when there is one
                minimum = dimensions.get("heightMin")
                text = f"Min height {summarize_value(minimum['value'], 'ft')}" if minimum else "No height limit"
                limits.append(text)
            else:
                limits.append(f"{'Max height' if label == 'Height' else label} {text}")
    popup = {
        "residential": allowed,
        "residentialPermit": permit,
        "adu": "P" if adu in ("P", "A") else (adu or ""),
    }
    if must_follow_plan:
        popup["residentialCode"] = "P*"
        popup["mustFollowPlan"] = True
    for key, use in HEADLINE.items():
        popup[key] = uses.get(use, "")
    popup["limits"] = ", ".join(limits)
    return popup


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    force, dry_run = "--force" in sys.argv, "--dry-run" in sys.argv
    base = read_json(DATA / "base.json")
    zones = read_json(DATA / "zones.json")
    added = []
    for zone_id, zone in zones.items():
        found = zone_data(zone_id, base, zone)
        if not found:
            continue
        built = build_popup(*found, base)
        if "popup" in zone and not force:
            # keep every stored value, add only fields the popup gained since it was written
            merged = {key: zone["popup"].get(key, value) for key, value in built.items()}
            if merged == zone["popup"]:
                continue
            new_keys = [key for key in built if key not in zone["popup"]]
            zone["popup"] = merged
            print(f"{zone_id}: added {', '.join(new_keys)}")
        else:
            zone["popup"] = built
            print(f"{zone_id}: {json.dumps(built, ensure_ascii=False)}")
        added.append(zone_id)
    if dry_run or not added:
        print(f"{len(added)} zones {'would be ' if dry_run else ''}updated." if added else "Nothing to add.")
        return
    with open(DATA / "zones.json", "w", encoding="utf-8", newline="\n") as file:
        json.dump(zones, file, indent=2, ensure_ascii=False)
        file.write("\n")
    print(f"Added popup to {len(added)} zones. Run `npm run format` to restore Prettier formatting.")


if __name__ == "__main__":
    main()
