import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";

const mappingsPath = fileURLToPath(new URL("./config/field-mappings.json", import.meta.url));
const mappings = JSON.parse(readFileSync(mappingsPath, "utf8"));
const supportedCurrencyCodes = new Set(Intl.supportedValuesOf("currency"));
const MAX_IMPORT_ROWS = 100_000;

const supportedTypes = new Set([
  "Revenue Trip Count (RTC)",
  "Slot Revenue",
  "Service Charge",
  "Area Operational Surcharge",
  "Revenue Forecast Target",
  "Realisation (Unbilled)",
  "Realisation (Billed)",
  "Electricity Usage",
  "Water Usage",
  "Utility Cost",
]);
const billingStatuses = new Set(["Billed", "Unbilled", "Not applicable"]);

function canonicalType(value) {
  const normalized = String(value).trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return [...supportedTypes].find((type) =>
    type.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ") === normalized);
}

function normalizedKey(value) {
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function parseCurrency(value, field, optional = false) {
  if ((value === undefined || value === null || String(value).trim() === "") && optional) return null;
  const text = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(text) || !supportedCurrencyCodes.has(text)) {
    throw new Error(`${field} must be an explicit valid ISO 4217 currency code.`);
  }
  return text;
}

function parseNumber(value, field, rowNumber, {
  required = false,
  nonNegative = false,
  scale = 4,
  allowPercent = false,
} = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (required) throw new Error(`Row ${rowNumber}: ${field} is required.`);
    return null;
  }
  const rawText = String(value).trim();
  const hasPercent = rawText.endsWith("%");
  if (hasPercent && !allowPercent) {
    throw new Error(`Row ${rowNumber}: ${field} must be a plain decimal number without currency or grouping symbols.`);
  }
  const text = hasPercent ? rawText.slice(0, -1) : rawText;
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(`Row ${rowNumber}: ${field} must be a plain decimal number without currency or grouping symbols.`);
  }
  if ((text.split(".")[1] || "").length > scale) {
    throw new Error(`Row ${rowNumber}: ${field} supports at most ${scale} decimal places.`);
  }
  const result = Number(text);
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Row ${rowNumber}: ${field} is outside the supported numeric range.`);
  }
  const parsed = hasPercent ? result / 100 : result;
  if (nonNegative && parsed < 0) throw new Error(`Row ${rowNumber}: ${field} cannot be negative.`);
  return parsed;
}

function canonicalize(raw, rowNumber, sourceRecordId, sourceHash) {
  const aliases = mappings.manual_csv;
  const normalized = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [normalizedKey(key), value]),
  );
  const value = (field) => {
    for (const alias of aliases[field] || [field]) {
      const key = normalizedKey(alias);
      if (normalized[key] !== undefined && String(normalized[key]).trim() !== "") return normalized[key];
    }
    return "";
  };
  const month = String(value("month")).trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error(`Row ${rowNumber}: Month must use YYYY-MM format.`);
  }
  const tenantName = String(value("tenant")).trim();
  const tenantId = String(value("tenant_id")).trim();
  const slotId = String(value("slot")).trim();
  const dataType = canonicalType(value("data_type"));
  const currency = parseCurrency(value("currency"), "Currency");
  if (!tenantName || !tenantId || !slotId) {
    throw new Error(`Row ${rowNumber}: Tenant, Tenant ID, and Slot are required.`);
  }
  if (!dataType) throw new Error(`Row ${rowNumber}: unsupported Data Type "${value("data_type")}".`);

  const billingValue = String(value("billing_status") || "Not applicable").trim().toLowerCase();
  const billingStatus = [...billingStatuses].find((status) => status.toLowerCase() === billingValue);
  if (!billingStatus) throw new Error(`Row ${rowNumber}: Billing Status must be Billed, Unbilled, or Not applicable.`);
  const record = {
    month,
    tenantName,
    tenantId,
    company: String(value("company") || "").trim(),
    brand: String(value("brand") || "").trim(),
    slotId,
    stationName: String(value("station") || value("station_id") || "").trim(),
    stationId: String(value("station_id") || "").trim(),
    dataType,
    currency,
    trips: parseNumber(value("trips"), "Trips", rowNumber, { nonNegative: true }),
    quantity: parseNumber(value("quantity"), "Quantity", rowNumber, { nonNegative: true }),
    tariff: parseNumber(value("tariff"), "Tariff", rowNumber, { nonNegative: true }),
    totalAmount: parseNumber(value("total_amount"), "Total Amount", rowNumber, { nonNegative: true }),
    billingStatus,
    annualSurchargeRate: parseNumber(value("annual_surcharge_rate"), "Annual Surcharge Rate", rowNumber, {
      nonNegative: true,
      scale: 8,
      allowPercent: true,
    }),
    minimumBaseRent: parseNumber(value("minimum_base_rent"), "Minimum Base Rent", rowNumber, { nonNegative: true }),
    unit: String(value("unit") || "").trim(),
    sourceRecordId: String(value("source_record_id") || sourceRecordId).trim(),
    sourceHash,
    sourceRowNumber: rowNumber,
  };
  if (record.dataType === "Revenue Trip Count (RTC)" && (record.trips === null || record.tariff === null)) {
    throw new Error(`Row ${rowNumber}: RTC requires Trips and Tariff.`);
  }
  if (["Slot Revenue", "Service Charge", "Area Operational Surcharge", "Revenue Forecast Target"].includes(record.dataType)
    && record.tariff === null) {
    throw new Error(`Row ${rowNumber}: ${record.dataType} requires Tariff.`);
  }
  if (record.dataType === "Area Operational Surcharge" && record.annualSurchargeRate === null) {
    throw new Error(`Row ${rowNumber}: Area Operational Surcharge requires Annual Surcharge Rate.`);
  }
  if (record.dataType === "Revenue Forecast Target" && record.quantity === null) {
    throw new Error(`Row ${rowNumber}: Revenue Forecast Target requires Quantity.`);
  }
  if (["Realisation (Billed)", "Utility Cost"].includes(record.dataType) && record.totalAmount === null) {
    throw new Error(`Row ${rowNumber}: ${record.dataType} requires Total Amount.`);
  }
  if (record.dataType === "Realisation (Unbilled)" && record.totalAmount === null
    && !(record.trips !== null && record.tariff !== null)
    && !(record.quantity !== null && record.tariff !== null)) {
    throw new Error(`Row ${rowNumber}: Unbilled Realisation requires Total Amount or Trips/Quantity with Tariff.`);
  }
  if (["Electricity Usage", "Water Usage"].includes(record.dataType) && record.quantity === null) {
    throw new Error(`Row ${rowNumber}: ${record.dataType} requires Quantity.`);
  }
  return record;
}

function currencyInRow(raw) {
  const normalized = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [normalizedKey(key), value]),
  );
  for (const alias of mappings.manual_csv.currency) {
    const value = normalized[normalizedKey(alias)];
    if (value !== undefined && String(value).trim() !== "") {
      try {
        return parseCurrency(value, "Currency");
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function readRows(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === ".csv") {
    const parsed = parse(file.buffer, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      info: true,
      to: MAX_IMPORT_ROWS + 2,
    })
      .map(({ record, info }) => ({ raw: record, rowNumber: info.lines }));
    if (parsed.length > MAX_IMPORT_ROWS) {
      throw new Error(`An import may contain no more than ${MAX_IMPORT_ROWS.toLocaleString()} data rows.`);
    }
    return parsed;
  }
  if (extension === ".xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) throw new Error("The Excel file needs a header row and at least one data row.");
    if (sheet.rowCount - 1 > MAX_IMPORT_ROWS) {
      throw new Error(`An import may contain no more than ${MAX_IMPORT_ROWS.toLocaleString()} data rows.`);
    }
    const headers = sheet.getRow(1).values.slice(1).map((value) => String(value ?? "").trim());
    if (headers.some((header) => !header)) throw new Error("Excel header cells must not be blank.");
    const rows = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const item = {};
      headers.forEach((header, index) => {
        const cell = row.getCell(index + 1);
        item[header] = cell.text ?? "";
      });
      if (Object.values(item).some((value) => String(value).trim() !== "")) rows.push({ raw: item, rowNumber });
    });
    return rows;
  }
  throw new Error("Upload a CSV or Excel .xlsx file.");
}

export async function parseImportFile(file) {
  const fileHash = createHash("sha256").update(file.buffer).digest("hex");
  const rows = await readRows(file);
  if (!rows.length) throw new Error("The file must include a header and at least one data row.");
  const imported = [];
  const rejected = [];
  const currencies = new Set();
  const seenIds = new Set();
  for (const { raw, rowNumber } of rows) {
    const rowCurrency = currencyInRow(raw);
    if (rowCurrency) currencies.add(rowCurrency);
    const sourceHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    const generatedId = `${fileHash}:${rowNumber}`;
    try {
      const record = canonicalize(raw, rowNumber, generatedId, sourceHash);
      if (seenIds.has(record.sourceRecordId)) {
        throw new Error(`Row ${rowNumber}: duplicate Source Record ID "${record.sourceRecordId}" in this file.`);
      }
      seenIds.add(record.sourceRecordId);
      imported.push({ ...record, raw });
    } catch (error) {
      rejected.push({ rowNumber, message: error.message, raw });
    }
  }
  const minimumRents = new Map();
  for (const record of imported) {
    if (record.minimumBaseRent === null) continue;
    const key = `${record.month}\u0000${record.tenantId}\u0000${record.slotId}`;
    if (!minimumRents.has(key)) minimumRents.set(key, []);
    minimumRents.get(key).push(record);
  }
  const conflictingRents = new Set();
  for (const rentRecords of minimumRents.values()) {
    if (new Set(rentRecords.map((record) => record.minimumBaseRent)).size < 2) continue;
    for (const record of rentRecords) {
      conflictingRents.add(record);
      rejected.push({
        rowNumber: record.sourceRowNumber,
        message: `Row ${record.sourceRowNumber}: conflicting Minimum Base Rent for ${record.month}, tenant ${record.tenantId}, slot ${record.slotId}.`,
        raw: record.raw,
      });
    }
  }
  for (let index = imported.length - 1; index >= 0; index -= 1) {
    if (conflictingRents.has(imported[index])) imported.splice(index, 1);
  }
  const mixedCurrencies = currencies.size > 1;
  if (mixedCurrencies) {
    imported.forEach((record) => rejected.push({
      rowNumber: record.sourceRowNumber,
      message: "This upload contains more than one currency. Split it into one-currency files; no rows were imported.",
      raw: record.raw,
    }));
    imported.length = 0;
  }
  return {
    fileHash,
    records: imported,
    rejected,
    currency: currencies.size === 1 ? [...currencies][0] : null,
  };
}
