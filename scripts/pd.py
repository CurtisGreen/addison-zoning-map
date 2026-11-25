"""Helper for adding one Planned Development (PD). Used by the add-pd skill.

  python scripts/pd.py fetch "PD 461"   download ordinances and extract page text (OCR if scanned) into pdfs/; also lists
                                        town-map ordinance points inside the PD that are not in its chain
  python scripts/pd.py check "PD 461"   validate docs/data/pd/<id>.json and say what zones.json should hold

Needs pdftotext, pdftoppm (poppler) and tesseract, checked on startup. Stdlib only otherwise.
"""
import difflib
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gis_api

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
PDFS = ROOT / "pdfs"
# by right, special use permit, development plan approval (PDs only), accessory, temporary
PERMISSIONS = {"P", "S", "D", "A", "T"}
GARBLED_CHARACTERS = "~=^"
GARBLED_THRESHOLD = 8
# An acreage whose decimal point was lost, such as "4 5 611 acres" or "21 8 acres"
SPLIT_ACREAGE = re.compile(r"\d[ \t]*\n?[ \t]*\d[\d \t\n]*[ \t\n]acres?\b", re.IGNORECASE)
MIN_QUOTE_LENGTH = 12
QUOTE_MATCH_RATIO = 0.85


def read_text(path):
    """Always UTF-8; Windows would otherwise use its code page and garble section signs and quotes."""
    return path.read_text(encoding="utf-8")


def write_text(path, text):
    """UTF-8 with LF line endings on every platform."""
    with open(path, "w", encoding="utf-8", newline="\n") as file:
        file.write(text)


def read_json(path):
    return json.loads(read_text(path))


INSTALL_HINT = ("install poppler (macOS: brew install poppler tesseract; "
                "Windows: scoop install poppler tesseract, or choco install poppler tesseract) and reopen the terminal")


REQUIRED_TOOLS = ("pdftotext", "pdftoppm", "tesseract")


def require(tool):
    """Fail with an install hint instead of a stack trace when a command-line tool is missing."""
    if not shutil.which(tool):
        sys.exit(f"Missing command-line tool: {tool}. {INSTALL_HINT}.")


def run(*command):
    require(command[0])
    result = subprocess.run(command, capture_output=True, encoding="utf-8", errors="replace")
    return result.stdout


def page_count(pdf):
    """Number of pages. pdfinfo when present, else the form feeds in pdftotext's output (Xpdf has no pdfinfo)."""
    if shutil.which("pdfinfo"):
        return int(re.search(r"Pages:\s+(\d+)", run("pdfinfo", str(pdf)))[1])
    return run("pdftotext", "-enc", "UTF-8", "-layout", str(pdf), "-").count("\f")


def file_slug(pd_id):
    """'PD 461' -> 'PD-461' (same rule as data.js)."""
    return pd_id.replace("?", "").replace(" ", "-")


def pd_data_file(pd_id, name):
    """docs/data/pd file for a PD: the id plus its name, 'PD 461' + 'Midway Meadows' -> PD-461-Midway-Meadows.json
    (same rule as data.js). A PD with no name yet uses just the id."""
    label = re.sub(r"[^A-Za-z0-9]+", "-", name or "").strip("-")
    slug = file_slug(pd_id)
    return DATA / "pd" / f"{slug}-{label}.json" if label else DATA / "pd" / f"{slug}.json"


def has_split_acreage(text):
    return bool(SPLIT_ACREAGE.search(text)) and not re.search(r"\d\.\d+\s+acres?\b", text, re.IGNORECASE)


def page_texts(pdf):
    """Text of each page, cached in pdfs/<pd>/<ordinance>/pNNN.txt. Pages with no text layer, or a garbled one,
    are OCR'd.
    A text layer with an acreage that lost its decimal point counts as poor too.
    Returns (texts, list of OCR'd page numbers, text folder)."""
    folder = pdf.with_suffix("")
    folder.mkdir(exist_ok=True)
    page_total = page_count(pdf)
    texts, ocr_pages = [], []
    for number in range(1, page_total + 1):
        text_file = folder / f"p{number:03d}.txt"
        if text_file.exists() and not read_text(text_file).startswith("[OCR]") and has_split_acreage(read_text(text_file)):
            text_file.unlink()
        if not text_file.exists():
            text = run("pdftotext", "-enc", "UTF-8", "-layout", "-f", str(number), "-l", str(number), str(pdf), "-")
            garbled = sum(text.count(character) for character in GARBLED_CHARACTERS) >= GARBLED_THRESHOLD
            if len(text.strip()) < 40 or garbled or has_split_acreage(text):  # scanned page, or a poor text layer
                image = folder / f"p{number:03d}"
                run("pdftoppm", "-r", "300", "-gray", "-png", "-singlefile", "-f", str(number), "-l", str(number),
                    str(pdf), str(image))
                text = "[OCR]\n" + run("tesseract", f"{image}.png", "-")
                Path(f"{image}.png").unlink(missing_ok=True)
            write_text(text_file, text)
        text = read_text(text_file)
        texts.append(text)
        if text.startswith("[OCR]"):
            ocr_pages.append(number)
    return texts, ocr_pages, folder


MAP_TOLERANCE = 0.00005  # degrees (~5 m): a point on or just outside the polygon edge still counts


def polygons_of(geometry):
    return geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]


def segment_distance(point, start, end):
    (x, y), (x1, y1), (x2, y2) = point, start, end
    dx, dy = x2 - x1, y2 - y1
    length = dx * dx + dy * dy
    t = 0 if not length else max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / length))
    return ((x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2) ** 0.5


def point_in_polygon(point, rings):
    """Even-odd test over all rings (holes included), or within MAP_TOLERANCE of an edge."""
    x, y = point
    inside = False
    for ring in rings:
        for start, end in zip(ring, ring[1:]):
            if segment_distance(point, start, end) <= MAP_TOLERANCE:
                return True
            if (start[1] > y) != (end[1] > y) and x < (end[0] - start[0]) * (y - start[1]) / (end[1] - start[1]) + start[0]:
                inside = not inside
    return inside


def ordinances_on_map(pd_id, pd):
    """Ordinances the town map places inside the PD's polygon that the PD's chain lacks.

    The chain in the zoning layer is often incomplete, and an ordinance's point on the map is the only link to the land.
    A point has no area, so this tests whether each point lies inside the polygon.
    """
    geojson = read_json(DATA / "zones.geojson")
    shapes = [polygons_of(f["geometry"]) for f in geojson["features"] if f["properties"]["zone"] == pd_id]
    in_chain = {o["id"] for o in pd["ordinances"]}
    found = []
    for feature in gis_api.ordinances(geometry=True, geojson=True):
        geometry, row = feature["geometry"], feature["properties"]
        if not geometry or geometry["type"] != "Point" or row["ORD_ID"].strip() in in_chain:
            continue
        if any(point_in_polygon(geometry["coordinates"], rings) for polygons in shapes for rings in polygons):
            found.append(row)
    return found


def fetch(pd_id, pd):
    folder = PDFS / file_slug(pd_id)
    folder.mkdir(parents=True, exist_ok=True)
    print(f"{pd_id}  {pd['acres']} acres  ({len(pd['ordinances'])} ordinances, oldest first; later ones amend earlier)")
    for ordinance in pd["ordinances"]:
        pdf = folder / f"{ordinance['id']}.pdf"
        if not pdf.exists():
            if not ordinance.get("url"):
                print(f"  {ordinance['id']}: NO URL - add one in zones.json or find it on agendas.addisontx.gov")
                continue
            request = urllib.request.Request(ordinance["url"], headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=60) as response:
                pdf.write_bytes(response.read())
        texts, ocr_pages, text_folder = page_texts(pdf)
        ocr_note = f"  OCR pages {ocr_pages}" if ocr_pages else ""
        print(f"  {ordinance['id']}  {ordinance['date']}  {len(texts)} pages{ocr_note}\n"
              f"     {ordinance['description'][:140]}\n"
              f"     text: {text_folder.relative_to(ROOT)}/pNNN.txt   pdf: {pdf.relative_to(ROOT)}")
    extra = ordinances_on_map(pd_id, pd)
    if extra:
        print("\nOrdinances the town map places inside this PD that are not in its chain (read them; some may be per-tenant permits):")
        for row in extra:
            print(f"  {row['ORD_ID'].strip()}  {(row['DESCRIPTIO'] or '').strip()[:110]}  [{(row['ADDRESS'] or '').strip()}]  {row['HYPERLINK'] or 'no link'}")
    pd_file = pd_data_file(pd_id, pd["name"])
    state = "exists" if pd_file.exists() else "does not exist yet; create it from the schema in the add-pd skill"
    print(f"\nData file {pd_file.relative_to(ROOT)} {state}. Nothing under docs/data was changed.")


def normalize(text):
    return re.sub(r"\s+", " ", re.sub(r"[^\w%.]+", " ", text.lower())).strip()


def quote_on_page(quote, page_text):
    """True if the quote appears on the page, allowing small OCR differences."""
    quote, page_text = normalize(quote), normalize(page_text)
    if quote in page_text:
        return True
    match = difflib.SequenceMatcher(None, page_text, quote, autojunk=False).find_longest_match(
        0, len(page_text), 0, len(quote))
    start = match.a - match.b  # where the quote would begin on the page
    # Compare same-length stretches of page text near that spot, allowing a few dropped or extra characters
    ratio, offset = max((difflib.SequenceMatcher(None, page_text[max(0, s): max(0, s) + len(quote)], quote).ratio(), s)
                        for s in range(start - 5, start + 6))
    if ratio < QUOTE_MATCH_RATIO:
        return False
    # Letters may differ a little (OCR noise), but numbers must match exactly
    quote_numbers = re.findall(r"\d+", quote)
    nearby_numbers = re.findall(r"\d+", page_text[max(0, offset - 5): max(0, offset) + len(quote) + 5])
    return any(nearby_numbers[i: i + len(quote_numbers)] == quote_numbers for i in range(len(nearby_numbers) + 1))


def valid_value(value, split_allowed=True):
    """A dimension value: a number, "none", {min, max}, {options: [numbers]}, or (split) a dict of those by area or type."""
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)) or value == "none":
        return True
    if isinstance(value, dict) and set(value) == {"min", "max"}:
        return all(isinstance(value[k], (int, float)) for k in value)
    if isinstance(value, dict) and set(value) == {"options"}:
        return isinstance(value["options"], list) and all(isinstance(o, (int, float)) for o in value["options"])
    if isinstance(value, dict) and split_allowed and value:
        return all(valid_value(part, False) for part in value.values())
    return False


def check(pd_id, pd, index):
    base = read_json(DATA / "base.json")
    pd_path = pd_data_file(pd_id, pd["name"])
    if not pd_path.exists():  # a new PD's file has no name in it until zones.json is updated
        pd_path = pd_data_file(pd_id, None)
    pd_data = read_json(pd_path)
    use_names = {use["name"] for use in base["uses"]}
    ordinance_ids = [o["id"] for o in pd["ordinances"]]
    pages_by_ordinance = {}
    for ordinance_id in ordinance_ids:
        pdf = PDFS / file_slug(pd_id) / f"{ordinance_id}.pdf"
        if pdf.exists():
            pages_by_ordinance[ordinance_id] = page_texts(pdf)[0]
    errors, warnings = [], []

    def check_evidence(label, entry):
        """Every value needs an ordinance, a page in it, and a quote found on that page."""
        ordinance_id = entry.get("ordinance")
        if ordinance_id not in ordinance_ids:
            return errors.append(f"{label}: ordinance '{ordinance_id}' is not one of {ordinance_ids}")
        pages = pages_by_ordinance.get(ordinance_id)
        if pages is None:
            return errors.append(f"{label}: ordinance {ordinance_id} not downloaded (run fetch)")
        page = entry.get("page")
        if not isinstance(page, int) or not 1 <= page <= len(pages):
            return errors.append(f"{label}: page {page} is outside 1-{len(pages)}")
        quote = entry.get("quote", "")
        if len(normalize(quote)) < MIN_QUOTE_LENGTH:
            return errors.append(f"{label}: quote too short ({quote!r}); use at least {MIN_QUOTE_LENGTH} characters")
        if not quote_on_page(quote, pages[page - 1]):
            errors.append(f"{label}: quote not found on {ordinance_id} p.{page}: {quote[:80]!r}")

    purpose = pd_data.get("purpose", "")
    if purpose:
        # Exact wording, possibly shortened with "…": every piece must appear in the ordinance text
        all_text = " ".join(" ".join(pages) for pages in pages_by_ordinance.values())
        for piece in re.split(r"…|\.\.\.", purpose):
            if normalize(piece) and normalize(piece) not in normalize(all_text):
                errors.append(f"purpose: not found word for word in the ordinances: {piece.strip()[:80]!r}")
    if pd_data.get("id") != pd_id:
        errors.append(f"id should be {pd_id!r}")
    if pd_data.get("base") is None:
        warnings.append("base is null: the site shows only this PD's own uses and dimensions")
    elif pd_data["base"] not in base["districts"]:
        errors.append(f"base {pd_data['base']!r} is not a district in base.json")
    for i, use in enumerate(pd_data.get("uses", [])):
        label = f"uses[{i}] {use.get('name')}"
        if use.get("name") not in use_names:
            errors.append(f"{label}: not a UDC use name (put non-matching uses in otherUses)")
        if use.get("permission") not in PERMISSIONS | {"none"}:
            errors.append(f"{label}: permission must be P, S, D, A, T, or none")
        check_evidence(label, use)
    for i, use in enumerate(pd_data.get("otherUses", [])):
        if use.get("permission", "P") not in PERMISSIONS:
            errors.append(f"otherUses[{i}]: permission must be P, S, D, A, or T (or left out)")
        check_evidence(f"otherUses[{i}]", use)
    for i, row in enumerate(pd_data.get("parking", [])):
        if not row.get("use") or not row.get("requirement"):
            errors.append(f"parking[{i}]: needs use and requirement")
        for rate in row.get("rates", []):
            if not all(isinstance(rate.get(k), (int, float)) for k in ("spaces", "per")) or not rate.get("unit"):
                errors.append(f"parking[{i}]: each rate needs numbers spaces and per, and a unit")
                continue
            if rate["unit"].startswith("sq ft"):  # floor-area ratios read "X per 1,000 sq ft ..."
                per_thousand = f"{1000 * rate['spaces'] / rate['per']:.1f}".rstrip("0").rstrip(".")
                if f"{per_thousand} per 1,000 sq ft" not in row.get("requirement", ""):
                    errors.append(f"parking[{i}]: requirement must say '{per_thousand} per 1,000 sq ft ...' "
                                  f"for the rate 1 per {rate['per']}: {row.get('requirement')!r}")
        check_evidence(f"parking[{i}]", row)
    for field, dimension in pd_data.get("dimensions", {}).items():
        if field not in base["dimensionFields"]:
            errors.append(f"dimensions.{field}: unknown field (allowed: {', '.join(base['dimensionFields'])})")
        if not isinstance(dimension, dict) or "value" not in dimension:
            errors.append(f"dimensions.{field}: must be {{value, ordinance, page, quote}}")
            continue
        if not valid_value(dimension["value"]):
            errors.append(f"dimensions.{field}: value must be a number, \"none\", {{min, max}}, {{options: [...]}}, or those split by type")
        check_evidence(f"dimensions.{field}", dimension)

    if "mustFollowPlan" in pd_data and not isinstance(pd_data["mustFollowPlan"], bool):
        errors.append("mustFollowPlan must be true or false")

    for warning in warnings:
        print("WARN  ", warning)
    for error in errors:
        print("ERROR ", error)
    for key, text in pd_data.get("review", {}).items():
        print("REVIEW", key, "-", text)
    if errors:
        sys.exit(1)
    families = {"residential", "mixed", "commercial", "industrial", "airport", "planned"}
    if pd_data.get("family") not in families | {None}:
        print(f"ERROR family must be one of {sorted(families)}")
        sys.exit(1)
    wanted = {"done": True, "name": pd_data.get("name", ""), "base": pd_data.get("base")}
    if pd_data.get("family"):
        wanted["family"] = pd_data["family"]
    for key, value in wanted.items():
        if pd.get(key) != value:
            print(f"UPDATE zones.json entry for {pd_id}: set {key} to {value!r} (now {pd.get(key)!r})")
    expected = pd_data_file(pd_id, pd_data.get("name"))
    if pd_path != expected:
        print(f"RENAME {pd_path.relative_to(ROOT)} to {expected.relative_to(ROOT)} (use git mv); the site loads the file by the name in zones.json")
    print(f"OK - {pd_id} has no errors. Nothing under docs/data was changed.")


def main():
    if hasattr(sys.stdout, "reconfigure"):  # Windows consoles default to a legacy code page
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) != 3 or sys.argv[1] not in ("fetch", "check"):
        sys.exit(__doc__)
    for tool in REQUIRED_TOOLS:  # checked first: a missing tool would otherwise fail partway through
        require(tool)
    command, pd_id = sys.argv[1], sys.argv[2]
    index = read_json(DATA / "zones.json")
    pd = index["zones"].get(pd_id)
    if not pd or pd["kind"] != "pd":
        number = pd_id.replace("PD", "").strip()
        close = [zone_id for zone_id, zone in index["zones"].items() if zone["kind"] == "pd" and number in zone_id]
        sys.exit(f"{pd_id!r} is not a PD in zones.json. Close matches: {close or 'none'}")
    if command == "fetch":
        fetch(pd_id, pd)
    else:
        check(pd_id, pd, index)


if __name__ == "__main__":
    main()
