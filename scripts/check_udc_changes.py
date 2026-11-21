"""Check docs/data/udc-changes.json: required fields, known kinds, page numbers, and that quotes
for text changes appear on the cited page of the amendment PDF when you pass the PDF.

  python scripts/check_udc_changes.py
  python scripts/check_udc_changes.py 2026-12 path/to/amendment.pdf   also look for each quote on its page

Quote checking needs pdftotext (poppler or Xpdf). Nothing under docs/data is changed.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "docs" / "data"
KINDS = {"added", "changed", "removed"}
AMENDMENT_FIELDS = ("id", "title", "date", "changes")
CHANGE_FIELDS = ("kind", "section", "title", "summary", "page")


def normalize(text):
    return re.sub(r"\s+", " ", re.sub(r"[^\w%.,]+", " ", text.lower())).strip()


def page_text(pdf, page):
    command = ["pdftotext", "-enc", "UTF-8", "-layout", "-f", str(page), "-l", str(page), str(pdf), "-"]
    return subprocess.run(command, capture_output=True, encoding="utf-8", errors="replace").stdout


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    with open(DATA / "udc-changes.json", encoding="utf-8") as file:
        amendments = json.load(file)["amendments"]
    pdf_id, pdf = (sys.argv[1], Path(sys.argv[2])) if len(sys.argv) == 3 else (None, None)
    if pdf and not shutil.which("pdftotext"):
        sys.exit("Missing command-line tool: pdftotext (poppler). Install it to check quotes.")
    errors, seen = [], set()
    for amendment in amendments:
        label = f"amendment {amendment.get('id')}"
        for field in AMENDMENT_FIELDS:
            if field not in amendment:
                errors.append(f"{label}: missing {field}")
        if amendment.get("id") in seen:
            errors.append(f"{label}: duplicate id")
        seen.add(amendment.get("id"))
        if amendment.get("changes") and not amendment.get("url"):
            errors.append(f"{label}: has changes but no url")
        for i, change in enumerate(amendment.get("changes", [])):
            where = f"{label} change {i} ({change.get('title')})"
            for field in CHANGE_FIELDS:
                if field not in change:
                    errors.append(f"{where}: missing {field}")
            if change.get("kind") not in KINDS:
                errors.append(f"{where}: kind must be one of {sorted(KINDS)}")
            if not isinstance(change.get("page"), int) or change["page"] < 1:
                errors.append(f"{where}: page must be a positive number")
            if "onSite" in change and not isinstance(change["onSite"], bool):
                errors.append(f"{where}: onSite must be true or false")
            if pdf and amendment.get("id") == pdf_id and change.get("quote"):
                if normalize(change["quote"]) not in normalize(page_text(pdf, change["page"])):
                    errors.append(f"{where}: quote not found on p.{change['page']}")
    for error in errors:
        print("ERROR", error)
    if errors:
        sys.exit(1)
    print(f"OK - {len(amendments)} amendments, no errors. Nothing under docs/data was changed.")


if __name__ == "__main__":
    main()
