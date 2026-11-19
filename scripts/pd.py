"""Helper for adding one Planned Development (PD). Used by the add-pd skill.

  python3 scripts/pd.py fetch "PD 461"   download ordinances, extract page text (OCR if scanned), make skeleton JSON
  python3 scripts/pd.py check "PD 461"   validate docs/data/pd/<id>.json; on pass mark it done in zones.json

Needs: pdfinfo, pdftotext, pdftoppm (poppler) and tesseract for scanned pages. Stdlib only otherwise.
"""
import difflib
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
PDFS = ROOT / "pdfs"
PERMISSIONS = {"P", "S", "A", "T"}  # by right, special use permit, accessory, temporary
GARBLED_CHARACTERS = "~=^"
GARBLED_THRESHOLD = 8
MIN_QUOTE_LENGTH = 12
QUOTE_MATCH_RATIO = 0.85
SKELETON = {"id": "", "name": "", "base": None, "usesOnly": False, "purpose": "", "uses": [], "otherUses": [],
            "dimensions": {}, "review": {}, "notes": []}


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def run(*command):
    return subprocess.run(command, capture_output=True, text=True).stdout


def file_slug(pd_id):
    """'PD 461' -> 'PD-461' (same rule as data.js)."""
    return pd_id.replace("?", "").replace(" ", "-")


def page_texts(pdf):
    """Text of each page, cached in pdfs/<pd>/<ordinance>/pNNN.txt. Pages with no text layer, or a garbled one,
    are OCR'd.
    Returns (texts, list of OCR'd page numbers, text folder)."""
    folder = pdf.with_suffix("")
    folder.mkdir(exist_ok=True)
    page_count = int(re.search(r"Pages:\s+(\d+)", run("pdfinfo", str(pdf)))[1])
    texts, ocr_pages = [], []
    for number in range(1, page_count + 1):
        text_file = folder / f"p{number:03d}.txt"
        if not text_file.exists():
            text = run("pdftotext", "-layout", "-f", str(number), "-l", str(number), str(pdf), "-")
            garbled = sum(text.count(character) for character in GARBLED_CHARACTERS) >= GARBLED_THRESHOLD
            if len(text.strip()) < 40 or garbled:  # scanned page, or a poor text layer
                image = folder / f"p{number:03d}"
                run("pdftoppm", "-r", "300", "-gray", "-png", "-singlefile", "-f", str(number), "-l", str(number),
                    str(pdf), str(image))
                text = "[OCR]\n" + run("tesseract", f"{image}.png", "-")
                Path(f"{image}.png").unlink(missing_ok=True)
            text_file.write_text(text)
        text = text_file.read_text()
        texts.append(text)
        if text.startswith("[OCR]"):
            ocr_pages.append(number)
    return texts, ocr_pages, folder


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
            pdf.write_bytes(urllib.request.urlopen(request, timeout=60).read())
        texts, ocr_pages, text_folder = page_texts(pdf)
        ocr_note = f"  OCR pages {ocr_pages}" if ocr_pages else ""
        print(f"  {ordinance['id']}  {ordinance['date']}  {len(texts)} pages{ocr_note}\n"
              f"     {ordinance['description'][:140]}\n"
              f"     text: {text_folder.relative_to(ROOT)}/pNNN.txt   pdf: {pdf.relative_to(ROOT)}")
    pd_file = DATA / "pd" / f"{file_slug(pd_id)}.json"
    if pd_file.exists():
        print(f"\nExisting file kept: {pd_file.relative_to(ROOT)}")
    else:
        write_json(pd_file, {**SKELETON, "id": pd_id})
        print(f"\nSkeleton written: {pd_file.relative_to(ROOT)}")


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
    # Compare same-length stretches of page text near that spot, allowing a few dropped or extra characters.
    ratio, offset = max((difflib.SequenceMatcher(None, page_text[max(0, s): max(0, s) + len(quote)], quote).ratio(), s)
                        for s in range(start - 5, start + 6))
    if ratio < QUOTE_MATCH_RATIO:
        return False
    # Letters may differ a little (OCR noise), but numbers must match exactly.
    quote_numbers = re.findall(r"\d+", quote)
    nearby_numbers = re.findall(r"\d+", page_text[max(0, offset - 5): max(0, offset) + len(quote) + 5])
    return any(nearby_numbers[i: i + len(quote_numbers)] == quote_numbers for i in range(len(nearby_numbers) + 1))


def check(pd_id, pd, index):
    base = read_json(DATA / "base.json")
    pd_data = read_json(DATA / "pd" / f"{file_slug(pd_id)}.json")
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
        # Exact wording, possibly shortened with "…": every piece must appear in the ordinance text.
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
            errors.append(f"{label}: permission must be P, S, A, T, or none")
        check_evidence(label, use)
    for i, use in enumerate(pd_data.get("otherUses", [])):
        if use.get("permission", "P") not in PERMISSIONS:
            errors.append(f"otherUses[{i}]: permission must be P, S, A, or T (or left out)")
        check_evidence(f"otherUses[{i}]", use)
    for i, row in enumerate(pd_data.get("parking", [])):
        if not row.get("use") or not row.get("requirement"):
            errors.append(f"parking[{i}]: needs use and requirement")
        check_evidence(f"parking[{i}]", row)
    for field, dimension in pd_data.get("dimensions", {}).items():
        if field not in base["dimensionFields"]:
            errors.append(f"dimensions.{field}: unknown field (allowed: {', '.join(base['dimensionFields'])})")
        if not isinstance(dimension, dict) or "value" not in dimension:
            errors.append(f"dimensions.{field}: must be {{value, ordinance, page, quote}}")
            continue
        check_evidence(f"dimensions.{field}", dimension)

    for warning in warnings:
        print("WARN  ", warning)
    for error in errors:
        print("ERROR ", error)
    for key, text in pd_data.get("review", {}).items():
        print("REVIEW", key, "-", text)
    if errors:
        sys.exit(1)
    pd.update(done=True, name=pd_data.get("name", ""), base=pd_data.get("base"))
    write_json(DATA / "zones.json", index)
    print(f"OK - {pd_id} marked done in zones.json. Review the values against the PDFs before committing.")


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("fetch", "check"):
        sys.exit(__doc__)
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
