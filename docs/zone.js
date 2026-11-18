// Detail page for one zone: zone.html?id=CG or zone.html?id=PD%20461
import {
  PERMISSIONS,
  escapeHtml,
  evidenceLink,
  externalLink,
  formatValue,
  getZone,
  loadSiteData,
  placeTypeInfo,
  showError,
  zonePageUrl,
  zoneTitle,
} from "./data.js";

const reviewNote = (text) =>
  text ? `<p class="muted note">? ${escapeHtml(text)}</p>` : "";

function renderHeading(zone) {
  const purpose = zone.purpose ? `<p>${escapeHtml(zone.purpose)}</p>` : "";
  return `<h1>${escapeHtml(zoneTitle(zone))}</h1>${purpose}`;
}

/** Base district, place types, sources, SUPs, and PD size. */
function renderFacts(zone, base) {
  const rows = [];
  if (zone.base) {
    const name = base.districts[zone.base]?.name || "";
    rows.push([
      "Base district",
      `<a href="${zonePageUrl(zone.base)}">${escapeHtml(`${zone.base} · ${name}`)}</a>`,
    ]);
  }
  for (const name of zone.index.placeTypes) {
    const placeType = placeTypeInfo(name, base);
    if (placeType) {
      const definition = `<br><span class="muted">${escapeHtml(placeType.definition)}</span>`;
      rows.push([
        "Place type",
        externalLink({ label: name, url: placeType.url }) + definition,
      ]);
    }
  }
  rows.push(["Source", zone.sources.map(externalLink).join(" · ")]);
  if (zone.index.specialUsePermits.length) {
    rows.push([
      "Special use permit",
      escapeHtml(zone.index.specialUsePermits.join(", ")),
    ]);
  }
  if (zone.kind === "pd") rows.push(["Area", `${zone.index.acres} acres`]);
  return `<dl>${rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("")}</dl>`;
}

/** What a PD changes from its base district, plus uses with no UDC match, notes, and review items. */
function renderPdRules(zone, base) {
  const pd = zone.pdData;
  if (!pd) return "";
  const items = [];
  if (pd.base) {
    // Without a base, the PD's uses and dimensions already appear in the sections below.
    for (const use of pd.uses) {
      const change =
        use.permission === "none"
          ? "Removes"
          : PERMISSIONS[use.permission].mark;
      items.push(
        `${change} ${escapeHtml(use.name)} ${evidenceLink(use, zone, base)}`,
      );
    }
    for (const [field, dimension] of Object.entries(pd.dimensions)) {
      const { label, unit } = base.dimensionFields[field];
      const baseValue = base.districts[pd.base]?.dimensions[field];
      const was = baseValue
        ? ` (base ${formatValue(baseValue.value, unit)})`
        : "";
      items.push(
        `${label}: ${escapeHtml(formatValue(dimension.value, unit) + was)} ${evidenceLink(dimension, zone, base)}`,
      );
    }
  }
  for (const use of pd.otherUses) {
    const mark = use.permission ? `${PERMISSIONS[use.permission].mark} ` : "";
    items.push(
      `${mark}${escapeHtml(use.text)} ${evidenceLink(use, zone, base)}`,
    );
  }
  const reviewItems = Object.entries(pd.review)
    .filter(([key]) => !(key in pd.dimensions)) // dimension notes show next to their value
    .map(([, text]) => reviewNote(text));
  const heading = pd.base ? "Changes from base" : "Other uses and rules";
  const list = items.length
    ? `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`
    : "";
  const notes = pd.notes ? `<p class="muted">${escapeHtml(pd.notes)}</p>` : "";
  return `<h2>${heading}</h2>${list}${notes}${reviewItems.join("")}`;
}

function renderUses(zone, base) {
  if (zone.legacyUses) {
    const items = zone.legacyUses
      .map((use) => `<li>${escapeHtml(use)}</li>`)
      .join("");
    return `<h2>Allowed uses</h2><ul>${items}</ul>${reviewNote(zone.review.legacyUses)}`;
  }
  if (!zone.uses) return "";
  const byCategory = new Map();
  for (const use of base.uses) {
    const permission = zone.uses[use.name];
    if (!permission) continue;
    const { mark, className } = PERMISSIONS[permission];
    const standard = use.standard
      ? ` <span class="muted">§${use.standard}</span>`
      : "";
    const pdSource = zone.pdData?.uses.find((pdUse) => pdUse.name === use.name);
    const line = `<li><span class="${className}">${mark}</span> ${escapeHtml(use.name)}${standard} ${evidenceLink(pdSource, zone, base)}</li>`;
    if (!byCategory.has(use.category)) byCategory.set(use.category, []);
    byCategory.get(use.category).push(line);
  }
  const notAllowed = base.uses.length - Object.keys(zone.uses).length;
  const legend = Object.values(PERMISSIONS)
    .filter((permission) => permission.className !== "not-allowed")
    .map((permission) => `${permission.mark} ${permission.label.toLowerCase()}`)
    .join(" · ");
  const groups = [...byCategory].map(
    ([category, lines]) =>
      `<h3>${escapeHtml(category)}</h3><ul class="uses">${lines.join("")}</ul>`,
  );
  return (
    `<h2>Allowed uses</h2><p class="muted">${legend}</p>${groups.join("")}` +
    `<p class="muted">${notAllowed} other uses not allowed.</p>${reviewNote(zone.review.uses)}`
  );
}

function renderDimensions(zone, base) {
  const entries = Object.entries(zone.dimensions);
  if (!entries.length) return reviewNote(zone.review.dimensions);
  const rows = entries.map(([field, dimension]) => {
    const { label, unit } = base.dimensionFields[field];
    const value =
      escapeHtml(formatValue(dimension.value, unit)) +
      reviewNote(zone.review[field]);
    return `<tr><th>${label}</th><td>${value}</td><td>${evidenceLink(dimension, zone, base)}</td></tr>`;
  });
  return `<h2>Dimensions</h2><table>${rows.join("")}</table>`;
}

async function initZonePage() {
  const page = document.getElementById("zone");
  const zoneId = new URLSearchParams(location.search).get("id");
  const zone = zoneId && (await getZone(zoneId));
  if (!zone) {
    page.innerHTML = "<h1>Zone not found</h1>";
    return;
  }
  const { base } = await loadSiteData();
  document.title = `${zone.id} · Addison Zoning`;
  page.innerHTML = [
    renderHeading(zone),
    renderFacts(zone, base),
    renderPdRules(zone, base),
    renderUses(zone, base),
    renderDimensions(zone, base),
  ].join("");
}

initZonePage().catch((error) =>
  showError(document.getElementById("zone"), error),
);
