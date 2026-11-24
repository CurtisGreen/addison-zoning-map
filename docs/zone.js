// Detail page for one zone: zone.html?id=CG or zone.html?id=PD%20461
import {
  PERMISSIONS,
  planPermission,
  escapeHtml,
  evidenceLink,
  externalLink,
  formatValue,
  getZone,
  loadJson,
  idWithName,
  isSplit,
  loadSiteData,
  showError,
  zonePageUrl,
  zoneTitle,
} from "./data.js";

const noteNumber = (number) => `<sup>${number}</sup>`;

/** `offset` leaves numbers free for notes that are already using them (the UDC table's own notes). */
function createNotes(offset = 0) {
  const texts = [];
  return {
    /** Returns the number(s) to put next to the item, or "" when there is no note. A list gives one number per note. */
    mark(textOrList) {
      const numbers = [textOrList ?? []].flat().map((text) => {
        if (!texts.includes(text)) texts.push(text);
        return offset + texts.indexOf(text) + 1;
      });
      return numbers.length
        ? noteNumber(numbers.sort((a, b) => a - b).join(","))
        : "";
    },
    render() {
      return texts
        .map(
          (text, index) =>
            `<p class="muted note">${noteNumber(offset + index + 1)} ${escapeHtml(text)}</p>`,
        )
        .join("");
    },
  };
}

const tableOf = (rows) =>
  `<div class="table-wrap"><table>${rows.filter(Boolean).join("")}</table></div>`;

function renderHeading(zone) {
  // Purposes are exact quotes from the UDC or the PD ordinance.
  const purpose = zone.purpose ? `<p>“${escapeHtml(zone.purpose)}”</p>` : "";
  return `<h1>${escapeHtml(zoneTitle(zone))}</h1>${purpose}`;
}

function renderFacts(zone, base) {
  const notes = createNotes();
  const rows = [];
  if (zone.base) {
    const name = base.districts[zone.base]?.name || "";
    const link = `<a href="${zonePageUrl(zone.base)}">${escapeHtml(idWithName(zone.base, name))}</a>`;
    rows.push(["Base district", link + notes.mark(zone.review.base)]);
  }
  rows.push([
    "Source",
    zone.sources.map(externalLink).join(", ") +
      notes.mark(zone.review.ordinances),
  ]);
  // The ordinance's acreage, when its boundary includes the roads.
  const acresWithRoads = zone.pdData?.acresWithRoads;
  const withRoads = acresWithRoads
    ? ` (${acresWithRoads.toFixed(1)} including roads)`
    : "";
  if (zone.kind === "pd")
    rows.push([
      "Area",
      `${zone.index.acres} acres${withRoads}${notes.mark(zone.review.acres)}`,
    ]);
  const facts = `<dl>${rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("")}</dl>`;
  return facts + notes.render();
}

/** A value split by area, lot type, or street type is an object; anything else is one value. */
const partsOf = (value) => (isSplit(value) ? Object.keys(value) : []);

/** True when some dimensions are split by part and others are not, so the single-value table needs an "All" header. */
function hasSplitAndSingle(groups) {
  const split = groups.map((group) => partsOf(group[0][1].value).length > 0);
  return split.includes(true) && split.includes(false);
}

function groupBySplit(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = partsOf(entry[1].value).join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()];
}

/**
 * One table for a group of dimensions with the same parts:
 *                    | Zero-Lot-Line | Single Family Detached | Duplex
 *   Lot area, min    | 5,750 sq ft   | 7,200 sq ft            | 8,800 sq ft
 *   Lot width, min   | 50 ft         | 60 ft                  | 80 ft
 * Single values have no header, unless `labelSingle` is set (another table on the page has one): then "All". `notes` marks rows with a note; `baseDimensions` makes values read "base → new".
 */
function dimensionTable(
  group,
  { zone, base, markFor, markForPart, baseDimensions, labelSingle },
) {
  const parts = partsOf(group[0][1].value);
  const header = parts.length
    ? `<tr class="head"><th></th>${parts.map((part) => `<th>${escapeHtml(part)}</th>`).join("")}<th></th></tr>`
    : labelSingle
      ? `<tr class="head"><th></th><th>All</th><th></th></tr>`
      : "";
  const rows = group.map(([field, dimension]) => {
    const { label, unit } = base.dimensionFields[field];
    const mark = markFor ? markFor(field) : "";
    const source = `<td class="source">${evidenceLink(dimension, zone, base)}</td>`;
    // Height in feet and height in stories are compared with each other.
    const baseField = baseDimensions?.[field] ? field : SAME_QUANTITY[field];
    // A base with no value reads as "None".
    const baseValue = baseDimensions
      ? (baseDimensions[baseField]?.value ?? "none")
      : undefined;
    const baseUnit = base.dimensionFields[baseField]?.unit ?? unit;
    const cell = (value) =>
      `<td>${changeText(baseValue, value, unit, baseUnit)}</td>`;
    return parts.length
      ? `<tr><th>${escapeHtml(label)}${mark}</th>${parts
          .map((part) =>
            cell(dimension.value[part]).replace(
              "</td>",
              `${markForPart ? markForPart(field, part) : ""}</td>`,
            ),
          )
          .join("")}${source}</tr>`
      : `<tr><th>${escapeHtml(label)}</th>${cell(dimension.value).replace("</td>", `${mark}</td>`)}${source}</tr>`;
  });
  return tableOf([header, ...rows]);
}

/** Dimension fields that measure the same thing in different units, so a change can be shown from one to the other. */
const SAME_QUANTITY = {
  heightMax: "heightMaxStories",
  heightMaxStories: "heightMax",
};

/**
 * "16,000 → 5,750 sq ft": the base value, an arrow, then the new value, with the unit once at the end.
 * A base that is itself split or not a plain number keeps its own unit. With no base value, just the new value.
 */
function changeText(baseValue, newValue, unit, baseUnit = unit) {
  const to = escapeHtml(formatValue(newValue, unit));
  if (baseValue === undefined) return to;
  const from = escapeHtml(
    formatValue(
      baseValue,
      typeof baseValue === "number" && baseUnit === unit ? "" : baseUnit,
    ),
  );
  return `<span class="before">${from} →</span> ${to}`;
}

/** Uses a PD adds or changes, or other uses it lists. */
function useRows(pd, zone, base) {
  // A PD that lists all its own uses (pdUsesOnly) shows them once, under Allowed uses.
  const listed =
    pd.base && !pd.pdUsesOnly
      ? pd.uses.map((use) => ({ text: use.name, ...use }))
      : [];
  const other = pd.pdUsesOnly ? [] : pd.otherUses;
  // Several UDC uses can come from one ordinance phrase (`text`), which is shown once.
  const seen = new Set();
  return [...listed, ...other]
    .filter((use) => {
      const key = `${use.text}|${use.permission ?? "P"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((use) => {
      const after = PERMISSIONS[planPermission(pd, use.permission ?? "P")];
      const notAllowed = (title) =>
        `<span class="before mark" title="${title}">✕</span>`; // a grey X, not the dash used in the lists
      const afterMark =
        after === PERMISSIONS.none
          ? notAllowed(after.label)
          : `<span class="${after.className} mark" title="${after.label}">${after.mark}</span>`;
      let permission = afterMark;
      if (pd.base) {
        // "Before → after": the base district's mark for this use (a use with no UDC name was not allowed there).
        const baseCode = base.districts[pd.base]?.uses[use.name] ?? "none";
        const before = PERMISSIONS[baseCode];
        const beforeMark =
          before === PERMISSIONS.none
            ? notAllowed(`${before.label} in ${escapeHtml(pd.base)}`)
            : `<span class="before mark" title="${before.label} in ${escapeHtml(pd.base)}">${before.mark}</span>`;
        permission = `<span role="img" aria-label="${before.label} in ${escapeHtml(pd.base)}, now ${after.label.toLowerCase()}">${beforeMark} → ${afterMark}</span>`;
      }
      return `<tr><td>${escapeHtml(use.text)}</td><td class="nowrap">${permission}</td><td class="source">${evidenceLink(use, zone, base)}</td></tr>`;
    });
}

/** Review keys whose notes appear next to what they are about. */
const NOTES_SHOWN_ELSEWHERE = [
  "base",
  "ordinances",
  "acres",
  "uses",
  "legacyUses",
  "dimensions",
];

/** What a PD changes from its base district, plus uses with no UDC match, notes, and other review items. */
function renderPdRules(zone, base) {
  const pd = zone.pdData;
  if (!pd) return "";
  const notes = createNotes();
  const rows = useRows(pd, zone, base);
  const useTable = rows.length
    ? tableOf([
        `<tr class="head"><th>Use</th><th class="nowrap">${pd.base ? "Before → after" : "Permission"}</th><th></th></tr>`,
        ...rows,
      ])
    : "";
  // Without a base, the PD's dimensions already appear under Dimensions.
  const changed = pd.base ? Object.entries(pd.dimensions) : [];
  const baseDimensions = base.districts[pd.base]?.dimensions || {};
  const changedGroups = groupBySplit(changed);
  const labelSingle = hasSplitAndSingle(changedGroups);
  const dimensionTables = changedGroups.map((group) =>
    dimensionTable(group, { zone, base, baseDimensions, labelSingle }),
  );
  const shownElsewhere = new Set([
    ...NOTES_SHOWN_ELSEWHERE,
    ...Object.keys(pd.dimensions),
  ]);
  const marks = Object.entries(pd.review)
    .filter(([key]) => !shownElsewhere.has(key))
    .map(([, text]) => notes.mark(text));
  if (!useTable && !dimensionTables.length && !marks.length) return "";
  const heading = pd.base ? "Changes from base" : "Other uses and rules";
  return `<h2>${heading}${marks.join(" ")}</h2>${useTable}${dimensionTables.join("")}${notes.render()}`;
}

/** A PD's ordinances, oldest first. A PD's data file can give a shorter description than the town map's. */
function renderHistory(zone) {
  if (zone.kind !== "pd" || !zone.index.ordinances.length) return "";
  const rows = zone.index.ordinances.map((ordinance) => {
    const description =
      zone.pdData?.history?.[ordinance.id] ?? ordinance.description;
    const link = externalLink({
      label: `Ord. ${ordinance.id}`,
      url: ordinance.url,
    });
    return `<tr><td>${ordinance.date?.slice(0, 4) ?? ""}</td><td>${escapeHtml(description)}</td><td class="source">${link}</td></tr>`;
  });
  return `<h2>History</h2>${tableOf(rows)}`;
}

function renderCurtisNotes(zone) {
  const text = zone.pdData?.curtisNotes;
  return text ? `<h2>Curtis's notes</h2><p>${escapeHtml(text)}</p>` : "";
}

/** A PD's own parking ratios, one row per use. */
function renderParking(zone, base) {
  const rows = zone.pdData?.parking || [];
  if (!rows.length) return "";
  const body = rows.map(
    (row) =>
      `<tr><td>${escapeHtml(row.use)}</td><td>${escapeHtml(row.requirement)}</td><td class="source">${evidenceLink(row, zone, base)}</td></tr>`,
  );
  return `<h2>Parking</h2>${tableOf([`<tr class="head"><th>Use</th><th>Spaces required</th><th></th></tr>`, ...body])}`;
}

/** A PD's general conditions from the ordinance, one per line. */
function renderNotes(zone) {
  const items = zone.pdData?.notes || [];
  if (!items.length) return "";
  const line = (item) =>
    typeof item === "string"
      ? `<li>${escapeHtml(item)}</li>`
      : `<li>${escapeHtml(item.heading)}<ul>${item.items.map(line).join("")}</ul></li>`;
  return `<h2>Other requirements</h2><ul>${items.map(line).join("")}</ul>`;
}

const ZONE_TYPES = {
  "R-1": "Residential",
  "R-2": "Residential",
  "R-3": "Residential",
  "M-1": "Mixed-Use",
  "M-2": "Mixed-Use",
  "M-3": "Mixed-Use",
  "M-4": "Mixed-Use",
  CL: "Nonresidential",
  CG: "Nonresidential",
  LI: "Nonresidential",
  AA: "Nonresidential",
};

/** The parts of a standard that apply in this district. Parts that name other districts are left out. */
function applicableItems(items, district) {
  return items
    .filter((item) => !item.districts || item.districts.includes(district))
    .map((item) =>
      item.items
        ? { ...item, items: applicableItems(item.items, district) }
        : item,
    );
}

/** A table from a standard. Tables with a column per zone type show only this district's column. */
function renderStandardTable(table, district) {
  const zoneType = table.byZoneType ? ZONE_TYPES[district] : undefined;
  const keep = table.columns.map(
    (column, index) => index === 0 || !zoneType || column === zoneType,
  );
  const pick = (cells) => cells.filter((_, index) => keep[index]);
  const head = `<tr class="head">${pick(table.columns)
    .map((column) => `<th>${escapeHtml(column)}</th>`)
    .join("")}</tr>`;
  const rows = table.rows.map(
    (row) =>
      `<tr>${pick(row)
        .map((cell, index) =>
          index === 0
            ? `<th>${escapeHtml(cell)}</th>`
            : `<td>${escapeHtml(cell)}</td>`,
        )
        .join("")}</tr>`,
  );
  const notes = (table.notes || [])
    .map((note) => `<p>${escapeHtml(note)}</p>`)
    .join("");
  return `<p>${escapeHtml(table.title)}</p>${tableOf([head, ...rows])}${notes}`;
}

function renderStandardItems(items, district) {
  const rows = items.map((item) => {
    const label = item.label
      ? `<span class="label">${escapeHtml(item.label)}.</span> `
      : "";
    const text = item.text ? escapeHtml(item.text) : "";
    const table = item.table ? renderStandardTable(item.table, district) : "";
    const nested = item.items?.length
      ? renderStandardItems(item.items, district)
      : "";
    return `<li>${label}${text}${table}${nested}</li>`;
  });
  return `<ul class="standard">${rows.join("")}</ul>`;
}

const standardAnchor = (id) => `standard-${id}`;

/** A use-specific standard from UDC Article 4, as a closed fold. */
function renderStandard({ id, standard, items, district, base }) {
  const udcLink = externalLink({
    label: `UDC page ${standard.page}`,
    url: `${base.sources.udc.url}#page=${standard.page}`,
  });
  return `<details class="standard-fold" id="${standardAnchor(id)}"><summary>§${id} ${escapeHtml(standard.title)}</summary><p class="muted">${udcLink}</p>${renderStandardItems(items, district)}</details>`;
}

function renderUses(zone, base, standards) {
  const notes = createNotes();
  if (zone.legacyUses) {
    const heading = `Allowed uses${notes.mark(zone.review.legacyUses)}`;
    const items = zone.legacyUses
      .map((use) => `<li>${escapeHtml(use)}</li>`)
      .join("");
    return `<h2>${heading}</h2><ul>${items}</ul>${notes.render()}`;
  }
  if (!zone.uses) return "";
  const district = zone.kind === "pd" ? zone.base : zone.id;
  // A PD with no base district has its own rules, so the UDC's use standards are not shown.
  const showStandards = Boolean(district);
  // A PD that builds on a base district shows that district's uses plus its own changes.
  const fromBase =
    zone.kind === "pd" && zone.base && !zone.pdData?.pdUsesOnly
      ? ` (From base ${escapeHtml(zone.base)})`
      : "";
  const heading = `Allowed uses${fromBase}${notes.mark(zone.review.uses)}`;
  const byCategory = new Map();
  const applicableStandards = new Map();
  for (const use of base.uses) {
    const permission = zone.uses[use.name];
    if (!permission) continue;
    const { mark, className } = PERMISSIONS[permission];
    const standard = standards[use.standard];
    const items =
      standard && showStandards
        ? applicableItems(standard.items, district)
        : [];
    let standardLink = "";
    if (items.length) {
      applicableStandards.set(use.standard, { standard, items });
      standardLink = ` <a class="muted" href="#${standardAnchor(use.standard)}">§${use.standard}</a>`;
    }
    const pdSource = zone.pdData?.uses.find((pdUse) => pdUse.name === use.name);
    const line = `<li><span class="${className}">${mark}</span> ${escapeHtml(use.name)}${standardLink} ${evidenceLink(pdSource, zone, base)}</li>`;
    if (!byCategory.has(use.category)) byCategory.set(use.category, []);
    byCategory.get(use.category).push(line);
  }
  const legend = Object.values(PERMISSIONS)
    .filter(
      (permission) =>
        permission.className !== "not-allowed" && permission.inLegend !== false,
    )
    .map((permission) => `${permission.mark} ${permission.label.toLowerCase()}`)
    .join(", ");
  // The asterisk on a use's check mark (P*) points to this line.
  const planNote = zone.pdData?.mustFollowPlan
    ? '<p class="muted">*Must follow development plan exactly</p>'
    : "";
  // A PD that lists all its own uses shows the ones with no UDC name as a last group.
  const ordinanceOnlyUses = zone.pdData?.pdUsesOnly
    ? zone.pdData.otherUses
    : [];
  if (ordinanceOnlyUses.length)
    for (const use of ordinanceOnlyUses) {
      const { mark, className } =
        PERMISSIONS[planPermission(zone.pdData, use.permission ?? "P")];
      // With no base district and no group named, the uses need no sub-heading under "Allowed uses".
      const category = use.group ?? (zone.base ? "Other uses" : "");
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory
        .get(category)
        .push(
          `<li><span class="${className}">${mark}</span> ${escapeHtml(use.text)} ${evidenceLink(use, zone, base)}</li>`,
        );
    }
  const groups = [...byCategory].map(
    ([category, lines]) =>
      `${category ? `<h3>${escapeHtml(category)}</h3>` : ""}<ul class="uses">${lines.join("")}</ul>`,
  );
  // No uses to list and no note about them: leave the whole section out.
  if (!groups.length && !zone.review.uses) return "";
  const folds = [...applicableStandards]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, { standard, items }]) =>
      renderStandard({ id, standard, items, district, base }),
    );
  const extraRequirements = folds.length
    ? `<details class="extra-requirements"><summary>Extra use requirements</summary>${folds.join("")}</details>`
    : "";
  return (
    `<h2>${heading}</h2><p class="muted">${legend}</p>${planNote}${groups.join("")}` +
    extraRequirements +
    notes.render()
  );
}

/** The table's own notes keep the UDC's numbers, so AA's "Minimum of 10 feet" note is 1, as in the table. */
function renderDimensions(zone, base) {
  const entries = Object.entries(zone.dimensions);
  const shownNumbers = new Set(Object.values(zone.noteRefs).flat());
  const notes = createNotes(Math.max(0, ...shownNumbers)); // other notes continue after the UDC's numbers
  // A review note can be one text for the whole row, or an object of texts by part ({"North side": "…"}) for a single value.
  const isPartNotes = (note) =>
    Boolean(note) && typeof note === "object" && !Array.isArray(note);
  const markFor = (key) =>
    (zone.noteRefs[key] ? noteNumber(zone.noteRefs[key].join(",")) : "") +
    (isPartNotes(zone.review[key]) ? "" : notes.mark(zone.review[key]));
  const markForPart = (key, part) =>
    isPartNotes(zone.review[key]) ? notes.mark(zone.review[key][part]) : "";
  const heading = `Dimensions${markFor("dimensions")}`;
  const udcNotes = [...shownNumbers]
    .sort((a, b) => a - b)
    .map(
      (number) =>
        `<p class="muted note">${noteNumber(number)} “${escapeHtml(zone.tableNotes[number])}”</p>`,
    )
    .join("");
  if (!entries.length) {
    const rendered = udcNotes + notes.render();
    return rendered ? `<h2>${heading}</h2>${rendered}` : "";
  }
  const groups = groupBySplit(entries);
  const labelSingle = hasSplitAndSingle(groups);
  const tables = groups.map((group) =>
    dimensionTable(group, { zone, base, markFor, markForPart, labelSingle }),
  );
  return `<h2>${heading}</h2>${tables.join("")}${udcNotes}${notes.render()}`;
}

async function initZonePage() {
  const page = document.getElementById("zone");
  const zoneId = new URLSearchParams(location.search).get("id");
  const zone = zoneId && (await getZone(zoneId));
  if (!zone) {
    page.innerHTML = "<h1>Zone not found</h1>";
    return;
  }
  const [{ base }, standards] = await Promise.all([
    loadSiteData(),
    loadJson("data/standards.json"),
  ]);
  document.title = zoneTitle(zone);
  page.innerHTML = [
    renderHeading(zone),
    renderFacts(zone, base),
    renderCurtisNotes(zone),
    renderPdRules(zone, base),
    renderUses(zone, base, standards),
    renderDimensions(zone, base),
    renderParking(zone, base),
    renderNotes(zone),
    renderHistory(zone),
  ].join("");
}

/** Opens every fold around the element a #link points to, then scrolls to it. */
function openFoldFor(hash) {
  const target =
    hash && document.getElementById(decodeURIComponent(hash.slice(1)));
  if (!target) return;
  for (let element = target; element; element = element.parentElement) {
    if (element.tagName === "DETAILS") element.open = true;
  }
  target.scrollIntoView();
  history.replaceState(null, "", location.pathname + location.search); // a reload starts closed
}

document.addEventListener("click", (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (link) openFoldFor(link.hash);
});
window.addEventListener("hashchange", () => openFoldFor(location.hash));

initZonePage()
  .then(() => openFoldFor(location.hash))
  .catch((error) => showError(document.getElementById("zone"), error));
