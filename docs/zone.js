// Detail page for one zone: zone.html?id=CG or zone.html?id=PD%20461
import {
  PERMISSIONS,
  planPermission,
  escapeHtml,
  evidenceLink,
  externalLink,
  formatValue,
  getZoneData,
  zoneRules,
  loadJson,
  idWithName,
  loadSiteData,
  showError,
  zoneTitle,
} from "./data.js";

/** `offset` leaves numbers free for notes that are already using them (the UDC table's own notes) */
function createNotes(offset = 0) {
  const texts = [];
  return {
    /** Returns the number to put next to the item, or "" when there is no note */
    getFootnoteNumber(text) {
      if (!text) return "";
      if (!texts.includes(text)) texts.push(text);
      const noteNumber = offset + texts.indexOf(text) + 1;
      return `<sup>${noteNumber}</sup>`;
    },
    render() {
      return texts
        .map(
          (text, index) =>
            `<p class="muted note">
              <sup>${offset + index + 1}</sup> ${escapeHtml(text)}
            </p>`,
        )
        .join("");
    },
  };
}

const tableOf = (rows) =>
  `<div class="table-wrap"><table>${rows.filter(Boolean).join("")}</table></div>`;

function renderHeading(zoneData) {
  // Purposes are exact quotes from the UDC or the PD ordinance
  const purpose = zoneData.purpose
    ? `<p>“${escapeHtml(zoneData.purpose)}”</p>`
    : "";
  return `<h1>${escapeHtml(zoneTitle(zoneData))}</h1>${purpose}`;
}

function renderFacts(zoneData, base) {
  const rows = [];
  if (zoneData.base) {
    const name = base.districts[zoneData.base]?.name || "";
    const title = idWithName(zoneData.base, name);
    const link = `<a href="zone.html?id=${encodeURIComponent(zoneData.base)}">
        ${escapeHtml(title)}
      </a>`;
    rows.push(["Base district", link]);
  }
  rows.push(["Source", zoneData.sources.map(externalLink).join(", ")]);
  // The ordinance's acreage, when its boundary includes the roads
  const acresWithRoads = zoneData.pdData?.acresWithRoads;
  const withRoads = acresWithRoads
    ? ` (${acresWithRoads.toFixed(1)} including roads)`
    : "";
  if (zoneData.kind === "pd")
    rows.push(["Area", `${zoneData.zone.acres} acres${withRoads}`]);
  return `<dl>${rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("")}</dl>`;
}

/** A value split by area, lot type, or street type is an object of parts; a number, "none", range or either-or is one value */
const partsOf = (value) =>
  typeof value === "object" && !("min" in value) && !("options" in value)
    ? Object.keys(value)
    : [];

/** True when some dimensions are split by part and others are not, so the single-value table needs an "All" header */
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
  { zoneData, base, footnoteFor, footnoteForPart, baseDimensions, labelSingle },
) {
  const parts = partsOf(group[0][1].value);
  const header = parts.length
    ? `<tr class="head"><th></th>${parts.map((part) => `<th>${escapeHtml(part)}</th>`).join("")}<th></th></tr>`
    : labelSingle
      ? `<tr class="head"><th></th><th>All</th><th></th></tr>`
      : "";
  const rows = group.map(([field, dimension]) => {
    const { label, unit } = base.dimensionFields[field];
    const footnote = footnoteFor ? footnoteFor(field) : "";
    const source = `<td class="source">${evidenceLink(dimension, zoneData, base)}</td>`;
    // Height in feet and height in stories are compared with each other
    const baseField = baseDimensions?.[field] ? field : SAME_QUANTITY[field];
    // A base with no value reads as "None"
    const baseValue = baseDimensions
      ? (baseDimensions[baseField]?.value ?? "none")
      : undefined;
    const baseUnit = base.dimensionFields[baseField]?.unit;
    const cell = (value, cellFootnote = "") =>
      `<td>${changeText(baseValue, value, unit, baseUnit)}${cellFootnote}</td>`;
    return parts.length
      ? `<tr><th>${escapeHtml(label)}${footnote}</th>${parts
          .map((part) =>
            cell(dimension.value[part], footnoteForPart?.(field, part)),
          )
          .join("")}${source}</tr>`
      : `<tr><th>${escapeHtml(label)}</th>${cell(dimension.value, footnote)}${source}</tr>`;
  });
  return tableOf([header, ...rows]);
}

/** Dimension fields that measure the same thing in different units, so a change can be shown from one to the other */
const SAME_QUANTITY = {
  heightMax: "heightMaxStories",
  heightMaxStories: "heightMax",
};

/**
 * "16,000 → 5,750 sq ft": the base value, an arrow, then the new value, with the unit once at the end.
 * A base that is itself split or not a plain number keeps its own unit. With no base value, just the new value.
 */
function changeText(baseValue, newValue, unit, baseUnit) {
  const to = escapeHtml(formatValue(newValue, unit));
  if (baseValue === undefined) return to;
  const formattedUnit =
    typeof baseValue === "number" && baseUnit === unit ? "" : baseUnit;
  const from = escapeHtml(formatValue(baseValue, formattedUnit));
  return `<span class="before">${from} →</span> ${to}`;
}

/** Uses a PD adds or changes, or other uses it lists */
function useRows(pd, zoneData, base) {
  // A PD that lists all its own uses (pdUsesOnly) shows them once, under Allowed uses
  const listed = pd.pdUsesOnly
    ? []
    : pd.uses.map((use) => ({ text: use.name, ...use }));
  // Several UDC uses can come from one ordinance phrase (`text`), which is shown once
  const seen = new Set();
  return listed
    .filter((use) => {
      const key = `${use.text}|${use.permission ?? "P"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((use) => {
      const after = PERMISSIONS[planPermission(pd, use.permission ?? "P")];
      const notAllowed = (title, className = "before") =>
        `<span class="${className} mark" title="${title}">✕</span>`;
      const afterMark =
        after === PERMISSIONS.none
          ? notAllowed(after.label, "denied")
          : `<span class="${after.className} mark" title="${after.label}">${after.mark}</span>`;
      let permission = afterMark;
      if (pd.base) {
        // "Before → after": the base district's mark for this use (a use with no UDC name was not allowed there)
        const baseCode = base.districts[pd.base]?.uses[use.name] ?? "none";
        const before = PERMISSIONS[baseCode];
        const beforeMark =
          before === PERMISSIONS.none
            ? notAllowed(`${before.label} in ${escapeHtml(pd.base)}`)
            : `<span class="before mark" title="${before.label} in ${escapeHtml(pd.base)}">${before.mark}</span>`;
        permission = `<span role="img" aria-label="${before.label} in ${escapeHtml(pd.base)}, now ${after.label.toLowerCase()}">${beforeMark} → ${afterMark}</span>`;
      }
      return `<tr><td>${escapeHtml(use.text)}</td><td class="nowrap">${permission}</td><td class="source">${evidenceLink(use, zoneData, base)}</td></tr>`;
    });
}

/** What a PD changes from its base district, plus uses with no UDC match, notes, and other review items */
function renderPdRules(zoneData, base) {
  const pd = zoneData.pdData;
  if (!pd) return "";
  const rows = useRows(pd, zoneData, base);
  const useTable = rows.length
    ? tableOf([
        `<tr class="head"><th>Use</th><th class="nowrap">${pd.base ? "Before → after" : "Permission"}</th><th></th></tr>`,
        ...rows,
      ])
    : "";
  // Without a base, the PD's dimensions already appear under Dimensions
  const changed = pd.base ? Object.entries(pd.dimensions) : [];
  const baseDimensions = base.districts[pd.base]?.dimensions || {};
  const changedGroups = groupBySplit(changed);
  const labelSingle = hasSplitAndSingle(changedGroups);
  const dimensionTables = changedGroups.map((group) =>
    dimensionTable(group, { zoneData, base, baseDimensions, labelSingle }),
  );
  if (!useTable && !dimensionTables.length) return "";
  const heading = pd.base ? "Changes from base" : "Other uses and rules";
  return `<h2>${heading}</h2>${useTable}${dimensionTables.join("")}`;
}

/** A PD's ordinances, oldest first. A PD's data file can give a shorter description than the town map's. */
function renderHistory(zoneData) {
  if (zoneData.kind !== "pd" || !zoneData.ordinances.length) return "";
  const rows = zoneData.ordinances.map((ordinance) => {
    const description =
      zoneData.pdData?.history?.[ordinance.id] ?? ordinance.description;
    const link = externalLink({
      label: `Ord. ${ordinance.id}`,
      url: ordinance.url,
    });
    return `<tr><td>${ordinance.date?.slice(0, 4) ?? ""}</td><td>${escapeHtml(description)}</td><td class="source">${link}</td></tr>`;
  });
  return `<h2>History</h2>${tableOf(rows)}`;
}

function renderCurtisNotes(zoneData) {
  const text = zoneData.pdData?.curtisNotes;
  return text ? `<h2>Curtis's notes</h2><p>${escapeHtml(text)}</p>` : "";
}

/** A PD's own parking ratios, one row per use */
function renderParking(zoneData, rules, base) {
  const rows = zoneData.pdData?.parking || [];
  if (!rows.length) return "";
  const body = rows.map(
    (row) =>
      `<tr><td>${escapeHtml(row.use)}</td><td>${escapeHtml(row.requirement)}</td><td class="source">${evidenceLink(row, zoneData, base)}</td></tr>`,
  );
  // A review note under the key "parking" is a footnote on the table's heading
  const notes = createNotes();
  const heading = `Parking${notes.getFootnoteNumber(rules.review.parking)}`;
  return `<h2>${heading}</h2>${tableOf([`<tr class="head"><th>Use</th><th>Spaces required</th><th></th></tr>`, ...body])}${notes.render()}`;
}

/** A PD's general conditions from the ordinance, one per line */
function renderNotes(zoneData) {
  const items = zoneData.pdData?.notes || [];
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

/** A use-specific standard from UDC Article 4, as a closed fold */
function renderStandard({ id, standard, items, district, base }) {
  const udcLink = externalLink({
    label: `UDC page ${standard.page}`,
    url: `${base.sources.udc.url}#page=${standard.page}`,
  });
  return `<details class="standard-fold" id="${standardAnchor(id)}"><summary>§${id} ${escapeHtml(standard.title)}</summary><p class="muted">${udcLink}</p>${renderStandardItems(items, district)}</details>`;
}

function renderUses(zoneData, rules, base, standards) {
  const notes = createNotes();
  if (rules.legacyUses) {
    const heading = `Allowed uses${notes.getFootnoteNumber(rules.review.legacyUses)}`;
    const items = rules.legacyUses
      .map((use) => `<li>${escapeHtml(use)}</li>`)
      .join("");
    return `<h2>${heading}</h2><ul>${items}</ul>${notes.render()}`;
  }
  if (!rules.uses) return "";
  const district = zoneData.kind === "pd" ? zoneData.base : zoneData.zoneId;
  // A PD with no base district has its own rules, so the UDC's use standards are not shown
  const showStandards = Boolean(district);
  // A PD that builds on a base district shows that district's uses plus its own changes
  const fromBase =
    zoneData.kind === "pd" && zoneData.base && !zoneData.pdData?.pdUsesOnly
      ? ` (From base ${escapeHtml(zoneData.base)})`
      : "";
  const heading = `Allowed uses${fromBase}${notes.getFootnoteNumber(rules.review.uses)}`;
  const byCategory = new Map();
  const applicableStandards = new Map();
  for (const use of base.uses) {
    const permission = rules.uses[use.name];
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
    const pdSource = zoneData.pdData?.uses.find(
      (pdUse) => pdUse.name === use.name,
    );
    const line = `<li><span class="${className}">${mark}</span> ${escapeHtml(use.name)}${standardLink} ${evidenceLink(pdSource, zoneData, base)}</li>`;
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
  // The asterisk on a use's check mark (P*) points to this line
  const planNote = zoneData.pdData?.mustFollowPlan
    ? '<p class="muted">*Must follow development plan exactly</p>'
    : "";
  // A PD that lists all its own uses shows the ones with no UDC name as a last group
  const ordinanceOnlyUses = zoneData.pdData?.pdUsesOnly
    ? zoneData.pdData.uses.filter((use) => !use.name)
    : [];
  if (ordinanceOnlyUses.length)
    for (const use of ordinanceOnlyUses) {
      const { mark, className } =
        PERMISSIONS[planPermission(zoneData.pdData, use.permission ?? "P")];
      // With no base district and no group named, the uses need no sub-heading under "Allowed uses"
      const category = use.group ?? (zoneData.base ? "Other uses" : "");
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory
        .get(category)
        .push(
          `<li><span class="${className}">${mark}</span> ${escapeHtml(use.text)} ${evidenceLink(use, zoneData, base)}</li>`,
        );
    }
  const groups = [...byCategory].map(
    ([category, lines]) =>
      `${category ? `<h3>${escapeHtml(category)}</h3>` : ""}<ul class="uses">${lines.join("")}</ul>`,
  );
  // No uses to list and no note about them: leave the whole section out
  if (!groups.length && !rules.review.uses) return "";
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

/** The table's own notes keep the UDC's numbers, so AA's "Minimum of 10 feet" note is 1, as in the table */
function renderDimensions(zoneData, rules, base) {
  const entries = Object.entries(rules.dimensions);
  const shownNumbers = new Set(Object.values(rules.noteRefs).flat());
  const notes = createNotes(Math.max(0, ...shownNumbers)); // other notes continue after the UDC's numbers
  // A dimension's own `note` marks its row, and `partNotes` marks one column of it
  const footnoteFor = (key) =>
    (rules.noteRefs[key] ? `<sup>${rules.noteRefs[key].join(",")}</sup>` : "") +
    notes.getFootnoteNumber(rules.review[key]) +
    notes.getFootnoteNumber(rules.dimensions[key]?.note);
  const footnoteForPart = (key, part) =>
    notes.getFootnoteNumber(rules.dimensions[key]?.partNotes?.[part]);
  const heading = `Dimensions${footnoteFor("dimensions")}`;
  const udcNotes = [...shownNumbers]
    .sort((a, b) => a - b)
    .map(
      (number) =>
        `<p class="muted note"><sup>${number}</sup> “${escapeHtml(rules.tableNotes[number])}”</p>`,
    )
    .join("");
  if (!entries.length) {
    const rendered = udcNotes + notes.render();
    return rendered ? `<h2>${heading}</h2>${rendered}` : "";
  }
  const groups = groupBySplit(entries);
  const labelSingle = hasSplitAndSingle(groups);
  const tables = groups.map((group) =>
    dimensionTable(group, {
      zoneData,
      base,
      footnoteFor,
      footnoteForPart,
      labelSingle,
    }),
  );
  return `<h2>${heading}</h2>${tables.join("")}${udcNotes}${notes.render()}`;
}

async function initZonePage() {
  const page = document.getElementById("zone");
  const zoneId = new URLSearchParams(location.search).get("id");
  const zoneData = zoneId && (await getZoneData(zoneId));
  if (!zoneData) {
    page.innerHTML = "<h1>Zone not found</h1>";
    return;
  }
  const rules = zoneRules(zoneData);
  const [{ base }, standards] = await Promise.all([
    loadSiteData(),
    loadJson("data/standards.json"),
  ]);
  document.title = zoneTitle(zoneData);
  page.innerHTML = [
    renderHeading(zoneData),
    renderFacts(zoneData, base),
    renderCurtisNotes(zoneData),
    renderPdRules(zoneData, base),
    renderUses(zoneData, rules, base, standards),
    renderDimensions(zoneData, rules, base),
    renderParking(zoneData, rules, base),
    renderNotes(zoneData),
    renderHistory(zoneData),
  ].join("");
}

/** Opens every fold around the element a #link points to, then scrolls to it */
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
