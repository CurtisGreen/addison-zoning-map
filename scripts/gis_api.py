"""Town of Addison public ArcGIS REST endpoints, one function per endpoint. Stdlib only, no key needed.

Import:  from gis_api import ordinances, udc_zoning, place_types   (scripts/ on sys.path)
CLI:     python3 scripts/gis_api.py ordinances "ORD_ID LIKE '%23-03%'"
         python3 scripts/gis_api.py udc_zoning "ZONE_CODE = '23-03'" --fields ZONE_CODE,ZONE_HIST
         python3 scripts/gis_api.py place_types
         python3 scripts/gis_api.py services | layers Landbase | fields Landbase 1

Every query function takes `where` (SQL, default all rows), `fields` ("*" or a comma list),
`geometry` (False = attributes only; True adds shapes in lat/lon) and returns a list of
attribute dicts (with a "geometry" key when geometry=True). `geojson=True` returns GeoJSON features
({"properties", "geometry"}, lat/lon) instead, for shapely. Paging is handled here: the server
caps rows per call, so these loop until it has sent everything.

The town web app asks for f=pbf (binary protobuf). These use f=json, which returns the same rows.
Add a layer by adding one function that calls `query`.
"""
import json
import sys
import urllib.parse
import urllib.request

ROOT = "https://gis.addisontx.gov/arcgis/rest/services/"
PLANNING = "Planning_Development/"
PAGE_SIZE = 1000


def get(path, output="json", **params):
    """GET a REST path under ROOT as JSON (output="geojson" for GeoJSON). Raises if the server reports an error."""
    params["f"] = output
    url = ROOT + path + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=60) as response:
        data = json.load(response)
    if "error" in data:
        raise RuntimeError(f"{path}: {data['error']}")
    return data


def query(layer, where="1=1", fields="*", geometry=False, geojson=False, order_by=None):
    """Rows of one layer, e.g. layer = "Planning_Development/Landbase/MapServer/1". All pages.

    Default: a list of attribute dicts (Esri JSON, geometry under "geometry" as rings/paths).
    geojson=True: a list of GeoJSON features ({"properties", "geometry"}) in lat/lon, for shapely.
    """
    params = {"where": where, "outFields": fields, "returnGeometry": str(geometry).lower(),
              "resultRecordCount": PAGE_SIZE}
    if geometry:
        params["outSR"] = 4326
    if order_by:
        params["orderByFields"] = order_by
    rows, offset = [], 0
    while True:
        page = get(layer + "/query", "geojson" if geojson else "json", resultOffset=offset, **params)
        if geojson:
            rows += page["features"]
            if len(page["features"]) < PAGE_SIZE:
                return rows
            offset += len(page["features"])
            continue
        for feature in page["features"]:
            row = dict(feature["attributes"])
            if geometry:
                row["geometry"] = feature.get("geometry")
            rows.append(row)
        if not page.get("exceededTransferLimit") or not page["features"]:
            return rows
        offset += len(page["features"])


# --- Services and layers ---------------------------------------------------------------------

def services():
    """Names of the services under Planning_Development, e.g. 'Planning_Development/Landbase:MapServer'."""
    return [f"{s['name']}:{s['type']}" for s in get(PLANNING.rstrip("/"))["services"]]


def layers(service):
    """(id, name) for every layer of a MapServer, e.g. layers("Landbase")."""
    return [(layer["id"], layer["name"]) for layer in get(f"{PLANNING}{service}/MapServer")["layers"]]


def fields(service, layer_id):
    """(name, type) for every field of a layer, e.g. fields("Landbase", 1)."""
    return [(f["name"], f["type"]) for f in get(f"{PLANNING}{service}/MapServer/{layer_id}")["fields"]]


# --- Planning_Development/Landbase ------------------------------------------------------------

def ordinances(where="1=1", fields="*", geometry=False, geojson=False):
    """Zoning Ordinances (Landbase layer 1), one row per ordinance.

    Fields: ORD_ID, DATE_ (epoch ms), ADDRESS, APPLICANT, TYPE, DESCRIPTIO, HYPERLINK (PDF url).
    ORD_ID is '096-003', '023-03' or 'O26-022': search with LIKE '%23-03%' when unsure.
    Some ordinances (O20-08) have no row. Rows with no HYPERLINK have no PDF yet.
    """
    return query(PLANNING + "Landbase/MapServer/1", where, fields, geometry, geojson)


def udc_zoning(where="1=1", fields="*", geometry=False, geojson=False):
    """UDC_Zoning (Landbase layer 15), one row per zoned polygon.

    Fields: ZONE_CLASS, ZONE_UDC, ZONE_CODE, ZCODE_TOT (ordinance chain, slash separated, cut off at
    36 characters), ZONE_HIST (full chain, but only filled in for a few polygons such as PD 23-03; elsewhere
    blank, '*' or free text), SU_CODE1.
    """
    return query(PLANNING + "Landbase/MapServer/15", where, fields, geometry, geojson)


def zoning_historic(where="1=1", fields="*", geometry=False, geojson=False):
    """Zoning Historic (Landbase layer 5): pre-UDC districts."""
    return query(PLANNING + "Landbase/MapServer/5", where, fields, geometry, geojson)


def bza_zoning(where="1=1", fields="*", geometry=False, geojson=False):
    """BZA Zoning (Landbase layer 2)."""
    return query(PLANNING + "Landbase/MapServer/2", where, fields, geometry, geojson)


def parcels(where="1=1", fields="*", geometry=False, geojson=False):
    """Addison Parcels (Landbase layer 8)."""
    return query(PLANNING + "Landbase/MapServer/8", where, fields, geometry, geojson)


def udc_overlay(where="1=1", fields="*", geometry=False, geojson=False):
    """UDC_Overlay (Landbase layer 13)."""
    return query(PLANNING + "Landbase/MapServer/13", where, fields, geometry, geojson)


def special_sign_districts(where="1=1", fields="*", geometry=False, geojson=False):
    """Special_Sign_Districts (Landbase layer 12)."""
    return query(PLANNING + "Landbase/MapServer/12", where, fields, geometry, geojson)


# --- Parks/Parks --------------------------------------------------------------------------------

def parks(where="1=1", fields="*", geometry=False, geojson=False):
    """Town parks (Parks/Parks/MapServer layer 10)."""
    return query("Parks/Parks/MapServer/10", where, fields, geometry, geojson)


# --- Planning_Development/Comprehensive_Planning ----------------------------------------------

def place_types(where="1=1", fields="*", geometry=False, geojson=False):
    """Place_Types (Comprehensive_Planning layer 0)."""
    return query(PLANNING + "Comprehensive_Planning/MapServer/0", where, fields, geometry, geojson)


def spectrum_of_change(where="1=1", fields="*", geometry=False, geojson=False):
    """Spectrum_of_Change (Comprehensive_Planning layer 1)."""
    return query(PLANNING + "Comprehensive_Planning/MapServer/1", where, fields, geometry, geojson)


def special_area_study_boundaries(where="1=1", fields="*", geometry=False, geojson=False):
    """SpecialAreaStudyBoundaries (Comprehensive_Planning layer 2)."""
    return query(PLANNING + "Comprehensive_Planning/MapServer/2", where, fields, geometry, geojson)


def _main(argv):
    if not argv:
        print(__doc__)
        return
    name, args = argv[0], argv[1:]
    if name in ("services", "layers", "fields"):
        print(json.dumps(globals()[name](*[int(a) if a.isdigit() else a for a in args]), indent=1))
        return
    function = globals().get(name)
    if not callable(function) or name.startswith("_") or name in ("get", "query"):
        sys.exit(f"unknown endpoint {name!r}; see: python3 scripts/gis_api.py")
    where, selected, geometry = "1=1", "*", False
    positional = []
    i = 0
    while i < len(args):
        if args[i] == "--fields":
            selected, i = args[i + 1], i + 2
        elif args[i] == "--geometry":
            geometry, i = True, i + 1
        else:
            positional.append(args[i])
            i += 1
    if positional:
        where = positional[0]
    print(json.dumps(function(where, selected, geometry), indent=1, default=str))


if __name__ == "__main__":
    _main(sys.argv[1:])
