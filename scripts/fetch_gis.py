"""Compare the Town GIS (zoning, place types, PD ordinance links) with docs/data and print what differs.

Writes nothing under docs/data. Edits to the data files are made by hand or by Claude on request.
  python3 scripts/fetch_gis.py              print the differences
  python3 scripts/fetch_gis.py --out tmp/fetch_gis   also write fresh zones.geojson and zones.json there (never into docs/data), to diff or copy from
Polygons that are all park (Town parks layer), railroad, or excluded parcels are left out; MERGED_ZONES and EXTRA_ORDINANCES list
the other known differences from the town map.

Needs: shapely (pip install shapely)
Run:   python3 scripts/fetch_gis.py
"""
import datetime
import sys
import json
import re
import urllib.parse
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

import gis_api

DATA = Path(__file__).resolve().parent.parent / "docs" / "data"

TOWN_WIDE_ORDINANCES = {"025-015"}  # O25-015 rezoned the whole town to UDC districts; not PD-specific
NOT_PARKS = ("Elmntry",)  # school grounds in the parks layer stay zoned
# Zones that stay on the map even where the parks layer covers them
# Ordinances that amend a PD but are missing from the town map's ordinance list for it
EXTRA_ORDINANCES = {
    "PD 007-034": [
        "009-002",
        "008-022",
        "009-036",
        "010-005",
        "011-032",
        "013-026",
        "016-017",
        "016-019",
        "018-041",
        "021-045",
    ],
}
# Zones the town map draws separately that belong to another PD
MERGED_ZONES = {
    "PD O16-018": "PD 007-034",
}
KEEP_ZONES = {
    "PD 23-08": "Development site between Addison Circle Park and the DART Addison Transit Center; the parks layer's Addison Circle Park shape overlaps it",
}
# Parcels (DCAD account ids) whose zoning polygons are left off the map, like parks
# Parcel classes whose zoning polygons are left off the map (DART and Union Pacific rail corridors)
EXCLUDED_PARCEL_CLASSES = ("RAILROAD CORRIDOR",)
EXCLUDED_PARCELS = {
    "10000906498000000": "3899 Belt Line Rd, electric utility tract",
    "65027309610040000": "3800 Belt Line Rd, electric utility tract",
    "65027309610040100": "3800 Belt Line Rd, electric utility tract 4.1",
    "65027309610040200": "3800 Beltway Dr, electric utility tract",
    "65027309658000000": "14661 Midway Rd, electric utility tract",
    "10002000000020000": "15150 Surveyor Blvd",
    "10002000000010000": "15100 Surveyor Blvd",
}
MIN_PIECE = 2e-7  # square degrees (~2,000 sq m); a polygon with no non-park piece this big counts as all park
SQ_FT_PER_ACRE = 43560


ID_CHAIN = re.compile(r"(PD )?O?\d{1,3}-\d{1,3}(/(PD )?O?\d{1,3}-\d{1,3})*")


def zone_chain(record):
    """Slash-separated ordinance chain for a zoning polygon.

    ZCODE_TOT is the standard field but is cut off at 36 characters. ZONE_HIST is the full chain when the
    town filled it in, but for most polygons it is blank, '*' or free text, so it is used only when it is a
    clean list of ordinance ids.
    """
    history = (record["ZONE_HIST"] or "").strip()
    return history if ID_CHAIN.fullmatch(history) else record["ZCODE_TOT"]


def ordinance_id_options(code):
    """Zoning-layer ordinance code -> possible ordinance-layer ids (O17-007 -> 017-007; O23-08 -> 023-008 or 023-08)."""
    code = code.strip().upper().removeprefix("PD ").lstrip("O")
    match = re.fullmatch(r"(\d{1,3})-(\d{1,3})", code)
    if not match:
        return [code]
    year, number = f"{int(match[1]):03d}", match[2]
    return [f"{year}-{int(number):03d}", f"{year}-{number}", f"{year}-{int(number):02d}"]


def round_coordinates(coords):
    """Round to 5 decimals (~1 m). Shared vertices round the same way, so neighbors still meet."""
    if isinstance(coords[0], (list, tuple)):
        return [round_coordinates(c) for c in coords]
    return [round(coords[0], 5), round(coords[1], 5)]


def is_all_excluded(geom, excluded):
    """True when nothing meaningful is left of the zoning polygon after removing parks and excluded parcels."""
    if not geom.intersects(excluded):
        return False
    rest = geom.difference(excluded)
    pieces = [g for g in getattr(rest, "geoms", [rest]) if g.geom_type == "Polygon" and g.area >= MIN_PIECE]
    return not pieces


def place_type_areas(geom, place_types):
    areas = {}
    for name, polygon in place_types:
        if polygon.intersects(geom):
            areas[name] = areas.get(name, 0) + polygon.intersection(geom).area
    return areas


def load_ordinances():
    """Ordinance id -> {id, url, date, description}, keeping the first record that has a link."""
    ordinances = {}
    for record in gis_api.ordinances():
        ordinance_id = (record["ORD_ID"] or "").strip()
        if not ordinance_id or (ordinance_id in ordinances and ordinances[ordinance_id]["url"]):
            continue
        date = datetime.date(1970, 1, 1) + datetime.timedelta(milliseconds=record["DATE_"]) if record["DATE_"] else None
        ordinances[ordinance_id] = {
            "id": ordinance_id,
            "url": urllib.parse.quote(record["HYPERLINK"], safe=":/") if record["HYPERLINK"] else None,
            "date": date.isoformat() if date else None,
            "description": (record["DESCRIPTIO"] or "").strip(),
        }
    return ordinances


def main():
    ordinances = load_ordinances()
    ids_by_number = {}  # old ordinances are often cited by number only ("461")
    for ordinance_id in ordinances:
        ids_by_number.setdefault(ordinance_id.split("-")[-1].lstrip("0"), []).append(ordinance_id)

    def find_ordinance(code):
        for option in ordinance_id_options(code):
            if option in ordinances:
                return ordinances[option]
        matches = ids_by_number.get(code.strip().lstrip("0"), []) if code.strip().isdigit() else []
        return ordinances[matches[0]] if len(matches) == 1 else None

    place_types = [(f["properties"]["PlaceType"], shape(f["geometry"])) for f in gis_api.place_types(geometry=True, geojson=True)]
    parks = [shape(f["geometry"]).buffer(0) for f in gis_api.parks(geometry=True, geojson=True)
             if not any(word in (f["properties"]["Name"] or "") for word in NOT_PARKS)]
    parcel_ids = ", ".join(repr(i) for i in EXCLUDED_PARCELS)
    parcel_classes = ", ".join(repr(c) for c in EXCLUDED_PARCEL_CLASSES)
    parcels = gis_api.parcels(f"PARCELID IN ({parcel_ids}) OR CLASSDSCRP IN ({parcel_classes})", geometry=True, geojson=True)
    missing = set(EXCLUDED_PARCELS) - {f["properties"]["PARCELID"] for f in parcels}
    if missing:
        print("Excluded parcels not found in the parcel layer:", ", ".join(sorted(missing)))
    excluded = unary_union(parks + [shape(f["geometry"]).buffer(0) for f in parcels])
    index_file = DATA / "zones.json"
    previous = json.loads(index_file.read_text())["zones"] if index_file.exists() else {}

    features, zones, place_type_totals, unmatched = [], {}, {}, set()
    global unmatched_codes
    unmatched_codes = unmatched
    for feature in gis_api.udc_zoning(geometry=True, geojson=True):
        record = feature["properties"]
        district = record["ZONE_UDC"].strip()
        chain = [c.strip() for c in zone_chain(record).split("/")
                 if c.strip() and ordinance_id_options(c)[0] not in TOWN_WIDE_ORDINANCES]
        pd_code = record["ZONE_CODE"].strip().removeprefix("PD ")
        # '?' = GIS has no ZONE_CODE for this PD polygon; the id is guessed from its ordinance chain
        zone_id = district if district != "PD" else f"PD {pd_code or chain[0] + '?'}"
        merged = zone_id in MERGED_ZONES
        zone_id = MERGED_ZONES.get(zone_id, zone_id)

        if district == "PD":
            kept = previous.get(zone_id, {})
            zone = zones.setdefault(zone_id, {"kind": "pd", "name": kept.get("name", ""), "base": kept.get("base"),
                                              "done": kept.get("done", False), "acres": 0, "mainOrdinance": None,
                                              "ordinances": {}, "placeTypes": []})
            main_ordinance = find_ordinance(pd_code) if pd_code else None
            if main_ordinance and not merged:
                zone["mainOrdinance"] = main_ordinance["id"]
            for code in chain:
                ordinance = find_ordinance(code)
                if ordinance:
                    zone["ordinances"][ordinance["id"]] = ordinance
                else:
                    unmatched.add(f"{zone_id}: {code}")
            for ordinance_id in EXTRA_ORDINANCES.get(zone_id, []):
                zone["ordinances"][ordinance_id] = ordinances[ordinance_id]
        else:
            zone = zones.setdefault(zone_id, {"kind": "district", "acres": 0, "placeTypes": []})
        zone["acres"] += record["Shape.STArea()"] / SQ_FT_PER_ACRE

        geom = shape(feature["geometry"]).buffer(0)
        if zone_id not in KEEP_ZONES and is_all_excluded(geom, excluded):  # partly-excluded polygons stay whole
            continue
        areas = place_type_areas(geom, place_types)
        props = {"zone": zone_id}
        if areas:
            props["placeType"] = max(areas, key=areas.get)
        for name, area in areas.items():
            totals = place_type_totals.setdefault(zone_id, {})
            totals[name] = totals.get(name, 0) + area
        geometry = mapping(geom)
        features.append({"type": "Feature", "properties": props,
                         "geometry": {"type": geometry["type"], "coordinates": round_coordinates(geometry["coordinates"])}})

    for zone_id, zone in zones.items():
        zone["acres"] = round(zone["acres"], 1)
        totals = place_type_totals.get(zone_id, {})
        zone["placeTypes"] = sorted(totals, key=totals.get, reverse=True)  # largest share first
        if zone["kind"] == "pd":
            zone["ordinances"] = sorted(zone["ordinances"].values(), key=lambda o: o["date"] or "")
    districts = sorted((z for z in zones.items() if z[1]["kind"] == "district"), key=lambda z: -z[1]["acres"])
    pds = sorted((z for z in zones.items() if z[1]["kind"] == "pd"), key=lambda z: -z[1]["acres"])

    new_index = {"asOf": datetime.date.today().isoformat(), "zones": dict(districts + pds)}
    new_geojson = {"type": "FeatureCollection", "features": features}
    if "--out" in sys.argv:
        out = Path(sys.argv[sys.argv.index("--out") + 1]).resolve()
        if out == DATA.resolve():
            sys.exit("--out must not be docs/data")
        out.mkdir(parents=True, exist_ok=True)
        (out / "zones.geojson").write_text(json.dumps(new_geojson, separators=(",", ":")))
        (out / "zones.json").write_text(json.dumps(new_index, indent=2))
        print(f"Fresh files written to {out}")
    report_differences(previous, new_index["zones"], features)
    return


def report_differences(previous, current, features):
    """Print how the town's data differs from docs/data. Changes nothing."""
    geojson_file = DATA / "zones.geojson"
    old_count = len(json.loads(geojson_file.read_text())["features"]) if geojson_file.exists() else 0
    print(f"Polygons: {len(features)} from the town, {old_count} in zones.geojson")
    added = sorted(set(current) - set(previous))
    removed = sorted(set(previous) - set(current))
    print("Zones only in the town data:", ", ".join(added) or "none")
    print("Zones only in zones.json:   ", ", ".join(removed) or "none")
    for zone_id in sorted(set(current) & set(previous)):
        town, ours = current[zone_id], previous[zone_id]
        lines = []
        if abs(town["acres"] - ours["acres"]) >= 0.5:
            lines.append(f"acres {ours['acres']} -> {town['acres']}")
        if town["placeTypes"] != ours["placeTypes"]:
            lines.append(f"place types {ours['placeTypes']} -> {town['placeTypes']}")
        if town["kind"] == "pd":
            town_ids = {o["id"] for o in town["ordinances"]}
            our_ids = {o["id"] for o in ours["ordinances"]}
            if town_ids - our_ids:
                lines.append("ordinances only in the town data: " + ", ".join(sorted(town_ids - our_ids)))
            if our_ids - town_ids:
                lines.append("ordinances only in zones.json: " + ", ".join(sorted(our_ids - town_ids)))
        if lines:
            print(f"  {zone_id}: " + "; ".join(lines))
    if unmatched_codes:
        print("Ordinance codes in the town data that match no ordinance:")
        for item in sorted(unmatched_codes):
            print("  " + item)
    print("\nNothing under docs/data was changed.")


if __name__ == "__main__":
    main()
