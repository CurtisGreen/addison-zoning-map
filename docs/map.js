// Map page: zoning polygons, hover names, click popups, legend, and the zone list.
import {
  FAMILIES,
  PERMISSIONS,
  escapeHtml,
  externalLink,
  familyOf,
  getZone,
  loadJson,
  loadSiteData,
  mainSource,
  showError,
  summarizeValue,
  zoneLabel,
  zonePageUrl,
  zoneTitle,
} from "./data.js";

// Leaflet map library. index.html loads it with a <script> tag (with an integrity check), which sets window.L.
const Leaflet = window.L;

/** The same six uses in every popup, so zones compare at a glance. */
const HEADLINE_USES = [
  { label: "Home", use: "Dwelling, single-family (detached)" },
  { label: "Apts", use: "Dwelling, multifamily" },
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

function renderHeadlineUses(zone) {
  const cells = HEADLINE_USES.map(({ label, use }) => {
    const permission = PERMISSIONS[zone.uses[use] || "none"];
    return `<span class="${permission.className}">${label} ${permission.mark}</span>`;
  });
  return `<div class="headline-uses">${cells.join("")}</div>`;
}

function renderKeyLimits(zone, dimensionFields) {
  const limits = POPUP_LIMITS.map(({ label, fields }) => {
    const field = fields.find((name) => zone.dimensions[name]);
    if (!field) return null;
    return `${label} ${summarizeValue(zone.dimensions[field].value, dimensionFields[field].unit)}`;
  }).filter(Boolean);
  return limits.length ? `<div>${limits.join(" · ")}</div>` : "";
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
  const source = mainSource(zone);
  parts.push(
    `<div class="links"><a href="${zonePageUrl(zone.id)}">Details →</a> ${source ? externalLink(source) : ""}</div>`,
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
  const map = Leaflet.map("map", { zoomSnap: 0.25, preferCanvas: true }); // canvas keeps hover smooth with hundreds of polygons
  Leaflet.tileLayer(TILES, { maxZoom: 19, attribution: TILE_CREDIT }).addTo(
    map,
  );

  const polygonsByZone = new Map(); // zone id -> all of its polygons, so hover lights them all
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
