// Map page: zoning polygons, hover names, click popups, legend, and the zone list
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
  zoneLabel,
  zonePageUrl,
  zoneTitle,
} from "./data.js";

// Leaflet, loaded by index.html as window.L
const Leaflet = window.L;

const NORMAL_OPACITY = 0.5;
const HOVER_OPACITY = 0.8;
const DOUBLE_TAP_MS = 300;
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_CREDIT =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/** PDs are dashed; color comes from the district family (a PD uses its base district once known) */
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

/**
 * A table: Residential, Retail, Hotel, Office down the left; sizes that need a special use permit, Restaurant,
 * Day care, Industry down the right. Values come from the zone's stored `popup` in zones.json, not from its uses.
 */
function renderHeadlineUses(popup) {
  const pair = (label, code) => {
    const { mark, className } = PERMISSIONS[code || "none"];
    return `<td class="${className}">${label}</td><td class="${className}">${mark}</td>`;
  };
  // A PD that must follow its development plan shows its residential sizes as P* (check mark and asterisk)
  const residentialCode = popup.residentialCode || "P";
  const labelCode = popup.residential
    ? residentialCode
    : popup.residentialPermit
      ? "S"
      : "none";
  // Zones with no special-permit sizes show whether an accessory dwelling ("ADU") is allowed
  const cottage =
    popup.residential && !popup.residentialPermit
      ? pair("ADU", popup.adu)
      : "<td></td><td></td>";
  const sizeCell = (text, code) =>
    `<td class="${PERMISSIONS[code].className}">${PERMISSIONS[code].mark} ${text}</td>`;
  const rows = [
    `<td class="${PERMISSIONS[labelCode].className}">Residential</td>${popup.residential ? sizeCell(popup.residential, residentialCode) : `<td class="${PERMISSIONS.none.className}">${PERMISSIONS.none.mark}</td>`}${popup.residentialPermit ? pair(popup.residentialPermit, "S") : cottage}`,
    pair("Retail", popup.retail) + pair("Restaurant", popup.restaurant),
    pair("Hotel", popup.hotel) + pair("Day care", popup.daycare),
    pair("Office", popup.office) + pair("Industry", popup.industry),
  ];
  return `<table class="headline-uses">${rows.map((row) => `<tr>${row}</tr>`).join("")}</table>`;
}

async function renderPopup(zoneId) {
  const zone = await getZone(zoneId);
  const popup = zone.index.popup;
  const parts = [`<b>${escapeHtml(zoneTitle(zone))}</b>`];
  if (popup) {
    parts.push(renderHeadlineUses(popup));
    if (popup.limits) parts.push(`<div>${escapeHtml(popup.limits)}</div>`);
    if (popup.mustFollowPlan)
      parts.push("<div>*Must follow development plan exactly</div>");
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

// Leaflet's own double-tap fallback needs two clicks within 200ms, which most touch users miss
function enableDoubleTapZoom(map) {
  let firstTap = null;

  map.getContainer().addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return; // Ignore 2nd finger pinch
    const now = Date.now();
    if (firstTap && firstTap.time - now >= DOUBLE_TAP_MS) {
      map.setZoomAround(firstTap.point, map.getZoom() + 1);
      firstTap = null;
    } else {
      firstTap = { time: now, point: map.mouseEventToContainerPoint(event) };
    }
  });
}

async function initMap() {
  const data = await loadSiteData();
  const zoneShapes = await loadJson("data/zones.geojson");
  const map = Leaflet.map("map", {
    renderer: Leaflet.canvas({ padding: 0.5 }),
    doubleClickZoom: false,
  });
  enableDoubleTapZoom(map);
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
      const { zone: zoneId } = feature.properties;
      if (!polygonsByZone.has(zoneId)) polygonsByZone.set(zoneId, []);
      polygonsByZone.get(zoneId).push(polygon);
      polygon.bindTooltip(zoneLabel(zoneId, data), {
        sticky: true,
        direction: "top",
      });
      polygon.on("mouseover", () => setZoneOpacity(zoneId, HOVER_OPACITY));
      polygon.on("mouseout", () => setZoneOpacity(zoneId, NORMAL_OPACITY));
      polygon.on("click", async (event) => {
        const content = await renderPopup(zoneId);
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
