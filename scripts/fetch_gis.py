"""Pull Addison zoning, place types, and PD ordinance links from the Town GIS.

Writes:
  docs/data/zones.geojson  map polygons (zone, placeType, specialUsePermit)
  docs/data/zones.json     one entry per zone: acres, place types, SUPs; PDs also get ordinances
Zoning polygons that are all park (Town parks layer), railroad, or excluded parcels are left off the map.
Keeps PD names, bases, and done flags already in zones.json. Re-run when the zoning map changes.

Needs: shapely (pip install shapely)
Run:   python3 scripts/fetch_gis.py
"""
import datetime
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

GIS = "https://gis.addisontx.gov/arcgis/rest/services/"
ZONING_LAYER = "Planning_Development/Landbase/MapServer/15"
ORDINANCE_LAYER = "Planning_Development/Landbase/MapServer/1"
PLACE_TYPE_LAYER = "Planning_Development/Comprehensive_Planning/MapServer/0"
PARK_LAYER = "Parks/Parks/MapServer/10"
PARCEL_LAYER = "Planning_Development/Landbase/MapServer/8"
DATA = Path(__file__).resolve().parent.parent / "docs" / "data"

TOWN_WIDE_ORDINANCES = {"025-015"}  # O25-015 rezoned the whole town to UDC districts; not PD-specific
NOT_PARKS = ("Elmntry",)  # school grounds in the parks layer stay zoned
# Zones that stay on the map even where the parks layer covers them
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


def query(layer, geometry=True, where="1=1"):
    """Features of a layer as GeoJSON, paging past the 1,000-record limit."""
    features, offset = [], 0
    while True:
        params = urllib.parse.urlencode({"where": where, "outFields": "*", "outSR": 4326, "f": "geojson",
                                         "returnGeometry": str(geometry).lower(), "resultOffset": offset})
        with urllib.request.urlopen(f"{GIS}{layer}/query?{params}", timeout=60) as response:
            page = json.load(response)["features"]
        features += page
        if len(page) < 1000:
            return features
        offset += len(page)


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
    """Place type name -> overlapping area."""
    areas = {}
    for name, polygon in place_types:
        if polygon.intersects(geom):
            areas[name] = areas.get(name, 0) + polygon.intersection(geom).area
    return areas


def load_ordinances():
    """Ordinance id -> {id, url, date, description}, keeping the first record that has a link."""
    ordinances = {}
    for feature in query(ORDINANCE_LAYER, geometry=False):
        record = feature["properties"]
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

    place_types = [(f["properties"]["PlaceType"], shape(f["geometry"])) for f in query(PLACE_TYPE_LAYER)]
    parks = [shape(f["geometry"]).buffer(0) for f in query(PARK_LAYER)
             if not any(word in (f["properties"]["Name"] or "") for word in NOT_PARKS)]
    parcel_ids = ", ".join(repr(i) for i in EXCLUDED_PARCELS)
    parcel_classes = ", ".join(repr(c) for c in EXCLUDED_PARCEL_CLASSES)
    parcels = query(PARCEL_LAYER, where=f"PARCELID IN ({parcel_ids}) OR CLASSDSCRP IN ({parcel_classes})")
    missing = set(EXCLUDED_PARCELS) - {f["properties"]["PARCELID"] for f in parcels}
    if missing:
        print("Excluded parcels not found in the parcel layer:", ", ".join(sorted(missing)))
    excluded = unary_union(parks + [shape(f["geometry"]).buffer(0) for f in parcels])
    index_file = DATA / "zones.json"
    previous = json.loads(index_file.read_text())["zones"] if index_file.exists() else {}

    features, zones, place_type_totals, unmatched = [], {}, {}, set()
    for feature in query(ZONING_LAYER):
        record = feature["properties"]
        district = record["ZONE_UDC"].strip()
        chain = [c.strip() for c in record["ZCODE_TOT"].split("/")
                 if c.strip() and ordinance_id_options(c)[0] not in TOWN_WIDE_ORDINANCES]
        pd_code = record["ZONE_CODE"].strip().removeprefix("PD ")
        # '?' = GIS has no ZONE_CODE for this PD polygon; the id is guessed from its ordinance chain
        zone_id = district if district != "PD" else f"PD {pd_code or chain[0] + '?'}"
        sup = record["SU_TOT"].strip()

        if district == "PD":
            kept = previous.get(zone_id, {})
            zone = zones.setdefault(zone_id, {"kind": "pd", "name": kept.get("name", ""), "base": kept.get("base"),
                                              "done": kept.get("done", False), "acres": 0, "mainOrdinance": None,
                                              "ordinances": {}, "placeTypes": [], "specialUsePermits": []})
            main_ordinance = find_ordinance(pd_code) if pd_code else None
            if main_ordinance:
                zone["mainOrdinance"] = main_ordinance["id"]
            for code in chain:
                ordinance = find_ordinance(code)
                if ordinance:
                    zone["ordinances"][ordinance["id"]] = ordinance
                else:
                    unmatched.add(f"{zone_id}: {code}")
        else:
            zone = zones.setdefault(zone_id, {"kind": "district", "acres": 0, "placeTypes": [], "specialUsePermits": []})
        zone["acres"] += record["Shape.STArea()"] / SQ_FT_PER_ACRE
        if sup and sup not in zone["specialUsePermits"]:
            zone["specialUsePermits"].append(sup)

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
        if sup:
            props["specialUsePermit"] = sup
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

    (DATA / "zones.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    index_file.write_text(json.dumps({"asOf": datetime.date.today().isoformat(), "zones": dict(districts + pds)}, indent=2))

    print(f"{len(features)} polygons -> zones.geojson")
    print("\nDistricts (acres):")
    for zone_id, zone in districts:
        print(f"  {zone_id:6} {zone['acres']:7.1f}")
    print(f"\nPDs: {len(pds)} ({sum(z['acres'] for _, z in pds):.0f} acres)")
    for zone_id, zone in pds:
        print(f"  {zone_id:12} {zone['acres']:6.1f} ac  ordinances: {', '.join(o['id'] for o in zone['ordinances']) or 'NONE'}")
    if unmatched:
        print("\nUnmatched ordinance codes (fix by hand in zones.json):")
        for item in sorted(unmatched):
            print("  " + item)


if __name__ == "__main__":
    main()
