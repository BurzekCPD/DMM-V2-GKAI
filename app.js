import { calculateAmount, calculateRealisation, isMgrFulfilled } from "./financial.js";

const CONFIG = window.DASHBOARD_CONFIG || {};
const MONEY_TYPES = [
  "Revenue Trip Count (RTC)",
  "Slot Revenue",
  "Service Charge",
  "Area Operational Surcharge",
  "Revenue Forecast Target",
  "Realisation (Unbilled)",
  "Realisation (Billed)",
];
const COMPOSITION_TYPES = ["Slot Revenue", "Service Charge", "Area Operational Surcharge"];
const LABELS = {
  "Revenue Trip Count (RTC)": "Revenue Trip Count (RTC)",
  "Slot Revenue": "Slot Revenue",
  "Service Charge": "Service Charge Revenue",
  "Area Operational Surcharge": "Area Operational Surcharge",
  "Revenue Forecast Target": "Revenue Forecast Target",
  "Realisation (Unbilled)": "Realisation (Unbilled)",
  "Realisation (Billed)": "Realisation (Billed)",
  "Electricity Usage": "Electricity Usage",
  "Water Usage": "Water Usage",
  "Utility Cost": "Utility Cost",
};
const COLORS = {
  "Revenue Trip Count (RTC)": "#2d2a70",
  "Slot Revenue": "#ed6b23",
  "Service Charge": "#00571a",
  "Area Operational Surcharge": "#a23b72",
  "Revenue Forecast Target": "#617b9c",
  "Realisation (Unbilled)": "#c18a00",
  "Realisation (Billed)": "#138a72",
};
const SORT_LABELS = {
  month: ["Oldest first", "Newest first"],
  amount: ["Lowest first", "Highest first"],
  tenant: ["A to Z", "Z to A"],
  brand: ["A to Z", "Z to A"],
  id: ["A to Z", "Z to A"],
  billing: ["A to Z", "Z to A"],
  company: ["A to Z", "Z to A"],
};
const $ = (selector) => document.querySelector(selector);
const quantityFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const state = {
  sortKey: "month",
  ascending: false,
  selectedMonth: null,
  recordsSearch: "",
  mgrSearch: "",
  selectedStation: "",
  selectedDataType: "",
  selectedYear: "",
  selectedTenant: "",
  selectedBrand: "",
  selectedSlot: "",
  selectedBillingStatus: "",
  selectedCurrency: "",
};
const RECORD_ROW_HEIGHT = 44;
const RECORD_ROW_OVERSCAN = 10;
let monthlyIndexSource = null;
let monthlyIndex = null;
let allMonthsSummary = null;
let currentVisibleRecords = [];
let currentMgrRows = [];
let lastRecordWindow = { start: -1, end: -1 };
let lastMgrWindow = { start: -1, end: -1 };
let records = [];
let datasetSource = "Reporting API";
let dataCurrency = "";
let currencyOptions = [];
let csrfToken = null;
let lastSuccessfulSync = null;
let lastImportedAt = null;
let connectorSources = [];
let monthlyIndexFilterSignature = "";
let localShowcaseActive = false;

function formatMoney(amount) {
  if (!dataCurrency) return "Select currency";
  const scaledForShowcase = localShowcaseActive && Math.abs(amount) > 1_000_000;
  const displayAmount = scaledForShowcase ? amount / 1_000 : amount;
  const formatted = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: dataCurrency,
    maximumFractionDigits: scaledForShowcase ? 2 : undefined,
  }).format(displayAmount);
  return formatted;
}

const displayedRevenueAmount = (_type, amount) => amount;

function getMonths() {
  return [...getMonthlyIndex().keys()].sort();
}

function recordsForMonth(month) {
  return month ? getMonthlyIndex().get(month)?.monthRecords || [] : filteredRecords();
}

function filteredRecords() {
  return records.filter((record) =>
    (!state.selectedYear || record.month.startsWith(`${state.selectedYear}-`))
    && (!state.selectedStation || record.station === state.selectedStation)
    && (!state.selectedTenant || record.tenant === state.selectedTenant)
    && (!state.selectedBrand || record.brand === state.selectedBrand)
    && (!state.selectedSlot || record.slot === state.selectedSlot)
    && (!state.selectedDataType || record.dataType === state.selectedDataType)
    && (!state.selectedBillingStatus || record.billingStatus === state.selectedBillingStatus));
}

function getMonthTotals(month) {
  const index = getMonthlyIndex();
  if (month) return index.get(month) || createEmptyMonthSummary(month);
  if (allMonthsSummary) return allMonthsSummary;

  const summary = createEmptyMonthSummary("");
  summary.monthRecords = filteredRecords();
  index.forEach((monthSummary) => {
    Object.keys(summary.totals).forEach((type) => {
      summary.totals[type] += monthSummary.totals[type];
    });
    summary.mgrRows.push(...monthSummary.mgrRows);
  });
  summary.mgrRows.sort((a, b) => a.month.localeCompare(b.month) || a.tenant.localeCompare(b.tenant) || a.slot.localeCompare(b.slot));
  allMonthsSummary = summary;
  return allMonthsSummary;
}

function createEmptyMonthSummary(month) {
  const totals = Object.fromEntries([...MONEY_TYPES, "Electricity Usage", "Water Usage", "Utility Cost", "Minimum Guaranteed Revenue"].map((type) => [type, 0]));
  return { month, totals, monthRecords: [], mgrRows: [] };
}

function getMonthlyIndex() {
  const filterSignature = JSON.stringify([
    state.selectedYear,
    state.selectedStation,
    state.selectedTenant,
    state.selectedBrand,
    state.selectedSlot,
    state.selectedDataType,
    state.selectedBillingStatus,
  ]);
  if (records === monthlyIndexSource && filterSignature === monthlyIndexFilterSignature) return monthlyIndex;

  const index = new Map();
  const knownTypes = new Set([...MONEY_TYPES, "Electricity Usage", "Water Usage", "Utility Cost"]);

  filteredRecords().forEach((record) => {
    if (!index.has(record.month)) {
      const summary = createEmptyMonthSummary(record.month);
      summary.mgrSlots = new Map();
      index.set(record.month, summary);
    }

    const summary = index.get(record.month);
    summary.monthRecords.push(record);
    const amount = calculateAmount(record);
    if (knownTypes.has(record.dataType)) summary.totals[record.dataType] += amount;

    const key = `${record.tenant}\u0000${record.slot}`;
    if (!summary.mgrSlots.has(key)) {
      summary.mgrSlots.set(key, {
        month: record.month,
        station: record.station || "",
        tenant: record.tenant,
        slot: record.slot,
        minimum: null,
        baseRevenue: 0,
      });
    }
    const mgrEntry = summary.mgrSlots.get(key);
    if (record.station) mgrEntry.station = record.station;
    if (record.minimumBaseRent !== null) mgrEntry.minimum = record.minimumBaseRent;
    if (record.dataType === "Slot Revenue") mgrEntry.baseRevenue += amount;
  });

  index.forEach((summary) => {
    ["Realisation (Billed)", "Realisation (Unbilled)"].forEach((type) => {
      summary.totals[type] = calculateRealisation(summary.monthRecords, type);
    });
    summary.mgrRows = [...summary.mgrSlots.values()]
      .filter((entry) => entry.minimum !== null)
      .sort((a, b) => a.tenant.localeCompare(b.tenant) || a.slot.localeCompare(b.slot))
      .map((entry) => ({ ...entry, fulfilled: isMgrFulfilled(entry.baseRevenue, entry.minimum) }));
    summary.totals["Minimum Guaranteed Revenue"] = summary.mgrRows.reduce((sum, entry) => sum + entry.minimum, 0);
    delete summary.mgrSlots;
  });

  monthlyIndexSource = records;
  monthlyIndexFilterSignature = filterSignature;
  monthlyIndex = index;
  allMonthsSummary = null;
  return monthlyIndex;
}

function renderKpis(summary, previous) {
  const cards = [
    ...MONEY_TYPES.map((type) => ({
      label: LABELS[type],
      key: type,
      value: displayedRevenueAmount(type, summary.totals[type]),
      format: "money",
    })),
    {
      label: "Minimum Guaranteed Revenue",
      key: "Minimum Guaranteed Revenue",
      value: displayedRevenueAmount("Minimum Guaranteed Revenue", summary.totals["Minimum Guaranteed Revenue"]),
      format: "money",
    },
  ];
  const forecast = displayedRevenueAmount("Revenue Forecast Target", summary.totals["Revenue Forecast Target"]);
  if (forecast > 0) {
    const realised = displayedRevenueAmount("Realisation (Billed)", summary.totals["Realisation (Billed)"])
      + displayedRevenueAmount("Realisation (Unbilled)", summary.totals["Realisation (Unbilled)"]);
    cards.push({ label: "Realisation vs forecast target", value: realised / forecast * 100, format: "percent" });
  }
  const hasElectricity = summary.monthRecords.some((record) => record.dataType === "Electricity Usage");
  const hasWater = summary.monthRecords.some((record) => record.dataType === "Water Usage");
  const hasUtilityCost = summary.monthRecords.some((record) => record.dataType === "Utility Cost");
  if (hasElectricity) cards.push({ label: "Electricity Usage", value: summary.totals["Electricity Usage"], format: "quantity" });
  if (hasWater) cards.push({ label: "Water Usage", value: summary.totals["Water Usage"], format: "quantity" });
  if (hasUtilityCost) cards.push({ label: "Utility Cost", key: "Utility Cost", inverse: true, value: summary.totals["Utility Cost"], format: "money" });

  const formatValue = (card) => card.format === "money" ? formatMoney(card.value)
    : card.format === "percent" ? `${card.value.toFixed(1)}%` : quantityFormat.format(card.value);
  const changeHtml = (card) => {
    let before = previous && card.key ? previous[card.key] : null;
    if (before !== null && (MONEY_TYPES.includes(card.key) || card.key === "Minimum Guaranteed Revenue")) {
      before = displayedRevenueAmount(card.key, before);
    }
    if (!before) return "";
    const pct = (card.value - before) / before * 100;
    const good = card.inverse ? pct <= 0 : pct >= 0;
    return `<div class="kpi-change ${good ? "up" : "down"}">${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs previous month</div>`;
  };
  $("#kpis").innerHTML = cards.map((card) => `
    <article class="kpi">
      <div class="kpi-label">${escapeHtml(card.label)}</div>
      <div class="kpi-value">${formatValue(card)}</div>
      ${changeHtml(card)}
    </article>
  `).join("");
}

function renderFulfillment(mgrRows) {
  if (mgrRows.length === 0) {
    $("#fulfillment").innerHTML = '<strong>MGR fulfillment:</strong> Minimum Base Rent is not configured for this month.';
    return;
  }
  const fulfilled = mgrRows.filter((entry) => entry.fulfilled).length;
  $("#fulfillment").innerHTML = `<strong>MGR fulfilled:</strong> ${fulfilled} of ${mgrRows.length} slots meet Minimum Base Rent.`;
}

function renderPerformance() {
  const rows = getMonthTotals(state.selectedMonth).monthRecords;
  const stations = new Map();
  const tenants = new Map();
  let totalSlotRevenue = 0;
  rows.forEach((record) => {
    const station = record.station || "Unknown station";
    if (!stations.has(station)) stations.set(station, { revenue: 0, slots: new Set(), mgrSlots: 0, fulfilled: 0 });
    const slotRevenue = record.dataType === "Slot Revenue" ? calculateAmount(record) : 0;
    const stationRow = stations.get(station);
    stationRow.revenue += slotRevenue;
    if (record.dataType === "Slot Revenue") {
      stationRow.slots.add(record.slot);
      totalSlotRevenue += slotRevenue;
    }

    const tenantKey = `${record.tenantId || record.tenant}\u0000${record.brand || ""}`;
    if (!tenants.has(tenantKey)) {
      tenants.set(tenantKey, {
        tenant: record.tenant,
        brand: record.brand || "",
        revenue: 0,
        billingStates: new Set(),
      });
    }
    const tenantRow = tenants.get(tenantKey);
    if (record.dataType === "Slot Revenue") tenantRow.revenue += slotRevenue;
    if (record.billingStatus && record.billingStatus !== "Not applicable") tenantRow.billingStates.add(record.billingStatus);
  });

  getMonthTotals(state.selectedMonth).mgrRows.forEach((entry) => {
    const station = entry.station || "Unknown station";
    if (!stations.has(station)) stations.set(station, { revenue: 0, slots: new Set(), mgrSlots: 0, fulfilled: 0 });
    const stationRow = stations.get(station);
    stationRow.mgrSlots += 1;
    if (entry.fulfilled) stationRow.fulfilled += 1;
  });

  const stationRows = [...stations.entries()]
    .map(([station, value]) => ({ station, ...value }))
    .sort((a, b) => b.revenue - a.revenue || a.station.localeCompare(b.station));
  const tenantRows = [...tenants.values()]
    .sort((a, b) => b.revenue - a.revenue || a.tenant.localeCompare(b.tenant));
  $("#station-performance-count").textContent = stationRows.length > 100 ? `(top 100 of ${stationRows.length})` : `(${stationRows.length})`;
  $("#tenant-performance-count").textContent = tenantRows.length > 100 ? `(top 100 of ${tenantRows.length})` : `(${tenantRows.length})`;
  const emptyRow = (columns) => `<tr><td class="empty-state" colspan="${columns}">No reporting records match these filters.</td></tr>`;
  $("#station-performance").innerHTML = stationRows.length ? stationRows.slice(0, 100).map((entry, index) => `
    <tr>
      <td>${index + 1}</td><td>${escapeHtml(entry.station)}</td>
      <td class="num">${formatMoney(entry.revenue)}</td>
      <td class="num">${formatMoney(entry.slots.size ? entry.revenue / entry.slots.size : 0)}</td>
      <td>${entry.mgrSlots ? `${entry.fulfilled} / ${entry.mgrSlots}` : "Not configured"}</td>
    </tr>`).join("") : emptyRow(5);
  $("#tenant-performance").innerHTML = tenantRows.length ? tenantRows.slice(0, 100).map((entry, index) => `
    <tr>
      <td>${index + 1}</td><td>${escapeHtml(entry.tenant)}</td><td>${escapeHtml(entry.brand)}</td>
      <td class="num">${formatMoney(entry.revenue)}</td>
      <td>${totalSlotRevenue ? `${(entry.revenue / totalSlotRevenue * 100).toFixed(1)}%` : "—"}</td>
      <td>${escapeHtml([...entry.billingStates].sort().join(", ") || "Not available")}</td>
    </tr>`).join("") : emptyRow(6);
}

function renderChart() {
  const width = Math.max(360, $("#chart").clientWidth);
  const stacked = width < 620;
  const height = stacked ? 620 : 440;
  const summary = getMonthTotals(state.selectedMonth);
  const monthLabel = state.selectedMonth || "All months";
  const slices = COMPOSITION_TYPES.map((type) => ({
    type,
    value: displayedRevenueAmount(type, summary.totals[type]),
  }));
  const total = slices.reduce((sum, item) => sum + item.value, 0);
  const centerX = stacked ? width / 2 : width * 0.32;
  const centerY = stacked ? 155 : height / 2;
  const radius = Math.min(stacked ? 135 : 160, width * (stacked ? 0.38 : 0.25));
  const legendX = stacked ? 24 : width * 0.59;
  const legendStartY = stacked ? 330 : 125;
  const legendRowHeight = stacked ? 38 : 42;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Revenue composition for ${monthLabel}`);

  const add = (tag, attributes, text) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
    if (text !== undefined) element.textContent = text;
    svg.appendChild(element);
    return element;
  };
  add("title", {}, `Revenue composition · ${monthLabel}`);
  if (total > 0) {
    let startAngle = -Math.PI / 2;
    slices.forEach((item) => {
      if (item.value <= 0) return;
      const share = item.value / total;
      const endAngle = startAngle + share * Math.PI * 2;
      const startX = centerX + radius * Math.cos(startAngle);
      const startY = centerY + radius * Math.sin(startAngle);
      const endX = centerX + radius * Math.cos(endAngle);
      const endY = centerY + radius * Math.sin(endAngle);
      const largeArc = share > 0.5 ? 1 : 0;
      const slice = share >= 1
        ? add("circle", { cx: centerX, cy: centerY, r: radius, fill: COLORS[item.type] })
        : add("path", {
          d: `M ${centerX} ${centerY} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`,
          fill: COLORS[item.type],
          stroke: "#fff",
          "stroke-width": 1,
        });
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${LABELS[item.type]}: ${formatMoney(item.value)} (${(share * 100).toFixed(1)}%)`;
      slice.appendChild(title);
      startAngle = endAngle;
    });
  } else {
    add("text", {
      x: centerX,
      y: centerY,
      "text-anchor": "middle",
      fill: "#6b6a80",
      "font-size": 14,
    }, "No revenue data for this period");
  }
  slices.forEach((item, index) => {
    const y = legendStartY + index * legendRowHeight;
    const share = total > 0 ? item.value / total * 100 : 0;
    add("rect", { x: legendX, y: y - 10, width: 12, height: 12, rx: 2, fill: COLORS[item.type] });
    add("text", { x: legendX + 20, y, fill: "#1c1b33", "font-size": 12 }, LABELS[item.type]);
    add("text", { x: legendX + 20, y: y + 16, fill: "#6b6a80", "font-size": 11 },
      `${formatMoney(item.value)} · ${share.toFixed(1)}%`);
  });
  $("#chart").replaceChildren(svg);
}

function visibleRecords() {
  const monthRecords = recordsForMonth(state.selectedMonth);
  const query = state.recordsSearch.trim().toLocaleLowerCase();
  return monthRecords.map((record) => ({ ...record, amount: calculateAmount(record) }))
    .filter((record) => !query || [
      record.tenant, record.company, record.brand, record.station,
      record.stationId, record.slot, formatRecordId(record.slot), record.tenantId, record.sourceRecordId,
    ].some((value) => String(value || "").toLocaleLowerCase().includes(query)))
    .sort((a, b) => {
      let order = 0;
      if (state.sortKey === "amount") order = a.amount - b.amount;
      else if (state.sortKey === "month") order = a.month.localeCompare(b.month);
      else if (state.sortKey === "tenant") order = a.tenant.localeCompare(b.tenant);
      else if (state.sortKey === "brand") order = (a.brand || "").localeCompare(b.brand || "");
      else if (state.sortKey === "company") order = (a.company || "").localeCompare(b.company || "");
      else if (state.sortKey === "id") order = formatRecordId(a.slot).localeCompare(formatRecordId(b.slot), undefined, { numeric: true });
      else if (state.sortKey === "billing") order = (a.billingStatus || "Not applicable").localeCompare(b.billingStatus || "Not applicable");
      if (order === 0) order = a.tenant.localeCompare(b.tenant) || a.slot.localeCompare(b.slot) || a.dataType.localeCompare(b.dataType);
      return state.ascending ? order : -order;
    });
}

function displayAmount(record) {
  if (["Electricity Usage", "Water Usage"].includes(record.dataType)) {
    return `${quantityFormat.format(record.amount)}${record.unit ? ` ${escapeHtml(record.unit)}` : ""}`;
  }
  return formatMoney(record.amount);
}

function formatRecordId(value) {
  const id = String(value);
  return /^\d+$/.test(id) ? id.padStart(3, "0") : id;
}

function renderTable(rows) {
  $("#count").textContent = `${rows.length} records`;
  const body = $("#rows");
  const wrap = body.closest(".table-wrap");
  const headerHeight = wrap.querySelector("thead").getBoundingClientRect().height;
  const visibleCount = Math.ceil((wrap.clientHeight - headerHeight) / RECORD_ROW_HEIGHT) + RECORD_ROW_OVERSCAN * 2;
  const start = rows.length
    ? Math.max(0, Math.floor(Math.max(0, wrap.scrollTop - headerHeight) / RECORD_ROW_HEIGHT) - RECORD_ROW_OVERSCAN)
    : 0;
  const end = Math.min(rows.length, start + visibleCount);
  if (lastRecordWindow.rows === rows && lastRecordWindow.start === start && lastRecordWindow.end === end) return;
  lastRecordWindow = { rows, start, end };

  if (!rows.length) {
    body.innerHTML = state.recordsSearch.trim()
      ? '<tr><td class="empty-state" colspan="10">No monthly records match your search.</td></tr>'
      : '<tr><td class="empty-state" colspan="10">No reporting records match the selected filters.</td></tr>';
    return;
  }

  const topSpacer = start ? `<tr class="virtual-spacer" aria-hidden="true"><td colspan="10" style="height:${start * RECORD_ROW_HEIGHT}px"></td></tr>` : "";
  const bottomSpacer = end < rows.length
    ? `<tr class="virtual-spacer" aria-hidden="true"><td colspan="10" style="height:${(rows.length - end) * RECORD_ROW_HEIGHT}px"></td></tr>`
    : "";
  body.innerHTML = `${topSpacer}${rows.slice(start, end).map((record) => `
    <tr>
      <td>${escapeHtml(record.month)}</td>
      <td>${escapeHtml(record.station || "")}</td>
      <td>${escapeHtml(record.tenant)}</td>
      <td>${escapeHtml(record.company || "")}</td>
      <td>${escapeHtml(record.brand || "")}</td>
      <td>${escapeHtml(formatRecordId(record.slot))}</td>
      <td>${escapeHtml(LABELS[record.dataType] || record.dataType)}</td>
      <td>${escapeHtml(record.billingStatus || "Not applicable")}</td>
      <td class="num">${displayAmount(record)}</td>
      <td title="${escapeHtml(`${record.sourceFile || record.source || ""} · ${record.sourceRecordId || ""} · row ${record.sourceRowNumber || ""}`)}">${escapeHtml(`${record.sourceFile || record.source || ""} · ${record.sourceRecordId || ""}`)}</td>
    </tr>
  `).join("")}${bottomSpacer}`;
}

function refreshRecordsTable(resetScroll = false) {
  const wrap = $("#rows").closest(".table-wrap");
  if (resetScroll) wrap.scrollTop = 0;
  currentVisibleRecords = visibleRecords();
  lastRecordWindow = { start: -1, end: -1 };
  renderTable(currentVisibleRecords);
}

function renderMgrTable(mgrRows) {
  const query = state.mgrSearch.trim().toLocaleLowerCase();
  currentMgrRows = mgrRows.filter((entry) => !query || [
    entry.month,
    entry.station,
    entry.tenant,
    entry.slot,
    formatRecordId(entry.slot),
    formatMoney(entry.minimum),
    formatMoney(entry.baseRevenue),
    entry.fulfilled ? "Fulfilled" : "Not fulfilled",
  ].some((value) => String(value).toLocaleLowerCase().includes(query)));
  const wrap = $("#mgr-rows").closest(".table-wrap");
  wrap.scrollTop = 0;
  lastMgrWindow = { start: -1, end: -1 };
  renderMgrRows(currentMgrRows);
}

function renderMgrRows(rows) {
  const body = $("#mgr-rows");
  const wrap = body.closest(".table-wrap");
  const headerHeight = wrap.querySelector("thead").getBoundingClientRect().height;
  const visibleCount = Math.ceil((wrap.clientHeight - headerHeight) / RECORD_ROW_HEIGHT) + RECORD_ROW_OVERSCAN * 2;
  const start = rows.length
    ? Math.max(0, Math.floor(Math.max(0, wrap.scrollTop - headerHeight) / RECORD_ROW_HEIGHT) - RECORD_ROW_OVERSCAN)
    : 0;
  const end = Math.min(rows.length, start + visibleCount);
  if (lastMgrWindow.rows === rows && lastMgrWindow.start === start && lastMgrWindow.end === end) return;
  lastMgrWindow = { rows, start, end };

  if (!rows.length) {
    body.innerHTML = state.mgrSearch.trim()
      ? '<tr><td class="empty-state" colspan="7">No MGR slots match your search.</td></tr>'
      : "";
    return;
  }

  const topSpacer = start ? `<tr class="virtual-spacer" aria-hidden="true"><td colspan="7" style="height:${start * RECORD_ROW_HEIGHT}px"></td></tr>` : "";
  const bottomSpacer = end < rows.length
    ? `<tr class="virtual-spacer" aria-hidden="true"><td colspan="7" style="height:${(rows.length - end) * RECORD_ROW_HEIGHT}px"></td></tr>`
    : "";
  body.innerHTML = `${topSpacer}${rows.slice(start, end).map((entry) => `
    <tr>
      <td>${escapeHtml(entry.month)}</td>
      <td>${escapeHtml(entry.station || "")}</td>
      <td>${escapeHtml(entry.tenant)}</td>
      <td>${escapeHtml(formatRecordId(entry.slot))}</td>
      <td class="num">${formatMoney(entry.minimum)}</td>
      <td class="num">${formatMoney(entry.baseRevenue)}</td>
      <td><span class="status ${entry.fulfilled ? "fulfilled" : "not-fulfilled"}">${entry.fulfilled ? "Fulfilled" : "Not fulfilled"}</span></td>
    </tr>
  `).join("")}${bottomSpacer}`;
}

function renderControls() {
  document.querySelectorAll("#sort-controls [data-sort]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.sort === state.sortKey));
  });
  document.querySelectorAll(".th-btn[data-sort]").forEach((button) => {
    button.classList.toggle("active", button.dataset.sort === state.sortKey);
  });
  $("#direction").textContent = SORT_LABELS[state.sortKey][state.ascending ? 0 : 1];
}

function renderMonths() {
  const previous = state.selectedMonth;
  const months = getMonths();
  state.selectedMonth = previous === null
    ? months[months.length - 1] || ""
    : previous === "" || months.includes(previous)
      ? previous
      : months[months.length - 1] || "";
  $("#month-filter").innerHTML = [
    '<option value="">All months</option>',
    ...months.map((month) => `<option value="${escapeHtml(month)}">${escapeHtml(month)}</option>`),
  ].join("");
  $("#month-filter").value = state.selectedMonth;
}

function renderRecordSlicers() {
  const options = (values, selected, allLabel, label = (value) => value) => {
    const distinct = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (selected && !distinct.includes(selected)) selected = "";
    return {
      selected,
      html: [`<option value="">${allLabel}</option>`, ...distinct.map((value) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(label(value))}</option>`) ].join(""),
    };
  };
  const setOptions = (selector, values, selected, label, renderLabel) => {
    const result = options(values, selected, label, renderLabel);
    $(selector).innerHTML = result.html;
    $(selector).value = result.selected;
    return result.selected;
  };
  const years = [...new Set(records.map((record) => record.month.slice(0, 4)))].sort();
  state.selectedYear = setOptions("#year-filter", years, state.selectedYear, "All years");
  state.selectedStation = setOptions("#station-filter", records.map((record) => record.station), state.selectedStation, "All stations");
  state.selectedTenant = setOptions("#tenant-filter", records.map((record) => record.tenant), state.selectedTenant, "All tenants");
  state.selectedBrand = setOptions("#brand-filter", records.map((record) => record.brand), state.selectedBrand, "All brands");
  state.selectedSlot = setOptions("#slot-filter", records.map((record) => record.slot), state.selectedSlot, "All slots");
  state.selectedDataType = setOptions("#data-type-filter", records.map((record) => record.dataType), state.selectedDataType, "All data types", (value) => LABELS[value] || value);
  state.selectedBillingStatus = setOptions("#billing-filter", records.map((record) => record.billingStatus), state.selectedBillingStatus, "All billing statuses");
  const currencyResult = options(currencyOptions, state.selectedCurrency, "Select currency");
  $("#currency-filter").innerHTML = currencyResult.html;
  $("#currency-filter").value = currencyResult.selected;
  state.selectedCurrency = currencyResult.selected;
}

function render() {
  renderMonths();
  renderRecordSlicers();
  $("#rows").closest(".table-wrap").scrollTop = 0;
  $("#mgr-rows").closest(".table-wrap").scrollTop = 0;
  const monthLabel = state.selectedMonth || "all months";
  const summary = getMonthTotals(state.selectedMonth);
  const allMonths = getMonths();
  const monthIndex = allMonths.indexOf(state.selectedMonth);
  renderKpis(summary, monthIndex > 0 ? getMonthTotals(allMonths[monthIndex - 1]).totals : null);
  renderFulfillment(summary.mgrRows);
  renderChart();
  renderPerformance();
  refreshRecordsTable();
  renderMgrTable(summary.mgrRows);
  renderControls();
  const freshnessDate = lastSuccessfulSync || lastImportedAt;
  const freshnessLabel = lastSuccessfulSync ? "Last successful sync" : "Last imported";
  const syncText = freshnessDate ? ` · ${freshnessLabel} ${new Date(freshnessDate).toLocaleString()}` : "";
  const currencyText = dataCurrency || (currencyOptions.length > 1 ? "choose a currency" : CONFIG.reportingCurrency || "IDR");
  $("#dataset-status").textContent = `${datasetSource} · ${records.length} source rows · ${currencyText} · ${monthLabel}${syncText}`;
  const span = getMonths();
  if (span.length) $("#period").textContent = `Tenant portfolio, ${span[0]} to ${span[span.length - 1]}`;
}

function setSort(key) {
  if (key === state.sortKey) state.ascending = !state.ascending;
  else {
    state.sortKey = key;
    state.ascending = !["month", "amount"].includes(key);
  }
  renderControls();
  refreshRecordsTable();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function showError(message) {
  const box = $("#error");
  box.hidden = false;
  box.textContent = message;
}

function clearError() {
  const box = $("#error");
  box.hidden = true;
  box.textContent = "";
}

function clearDashboardData() {
  records = [];
  currentVisibleRecords = [];
  currentMgrRows = [];
  currencyOptions = [];
  dataCurrency = "";
  connectorSources = [];
  lastSuccessfulSync = null;
  lastImportedAt = null;
  monthlyIndex = null;
  monthlyIndexSource = null;
  allMonthsSummary = null;
  lastRecordWindow = { start: -1, end: -1 };
  lastMgrWindow = { start: -1, end: -1 };
  monthlyIndexFilterSignature = "";
  state.selectedMonth = null;
  state.selectedYear = "";
  state.selectedStation = "";
  state.selectedTenant = "";
  state.selectedBrand = "";
  state.selectedSlot = "";
  state.selectedDataType = "";
  state.selectedBillingStatus = "";
  state.selectedCurrency = "";
  state.recordsSearch = "";
  state.mgrSearch = "";
  $("#period").textContent = "Tenant portfolio";
  $("#month-filter").replaceChildren();
  ["#year-filter", "#station-filter", "#tenant-filter", "#brand-filter", "#slot-filter",
    "#data-type-filter", "#billing-filter", "#currency-filter"].forEach((selector) => $(selector).replaceChildren());
  $("#records-search").value = "";
  $("#mgr-search").value = "";
  $("#count").textContent = "";
  $("#dataset-status").textContent = "";
  $("#live-status").hidden = true;
  $("#kpis").replaceChildren();
  $("#fulfillment").replaceChildren();
  $("#chart").replaceChildren();
  $("#rows").replaceChildren();
  $("#mgr-rows").replaceChildren();
  $("#station-performance").replaceChildren();
  $("#tenant-performance").replaceChildren();
  $("#station-performance-count").textContent = "";
  $("#tenant-performance-count").textContent = "";
  $("#data-quality").replaceChildren();
  $("#reconciliation-status").replaceChildren();
  $("#import-history-content").replaceChildren();
}

function downloadTemplate() {
  const content = [
    "Month,Tenant,Tenant ID,Company,Brand,Slot,Station,Station ID,Data Type,Currency,Trips,Quantity,Tariff,Total Amount,Billing Status,Annual Surcharge Rate,Minimum Base Rent,Unit,Source Record ID",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "executive-dashboard-template.csv";
  link.click();
  URL.revokeObjectURL(url);
}

async function apiRequest(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.method && options.method !== "GET" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers,
  });
  if (response.status === 401 && !url.endsWith("/api/auth/login")) {
    csrfToken = null;
    clearDashboardData();
    setDashboardVisible(false);
  }
  if (response.status === 204) return null;
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`The reporting service returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(payload.error || `The reporting service returned HTTP ${response.status}.`);
  return payload;
}

function setDashboardVisible(visible) {
  document.querySelectorAll("main > section").forEach((section) => {
    section.hidden = !visible;
  });
  $("#logout").hidden = demoMode || !visible;
}

let demoMode = false;

function activateLocalShowcase() {
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const demoRecords = window.LOCAL_DEMO_RECORDS;
  if (!CONFIG.localDemoShowcase || !localHosts.has(window.location.hostname)
    || !Array.isArray(demoRecords) || demoRecords.length === 0) {
    return false;
  }

  localShowcaseActive = true;
  demoMode = true;
  csrfToken = null;
  records = demoRecords;
  currencyOptions = ["IDR"];
  dataCurrency = "IDR";
  datasetSource = "Illustrative demo dataset";
  lastSuccessfulSync = null;
  lastImportedAt = null;
  connectorSources = [];
  monthlyIndexSource = null;
  allMonthsSummary = null;

  setDashboardVisible(true);
  $("#local-demo-banner").hidden = false;
  $("#import-panel").hidden = true;
  $("#data-quality").textContent = "Local showcase from the existing tenant snapshot. Values and tenant identities are not verified against an authorized current source.";
  $("#reconciliation-status").textContent = "Reconciliation is unavailable: the tenant snapshot has no reporting period, currency field, invoice data, or approved source control totals.";
  $("#import-history-content").textContent = "Imports are disabled in the local showcase.";
  render();
  const liveStatus = $("#live-status");
  liveStatus.hidden = false;
  liveStatus.className = "live-pill offline";
  liveStatus.textContent = "Local showcase · tenant snapshot · no live sources connected";
  return true;
}

async function loadDashboard() {
  const query = state.selectedCurrency ? `?currency=${encodeURIComponent(state.selectedCurrency)}` : "";
  const payload = await apiRequest(`/api/dashboard${query}`);
  if (demoMode && payload.totalRecords === 0 && payload.currencies.length === 0 && activateLocalShowcase()) {
    return;
  }
  records = payload.records;
  currencyOptions = payload.currencies;
  lastSuccessfulSync = payload.lastSuccessfulSync;
  lastImportedAt = payload.lastImportedAt;
  connectorSources = payload.sources || [];
  if (payload.currencyRequired) {
    state.selectedCurrency = "";
    dataCurrency = "";
    records = [];
    datasetSource = "Select one currency to report; currency conversion is disabled";
  } else {
    state.selectedCurrency = state.selectedCurrency || (currencyOptions.length === 1 ? currencyOptions[0] : "");
    dataCurrency = state.selectedCurrency || payload.reportingCurrency;
    datasetSource = records.length ? "Backend reporting data" : "No imported operational records";
  }
  monthlyIndexSource = null;
  render();
  const liveStatus = $("#live-status");
  const implemented = connectorSources.some((source) => source.configured && source.implemented);
  const configuredWithoutAdapter = connectorSources.some((source) => source.configured && !source.implemented);
  liveStatus.hidden = false;
  liveStatus.className = `live-pill ${implemented ? "live" : "offline"}`;
  liveStatus.textContent = implemented
    ? "Source connector available; dashboard data loaded from reporting database"
    : configuredWithoutAdapter
      ? "Connector configuration exists, but adapters are not implemented; manual imports only"
      : "POS and billing connectors are unconfigured; manual imports only";
}

async function loadImportHistory() {
  const { imports } = await apiRequest("/api/imports");
  const container = $("#import-history-content");
  if (!imports.length) {
    container.textContent = "No imports have been recorded.";
    return;
  }
  container.innerHTML = `<table><thead><tr><th>Imported</th><th>File</th><th>Currency</th><th>Status</th><th>Accepted</th><th>Rejected</th><th>Duplicates</th><th>Review</th></tr></thead><tbody>${
    imports.map((item) => `<tr><td>${escapeHtml(new Date(item.created_at).toLocaleString())}</td>
      <td>${escapeHtml(item.original_filename)}</td><td>${escapeHtml(item.currency || "Mixed/unspecified")}</td>
      <td>${escapeHtml(item.status)}</td><td>${item.accepted_count}</td><td>${item.rejected_count}</td><td>${item.duplicate_count}</td>
      <td>${item.rejected_count ? `<button class="btn" type="button" data-review-batch="${escapeHtml(item.batch_id)}">View rejected rows</button>` : "—"}</td></tr>`).join("")
  }</tbody></table>`;
}

async function loadQuality() {
  const { checks, referenceMatching } = await apiRequest("/api/quality");
  const items = [
    ["Imported records", checks.totalRecords],
    ["Missing station identifiers", checks.missingStationIdentifiers],
    ["Missing required financial amounts", checks.missingRequiredAmounts],
    ["Missing surcharge rates", checks.missingSurchargeRates],
    ["Rejected rows awaiting review", checks.rejectedImportRows],
    ["Slot IDs with conflicting tenant/station associations", checks.ambiguousSlotIdentifiers],
    ["Source registries", referenceMatching],
    ["Currencies in reporting database", checks.currencies.map((item) => `${item.currency} (${item.count})`).join(", ") || "None"],
  ];
  $("#data-quality").innerHTML = `<ul>${items.map(([label, value]) =>
    `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`).join("")}</ul>`;
}

async function loadReconciliation() {
  const { results, blockers } = await apiRequest("/api/reconciliation");
  const resultMarkup = results.length
    ? `<table><thead><tr><th>Period</th><th>Source</th><th>Currency</th><th>Check</th><th>Source total</th><th>Dashboard total</th><th>Variance</th><th>Status</th></tr></thead><tbody>${
      results.map((item) => `<tr><td>${escapeHtml(String(item.reporting_month).slice(0, 10))}</td>
        <td>${escapeHtml(item.source_id || "—")}</td><td>${escapeHtml(item.currency)}</td>
        <td>${escapeHtml(item.reconciliation_type)}</td><td>${escapeHtml(item.source_total ?? "—")}</td>
        <td>${escapeHtml(item.dashboard_total ?? "—")}</td><td>${escapeHtml(item.variance ?? "—")}</td>
        <td>${escapeHtml(item.status)}${item.explanation ? ` · ${escapeHtml(item.explanation)}` : ""}</td></tr>`).join("")
    }</tbody></table>`
    : "<p>No reconciliation has been completed against an approved operational or financial source.</p>";
  $("#reconciliation-status").innerHTML = `${resultMarkup}<ul>${
    blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join("")
  }</ul>`;
}

function bindEvents() {
  $("#logout").addEventListener("click", async () => {
    clearError();
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
      csrfToken = null;
      clearDashboardData();
      setDashboardVisible(false);
    } catch (error) {
      showError(error.message);
    }
  });
  $("#records-search").addEventListener("input", (event) => {
    state.recordsSearch = event.target.value;
    refreshRecordsTable(true);
  });
  const globalFilters = {
    "year-filter": "selectedYear",
    "station-filter": "selectedStation",
    "tenant-filter": "selectedTenant",
    "brand-filter": "selectedBrand",
    "slot-filter": "selectedSlot",
    "data-type-filter": "selectedDataType",
    "billing-filter": "selectedBillingStatus",
  };
  Object.entries(globalFilters).forEach(([id, stateKey]) => {
    $(`#${id}`).addEventListener("change", (event) => {
      state[stateKey] = event.target.value;
      monthlyIndexSource = null;
      render();
    });
  });
  $("#currency-filter").addEventListener("change", async (event) => {
    state.selectedCurrency = event.target.value;
    clearError();
    if (localShowcaseActive) {
      render();
      return;
    }
    try {
      await loadDashboard();
    } catch (error) {
      showError(error.message);
    }
  });
  $("#mgr-search").addEventListener("input", (event) => {
    state.mgrSearch = event.target.value;
    renderMgrTable(getMonthTotals(state.selectedMonth).mgrRows);
  });
  $("#month-filter").addEventListener("change", (event) => {
    state.selectedMonth = event.target.value;
    render();
  });
  $("#sort-controls").addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (button) setSort(button.dataset.sort);
  });
  $(".records-table").addEventListener("click", (event) => {
    const button = event.target.closest(".th-btn[data-sort]");
    if (button) setSort(button.dataset.sort);
  });
  $("#direction").addEventListener("click", () => {
    state.ascending = !state.ascending;
    renderControls();
    refreshRecordsTable();
  });
  let recordScrollQueued = false;
  $("#rows").closest(".table-wrap").addEventListener("scroll", () => {
    if (recordScrollQueued) return;
    recordScrollQueued = true;
    requestAnimationFrame(() => {
      recordScrollQueued = false;
      renderTable(currentVisibleRecords);
    });
  }, { passive: true });
  let mgrScrollQueued = false;
  $("#mgr-rows").closest(".table-wrap").addEventListener("scroll", () => {
    if (mgrScrollQueued) return;
    mgrScrollQueued = true;
    requestAnimationFrame(() => {
      mgrScrollQueued = false;
      renderMgrRows(currentMgrRows);
    });
  }, { passive: true });
  $("#template").addEventListener("click", downloadTemplate);
  $("#csv-file").addEventListener("change", async (event) => {
    clearError();
    const [file] = event.target.files;
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    try {
      const result = await apiRequest("/api/imports", { method: "POST", body: form });
      await loadDashboard();
      await loadQuality();
      await loadReconciliation();
      await loadImportHistory();
      if (result.rejectedCount || result.duplicateCount) {
        showError(`Import ${result.status}: ${result.acceptedCount} accepted, ${result.rejectedCount} rejected, ${result.duplicateCount} duplicates. See import history and the review queue.`);
      }
    } catch (error) {
      showError(`Import failed. Existing records were not overwritten. ${error.message}`);
    } finally {
      event.target.value = "";
    }
  });
  $("#live-refresh").addEventListener("click", async () => {
    clearError();
    try {
      await loadDashboard();
    } catch (error) {
      showError(`Data refresh failed; the current view remains unchanged. ${error.message}`);
    }
  });
  $("#import-history").addEventListener("toggle", async (event) => {
    if (!event.currentTarget.open) return;
    if (localShowcaseActive) return;
    try {
      await loadImportHistory();
    } catch (error) {
      showError(error.message);
    }
  });
  $("#import-history-content").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-review-batch]");
    if (!button) return;
    try {
      const { rejections } = await apiRequest(`/api/imports/${encodeURIComponent(button.dataset.reviewBatch)}/rejections`);
      const details = rejections.map((item) =>
        `Row ${item.source_row_number}: ${item.error_message}`).join("\n");
      window.alert(details || "No rejected rows were recorded for this batch.");
    } catch (error) {
      showError(error.message);
    }
  });
}

async function main() {
  bindEvents();
  try {
    const sessionState = await apiRequest("/api/auth/session");
    demoMode = sessionState.demoMode === true;
    if (!sessionState.authenticated) {
      if (activateLocalShowcase()) return;
      clearDashboardData();
      setDashboardVisible(false);
      showError("Dashboard access is unavailable in this session. Enable local demo mode for a local preview.");
      return;
    }
    csrfToken = sessionState.csrfToken;
    setDashboardVisible(true);
    await loadDashboard();
    if (!localShowcaseActive) {
      await loadQuality();
      await loadReconciliation();
    }
  } catch (error) {
    if (activateLocalShowcase()) return;
    clearDashboardData();
    setDashboardVisible(false);
    showError(`Dashboard service unavailable. ${error.message}`);
  }
}

main();
