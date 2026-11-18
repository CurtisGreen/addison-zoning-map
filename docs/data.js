// Shared by map.js (map page) and zone.js (detail page).
// Loads the data files and turns any zone id into one zone object with the same shape
// for regular districts and planned developments (PDs).

/** Permission codes from UDC Table 4.2-1, plus "none" for a use a PD removes. */
export const PERMISSIONS = {
  P: { mark: "✓", label: "By right", className: "allowed" },
  S: { mark: "S", label: "Special use permit", className: "permit" },
  A: { mark: "A", label: "Accessory", className: "accessory" },
  T: { mark: "T", label: "Temporary", className: "accessory" },
  none: { mark: "—", label: "Not allowed", className: "not-allowed" },
};

/** Map colors by district family. */
export const FAMILIES = {
  residential: { label: "Residential", color: "#f2c744" },
  mixed: { label: "Mixed use", color: "#f08c3a" },
  commercial: { label: "Commercial", color: "#d9443a" },
  industrial: { label: "Industrial", color: "#8a4fc7" },
  airport: { label: "Airport", color: "#8c959f" },
  planned: { label: "Planned dev.", color: "#3a9e9a" },
};

const DISTRICT_FAMILY = {
  "R-1": "residential",
  "R-2": "residential",
  "R-3": "residential",
  A: "residential",
  "PD-TH": "residential",
  "PD-CC": "residential",
  "M-1": "mixed",
  "M-2": "mixed",
  "M-3": "mixed",
  "M-4": "mixed",
  CL: "commercial",
  CG: "commercial",
  LI: "industrial",
  AA: "airport",
};

/** A district's family, or a PD's base district family once known, else "planned". */
export function familyOf(zoneId, zoneIndex) {
  const entry = zoneIndex.zones[zoneId];
  const district = entry?.kind === "pd" ? entry.base : zoneId;
  return DISTRICT_FAMILY[district] || "planned";
}

export async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok)
    throw new Error(`Couldn't load ${path} (HTTP ${response.status})`);
  return response.json();
}

let siteData;

/** base.json (UDC rules) and zones.json (zones on the map), loaded once per page. */
export function loadSiteData() {
  siteData ||= Promise.all([
    loadJson("data/base.json"),
    loadJson("data/zones.json"),
  ]).then(([base, zoneIndex]) => ({
    base,
    zoneIndex,
    useByName: new Map(base.uses.map((use) => [use.name, use])),
  }));
  return siteData;
}

export function showError(element, error) {
  console.error(error);
  element.innerHTML = `<p class="error">Couldn't load data. Try reloading the page.</p>`;
}

/** "CG · Commercial General" or "PD 007-034 · Brookhaven Village". */
export function zoneLabel(zoneId, { base, zoneIndex }) {
  const name = base.districts[zoneId]?.name || zoneIndex.zones[zoneId]?.name;
  return name ? `${zoneId} · ${name}` : zoneId;
}

export const zonePageUrl = (zoneId) =>
  `zone.html?id=${encodeURIComponent(zoneId)}`;

const pdFilePath = (zoneId) =>
  `data/pd/${zoneId.replace("?", "").replaceAll(" ", "-")}.json`;

/**
 * Everything known about one zone:
 * { id, kind, name, purpose, base, uses: {useName: permission}, legacyUses, dimensions, review, sources, index, pdData }
 * A PD starts from its base district. Anything the PD doesn't change falls back to the base
 * (UDC §3.7.3.C and §3.7.4.D). A PD with no data yet has only its index entry and ordinance links.
 */
export async function getZone(zoneId) {
  const { base, zoneIndex } = await loadSiteData();
  const index = zoneIndex.zones[zoneId] || {
    placeTypes: [],
    specialUsePermits: [],
  };
  const district = base.districts[zoneId];
  if (district) {
    const udcLink = {
      label: `UDC §${district.section}`,
      url: `${base.sources.udc.url}#page=${district.page}`,
    };
    return {
      id: zoneId,
      kind: "district",
      review: {},
      ...district,
      index,
      sources: [udcLink],
    };
  }
  if (index.kind !== "pd") return null;

  const sources = index.ordinances.map((ordinance) => ({
    label: `Ord. ${ordinance.id}`,
    url: ordinance.url,
  }));
  const zone = {
    id: zoneId,
    kind: "pd",
    name: index.name,
    index,
    sources,
    uses: null,
    dimensions: {},
    review: {},
  };
  if (!index.done) return zone;

  const pdData = await loadJson(pdFilePath(zoneId));
  const baseDistrict = base.districts[pdData.base];
  const uses = pdData.usesOnly || !baseDistrict ? {} : { ...baseDistrict.uses };
  for (const use of pdData.uses) {
    if (use.permission === "none") delete uses[use.name];
    else uses[use.name] = use.permission;
  }
  return {
    ...zone,
    pdData,
    name: pdData.name || index.name,
    purpose: pdData.purpose,
    base: pdData.base,
    uses,
    dimensions: { ...baseDistrict?.dimensions, ...pdData.dimensions },
    review: { ...baseDistrict?.review, ...pdData.review },
  };
}

export const zoneTitle = (zone) =>
  [zone.id, zone.name].filter(Boolean).join(" · ");

/** The one source to show in a popup: the UDC section, or the PD's own ordinance (latest if unknown). */
export function mainSource(zone) {
  if (zone.kind === "district") return zone.sources[0];
  const ordinances = zone.index.ordinances;
  const main =
    ordinances.find((ordinance) => ordinance.id === zone.index.mainOrdinance) ||
    ordinances.at(-1);
  return main && { label: `Ord. ${main.id}`, url: main.url };
}

export function placeTypeInfo(name, base) {
  const placeType = base.placeTypes[name];
  return (
    placeType && {
      name,
      ...placeType,
      url: `${base.sources.plan.url}#page=${placeType.page}`,
    }
  );
}

// ---------- formatting ----------

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);

export function externalLink({ label, url }) {
  if (!url) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)} ↗</a>`;
}

/** Link to the PDF page a value came from: the PD ordinance it cites, else the UDC. */
export function evidenceLink(evidence, zone, base) {
  if (!evidence?.page) return "";
  const label = `p. ${evidence.page}`;
  if (evidence.ordinance) {
    const ordinance = zone.index.ordinances.find(
      (o) => o.id === evidence.ordinance,
    );
    return externalLink({
      label,
      url: ordinance?.url && `${ordinance.url}#page=${evidence.page}`,
    });
  }
  return externalLink({
    label,
    url: `${base.sources.udc.url}#page=${evidence.page}`,
  });
}

function withUnit(text, unit) {
  if (!unit) return text;
  return unit === "%" ? `${text}%` : `${text} ${unit}`;
}

/** 70 -> "70 ft", "none" -> "None", "5-15" -> "5–15 ft", {Interior: 5, Street: 20} -> "Interior 5 ft · Street 20 ft". */
export function formatValue(value, unit) {
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([part, partValue]) => `${part} ${formatValue(partValue, unit)}`)
      .join(" · ");
  }
  if (value === "none") return "None";
  if (typeof value === "number") return withUnit(value.toLocaleString(), unit);
  return withUnit(String(value).replace("-", "–"), unit);
}

/** Numbers inside a value: 30 -> [30], "5-15" -> [5, 15], "15 or 20" -> [15, 20]. */
function numbersIn(value) {
  if (typeof value === "number") return [value];
  return String(value)
    .split(/[^\d.]+/)
    .filter(Boolean)
    .map(Number);
}

/** One short value for the popup. Values that differ by street or building type become a range. */
export function summarizeValue(value, unit) {
  if (!value || typeof value !== "object") return formatValue(value, unit);
  const parts = Object.values(value);
  if (parts.every((part) => part === "none")) return "None";
  if (parts.includes("none")) return "varies";
  const numbers = parts.flatMap(numbersIn);
  const lowest = Math.min(...numbers);
  const highest = Math.max(...numbers);
  return formatValue(
    lowest === highest ? lowest : `${lowest}-${highest}`,
    unit,
  );
}
