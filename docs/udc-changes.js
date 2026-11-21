// The UDC changes page: one section per amendment, newest first, from data/udc-changes.json.
import {
  PERMISSIONS,
  escapeHtml,
  externalLink,
  loadJson,
  showError,
} from "./data.js";

/** "AA: X -> S" -> "AA: ✕ → S". Allowed codes use the zone pages' marks; X (not allowed) is a red ✕. */
const CHANGE_LINE = /^(.+): ([PSATX]) -> ([PSATX])$/;

function permissionMark(code) {
  if (code === "X")
    return `<span class="denied" title="${PERMISSIONS.none.label}">✕</span>`;
  const { mark, label, className } = PERMISSIONS[code];
  return `<span class="${className}" title="${label}">${mark}</span>`;
}

function renderSummary(summary) {
  return summary
    .split("\n")
    .map((line) => {
      const match = CHANGE_LINE.exec(line);
      return match
        ? `${escapeHtml(match[1])}: ${permissionMark(match[2])} → ${permissionMark(match[3])}`
        : escapeHtml(line);
    })
    .join("<br />");
}

const PERMISSION_LEGEND = ["P", "S", "A", "T", "X"]
  .map(
    (code) =>
      `${permissionMark(code)} ${PERMISSIONS[code === "X" ? "none" : code].label.toLowerCase()}`,
  )
  .join(", ");

const KIND_LABELS = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
};

/** "2026-12" -> "December 2026", "2025-03-25" -> "March 25, 2025". */
function formatDate(date) {
  if (!date) return "";
  const [year, month, day] = date.split("-").map(Number);
  const monthName = new Date(year, month - 1, 1).toLocaleString("en-US", {
    month: "long",
  });
  return day ? `${monthName} ${day}, ${year}` : `${monthName} ${year}`;
}

function renderChange(change, amendment) {
  const quote = change.quote
    ? `<p class="muted note">“${escapeHtml(change.quote)}”</p>`
    : "";
  const review = change.review
    ? `<p class="muted note">Check: ${escapeHtml(change.review)}</p>`
    : "";
  const notOnSite =
    change.onSite === false
      ? ` <span class="tag">Map data not updated</span>`
      : "";
  const page = externalLink({
    label: `p. ${change.page}`,
    url: `${amendment.url}#page=${change.page}`,
  });
  return `<tr>
    <td>${escapeHtml(KIND_LABELS[change.kind] ?? change.kind)}</td>
    <td>${escapeHtml(change.section)}</td>
    <td><strong>${escapeHtml(change.title)}</strong>${notOnSite}<br />${renderSummary(change.summary)}${quote}${review}</td>
    <td class="source">${page}</td>
  </tr>`;
}

function renderAmendment(amendment) {
  const source = amendment.url
    ? ` · ${externalLink({ label: "UDC PDF", url: amendment.url })}`
    : "";
  const meta = `<p class="muted">${escapeHtml(formatDate(amendment.date))}${source}</p>`;
  const summary = amendment.summary
    ? `<p>${escapeHtml(amendment.summary)}</p>`
    : "";
  const coverage = amendment.coverage
    ? `<p class="muted">${escapeHtml(amendment.coverage)}</p>`
    : "";
  const table = amendment.changes.length
    ? `<div class="table-wrap"><table>
        <tr class="head"><th>Change</th><th>Section</th><th>What</th><th></th></tr>
        ${amendment.changes.map((change) => renderChange(change, amendment)).join("")}
      </table></div>`
    : "";
  return `<h2>${escapeHtml(amendment.title)}</h2>${meta}${summary}${coverage}${table}`;
}

async function initChangesPage() {
  const { amendments } = await loadJson("data/udc-changes.json");
  document.getElementById("changes").innerHTML =
    `<h1>UDC changes</h1>
     <p class="muted">${PERMISSION_LEGEND}</p>` +
    amendments.map(renderAmendment).join("");
}

initChangesPage().catch((error) =>
  showError(document.getElementById("changes"), error),
);
