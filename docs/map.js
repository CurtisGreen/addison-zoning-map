// Map page: zoning polygons, hover names, click popups, legend, and the zone list.
import {
  FAMILIES,
  PERMISSIONS,
  escapeHtml,
  familyOf,
  getZone,
  loadJson,
  loadSiteData,
  sourceHtml,
  showError,
  summarizeValue,
  zoneLabel,
  zonePageUrl,
  zoneTitle,
} from "./data.js";

// Leaflet, loaded by index.html as window.L.
const Leaflet = window.L;

/** Building sizes for the Residential line: units per building, and the UDC use that allows them. */
const ADU_USE = "Dwelling, accessory (ADU)";
const DWELLING_SIZES = [
  { units: "1", use: "Dwelling, single-family (detached)" },
  { units: "2", use: "Dwelling, duplex" },
  { units: "3", use: "Dwelling, triplex" },
  { units: "4", use: "Dwelling, fourplex" },
  { units: "5+", use: "Dwelling, multifamily" },
];

/** The same uses in every popup, so zones compare at a glance. */
const HEADLINE_USES = [
  { label: "Retail", use: "Retail sales, less than 15,000 sq. ft. GFA" },
  { label: "Restaurant", use: "Restaurant" },
  { label: "Office", use: "Office" },
  { label: "Industry", use: "Manufacturing, low-impact" },
];

/** Popup limits: label and the dimension fields to try, in order. */
const POPUP_LIMITS = [
  { label: "Height", fields: ["heightMax", "heightMaxStories"] },
  { label: "Front", fields: ["frontSetbackMin"] },
  { label: "Build-to", fields: ["buildTo"] },
];

const NORMAL_OPACITY = 0.5;
const HOVER_OPACITY = 0.8;
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_CREDIT =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/** PDs are dashed; color comes from the district family (a PD uses its base district once known). */
function polygonStyle(zoneId, zoneIndex) {
  const isPd = zoneIndex.zones[zoneId]?.kind === "pd";
  return {
    fillColor: FAMILIES[familyOf(zoneId, zoneIndex)].color,
    fillOpacity: NORMAL_OPACITY,
    color: isPd ? "#333" : "#fff",
    weight: 1,
    dashArray: isPd ? "4 3" : null,
  };
}

/** "1–4 units": the building sizes a zone allows with one permission, or "" when there are none. */
function dwellingSizes(zone, code) {
  const indexes = DWELLING_SIZES.flatMap((size, index) =>
    zone.uses[size.use] === code ? [index] : [],
  );
  const runs = [];
  for (const index of indexes) {
    const last = runs.at(-1);
    if (last && last.to === index - 1) last.to = index;
    else runs.push({ from: index, to: index });
  }
  const sizes = runs.map(({ from, to }) =>
    from === to
      ? DWELLING_SIZES[from].units
      : `${DWELLING_SIZES[from].units}–${DWELLING_SIZES[to].units}`,
  );
  if (!sizes.length) return "";
  return `${sizes.join(", ")} ${sizes.join() === "1" ? "unit" : "units"}`;
}

/** A table: Residential, Retail, Office down the left; sizes that need a special use permit, Restaurant, Industry down the right. */
function renderHeadlineUses(zone) {
  const pair = (label, code) => {
    const { mark, className } = PERMISSIONS[code || "none"];
    return `<td class="${className}">${label}</td><td class="${className}">${mark}</td>`;
  };
  const useCell = ({ label, use }) => pair(label, zone.uses[use]);
  const [retail, restaurant, office, industry] = HEADLINE_USES;
  const allowed = dwellingSizes(zone, "P");
  const permit = dwellingSizes(zone, "S");
  const labelCode = allowed ? "P" : permit ? "S" : "none";
  // Zones with no special-permit sizes show whether an accessory dwelling ("Casita") is allowed.
  const adu = zone.uses[ADU_USE];
  const cottage =
    allowed && !permit
      ? pair("Casita", adu === "P" || adu === "A" ? "P" : adu)
      : "<td></td><td></td>";
  const sizeCell = (text, code, span = 1) =>
    `<td class="${PERMISSIONS[code].className}" colspan="${span}">${PERMISSIONS[code].mark} ${text}</td>`;
  const rows = [
    `<td class="${PERMISSIONS[labelCode].className}">Residential</td>${allowed ? sizeCell(allowed, "P") : `<td class="${PERMISSIONS.none.className}">${PERMISSIONS.none.mark}</td>`}${permit ? sizeCell(permit, "S", 2) : cottage}`,
    useCell(retail) + useCell(restaurant),
    useCell(office) + useCell(industry),
  ];
  return `<table class="headline-uses">${rows.map((row) => `<tr>${row}</tr>`).join("")}</table>`;
}

function renderKeyLimits(zone, dimensionFields) {
  const limits = POPUP_LIMITS.map(({ label, fields }) => {
    const field = fields.find((name) => zone.dimensions[name]);
    if (!field) return null;
    return `${label} ${summarizeValue(zone.dimensions[field].value, dimensionFields[field].unit)}`;
  }).filter(Boolean);
  return limits.length ? `<div>${limits.join(", ")}</div>` : "";
}

async function renderPopup(zoneId, placeTypeName) {
  const [zone, { base }] = await Promise.all([getZone(zoneId), loadSiteData()]);
  const parts = [`<b>${escapeHtml(zoneTitle(zone))}</b>`];
  if (placeTypeName)
    parts.push(`<div class="muted">${escapeHtml(placeTypeName)}</div>`);
  if (zone.uses) {
    parts.push(
      renderHeadlineUses(zone),
      renderKeyLimits(zone, base.dimensionFields),
    );
  } else {
    parts.push("<div>Rules set by ordinance</div>");
  }
  parts.push(
    `<div class="links"><a href="${zonePageUrl(zone.id)}">Details →</a> ${sourceHtml(zone)}</div>`,
  );
  return parts.join("");
}

function addLegend(map) {
  const legend = Leaflet.control({ position: "bottomleft" });
  legend.onAdd = () => {
    const box = Leaflet.DomUtil.create("div", "legend");
    box.innerHTML = Object.entries(FAMILIES)
      .map(
        ([key, family]) =>
          `<span><i class="${key}" style="background:${family.color}"></i>${family.label}</span>`,
      )
      .join("");
    return box;
  };
  legend.addTo(map);
}

function renderZoneList(data, polygonsByZone) {
  const zoneIds = Object.keys(data.zoneIndex.zones).filter((zoneId) =>
    polygonsByZone.has(zoneId),
  );
  const districts = zoneIds.filter(
    (zoneId) => data.zoneIndex.zones[zoneId].kind === "district",
  );
  const pds = zoneIds.filter(
    (zoneId) => data.zoneIndex.zones[zoneId].kind === "pd",
  );
  const listItem = (zoneId) =>
    `<li><a href="${zonePageUrl(zoneId)}">${escapeHtml(zoneLabel(zoneId, data))}</a></li>`;
  document.getElementById("zone-list").innerHTML =
    `<h3>Districts</h3><ul>${districts.map(listItem).join("")}</ul>` +
    `<h3>Planned developments</h3><ul>${pds.map(listItem).join("")}</ul>`;
}

async function initMap() {
  const data = await loadSiteData();
  const zoneShapes = await loadJson("data/zones.geojson");
  const map = Leaflet.map("map", {
    renderer: Leaflet.canvas({ padding: 0.5 }),
  });
  Leaflet.tileLayer(TILES, {
    maxZoom: 19,
    attribution: TILE_CREDIT,
    keepBuffer: 4,
    updateInterval: 100,
  }).addTo(map);

  const polygonsByZone = new Map(); // zone id -> its polygons
  const setZoneOpacity = (zoneId, opacity) =>
    polygonsByZone
      .get(zoneId)
      .forEach((polygon) => polygon.setStyle({ fillOpacity: opacity }));

  const allZones = Leaflet.geoJSON(zoneShapes, {
    style: (feature) => polygonStyle(feature.properties.zone, data.zoneIndex),
    onEachFeature: (feature, polygon) => {
      const { zone: zoneId, placeType } = feature.properties;
      if (!polygonsByZone.has(zoneId)) polygonsByZone.set(zoneId, []);
      polygonsByZone.get(zoneId).push(polygon);
      polygon.bindTooltip(zoneLabel(zoneId, data), {
        sticky: true,
        direction: "top",
      });
      polygon.on("mouseover", () => setZoneOpacity(zoneId, HOVER_OPACITY));
      polygon.on("mouseout", () => setZoneOpacity(zoneId, NORMAL_OPACITY));
      polygon.on("click", async (event) => {
        const content = await renderPopup(zoneId, placeType);
        Leaflet.popup({ maxWidth: 300 })
          .setLatLng(event.latlng)
          .setContent(content)
          .openOn(map);
      });
    },
  }).addTo(map);
  map.fitBounds(allZones.getBounds());

  addLegend(map);
  renderZoneList(data, polygonsByZone);
  document.getElementById("as-of").textContent = data.zoneIndex.asOf;
}

initMap().catch((error) => showError(document.getElementById("map"), error));
