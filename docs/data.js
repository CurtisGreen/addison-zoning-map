// Loads the data files and turns a zone id into one zone object, for districts and planned developments (PDs) alike

/** Permission codes from UDC Table 4.2-1, plus "D" (a PD use that needs development plan approval) and "none" for a use a PD removes */
export const PERMISSIONS = {
  P: { mark: "✓", label: "By right", className: "allowed" },
  S: { mark: "S", label: "Special use permit", className: "permit" },
  A: { mark: "A", label: "Accessory", className: "accessory" },
  T: { mark: "T", label: "Temporary", className: "accessory" },
  D: { mark: "D", label: "Development plan approval", className: "permit" },
  none: { mark: "—", label: "Not allowed", className: "not-allowed" },
  // By right, but only as the PD's development plan shows it. Explained by a "*Must follow development plan exactly" line, not the legend.
  "P*": {
    mark: "✓*",
    label: "By right, as shown on the development plan",
    className: "allowed",
    inLegend: false,
  },
};

/**
 * A PD with `mustFollowPlan` must be built exactly as its development plan shows, so a use allowed by right (P)
 * is shown as P* (a check mark and an asterisk). D stays for a use that needs a change to the plan.
 */
export function planPermission(pdData, code) {
  return pdData?.mustFollowPlan && code === "P" ? "P*" : code;
}

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

/** A district's family. A PD uses its own family if it has one, else its base district's, else "planned". */
export function familyOf(zoneId, zoneIndex) {
  const entry = zoneIndex.zones[zoneId];
  if (entry?.family) return entry.family;
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

/** base.json (UDC rules) and zones.json (zones on the map), loaded once per page */
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

// "R-2: Residential 2", or just the id when there is no name
export const idWithName = (id, name) => (name ? `${id}: ${name}` : id);

// "CG: Commercial General" or "PD 461: Midway Meadows"
export function zoneLabel(zoneId, { base, zoneIndex }) {
  const name = base.districts[zoneId]?.name || zoneIndex.zones[zoneId]?.name;
  return idWithName(zoneId, name);
}

/** "PD 461" + "Midway Meadows" -> data/pd/PD-461-Midway-Meadows.json; a PD with no name uses just the id */
function pdFilePath(zoneId, name) {
  const id = zoneId.replace("?", "").replaceAll(" ", "-");
  const label = (name || "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `data/pd/${label ? `${id}-${label}` : id}.json`;
}

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
      tableNotes: {},
      noteRefs: {},
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
    tableNotes: {},
    noteRefs: {},
  };
  if (!index.done) return zone;

  const pdData = await loadJson(pdFilePath(zoneId, index.name));
  // A PD that must follow its plan allows only the uses the plan shows, not its base district's uses
  if (pdData.mustFollowPlan) pdData.pdUsesOnly = true;
  const baseDistrict = base.districts[pdData.base];
  const uses =
    pdData.pdUsesOnly || !baseDistrict ? {} : { ...baseDistrict.uses };
  // An entry with a UDC use `name` changes the base; one with only `text` is a use with no UDC match
  for (const use of pdData.uses.filter((use) => use.name)) {
    if (use.permission === "none") delete uses[use.name];
    else uses[use.name] = use.permission;
  }
  for (const name of Object.keys(uses))
    uses[name] = planPermission(pdData, uses[name]);
  // Base district notes are dropped for dimensions the PD sets itself
  const inheritedReview = Object.fromEntries(
    Object.entries(baseDistrict?.review || {}).filter(
      ([key]) => !(key in pdData.dimensions),
    ),
  );
  const inheritedNoteRefs = Object.fromEntries(
    Object.entries(baseDistrict?.noteRefs || {}).filter(
      ([key]) => !(key in pdData.dimensions),
    ),
  );
  return {
    ...zone,
    pdData,
    name: pdData.name || index.name,
    purpose: pdData.purpose,
    base: pdData.base,
    uses,
    dimensions: { ...baseDistrict?.dimensions, ...pdData.dimensions },
    review: { ...inheritedReview, ...pdData.sectionNotes },
    tableNotes: baseDistrict?.tableNotes || {},
    noteRefs: inheritedNoteRefs,
  };
}

export const zoneTitle = (zone) => idWithName(zone.id, zone.name);

/** The source to show in a popup: the UDC section, the PD's one ordinance, or the count when a PD has several */
export function sourceHtml(zone) {
  if (zone.kind === "district") return externalLink(zone.sources[0]);
  const ordinances = zone.index.ordinances;
  if (ordinances.length > 1) return `${ordinances.length} ordinances`;
  const [only] = ordinances;
  return only ? externalLink({ label: `Ord. ${only.id}`, url: only.url }) : "";
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);

const EXTERNAL_LINK_ICON = `<img class="external-icon" src="external-link.svg" alt="" />`;

export function externalLink({ label, url }) {
  if (!url) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)} ${EXTERNAL_LINK_ICON}</a>`;
}

// Link to the PDF page a value came from: the PD ordinance it cites, else the UDC
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

const getUnitSuffix = (unit) => {
  if (!unit) return "";
  // No space for %
  if (unit === "%") return "%";
  return " " + unit;
};

// , {Interior: 5, Street: 20} -> "Interior 5 ft, Street 20 ft" */
export function formatValue(value, unit) {
  const suffix = getUnitSuffix(unit);
  if (value === "none") return "None";
  // 70 -> 70 ft
  if (typeof value === "number") return value.toLocaleString() + suffix;
  // { min: 5, max: 15 } -> 5–15 ft
  if ("min" in value)
    return `${value.min.toLocaleString()}–${value.max.toLocaleString()}${suffix}`;
  // { options: [10, 20] } -> 10 or 20 ft
  if ("options" in value)
    return value.options.map((n) => n.toLocaleString()).join(" or ") + suffix;
  // { Interior: 5, Street: 20 } -> Interior 5 ft, Street 20 ft
  return Object.entries(value)
    .map(([part, partValue]) => `${part} ${formatValue(partValue, unit)}`)
    .join(", ");
}
