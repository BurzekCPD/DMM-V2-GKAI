import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { parseImportFile } from "./importer.js";

const headers = [
  "Month", "Tenant", "Tenant ID", "Company", "Brand", "Slot", "Station", "Station ID",
  "Data Type", "Currency", "Trips", "Quantity", "Tariff", "Total Amount", "Billing Status",
  "Annual Surcharge Rate", "Minimum Base Rent", "Unit", "Source Record ID",
];
const header = headers.join(",");

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function record(values = {}) {
  const defaults = {
    month: "2026-10",
    tenant: "Example Tenant",
    tenantId: "T-01",
    company: "Example Ltd",
    brand: "Example",
    slot: "S-01",
    station: "Station A",
    stationId: "",
    dataType: "Slot Revenue",
    currency: "IDR",
    trips: "",
    quantity: "1",
    tariff: "125000",
    totalAmount: "",
    billingStatus: "Billed",
    annualRate: "",
    minimumRent: "100000",
    unit: "",
    sourceRecordId: "SRC-001",
  };
  const item = { ...defaults, ...values };
  return [
    item.month, item.tenant, item.tenantId, item.company, item.brand, item.slot, item.station,
    item.stationId, item.dataType, item.currency, item.trips, item.quantity, item.tariff,
    item.totalAmount, item.billingStatus, item.annualRate, item.minimumRent, item.unit,
    item.sourceRecordId,
  ].map(csvEscape).join(",");
}

function csvFile(contents, name = "import.csv") {
  return { originalname: name, buffer: Buffer.from(contents, "utf8") };
}

function fileWithRows(...rows) {
  return `${header}\n${rows.join("\n")}`;
}

test("parses explicit currency and canonical source mapping", async () => {
  const result = await parseImportFile(csvFile(fileWithRows(record({ dataType: "slot_revenue" }))));
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].currency, "IDR");
  assert.equal(result.records[0].sourceRecordId, "SRC-001");
  assert.equal(result.records[0].tenantId, "T-01");
  assert.equal(result.records[0].stationId, "");
  assert.equal(result.rejected.length, 0);
});

test("rejects records without a source tenant identifier", async () => {
  const result = await parseImportFile(csvFile(fileWithRows(record({ tenantId: "" }))));
  assert.equal(result.records.length, 0);
  assert.match(result.rejected[0].message, /Tenant, Tenant ID, and Slot are required/);
});

test("rejects missing and malformed currencies rather than assuming a default", async () => {
  const missing = await parseImportFile(csvFile(
    "Month,Tenant,Slot,Data Type,Quantity,Tariff\n2026-10,Tenant,S-01,Slot Revenue,1,100",
  ));
  assert.equal(missing.records.length, 0);
  assert.match(missing.rejected[0].message, /Currency/);

  const malformed = await parseImportFile(csvFile(fileWithRows(record({ currency: "$IDR" }))));
  assert.equal(malformed.records.length, 0);
  assert.match(malformed.rejected[0].message, /currency code/i);
});

test("rejects mixed-currency uploads as a whole", async () => {
  const result = await parseImportFile(csvFile(fileWithRows(
    record({ sourceRecordId: "SRC-IDR" }),
    record({ currency: "USD", sourceRecordId: "SRC-USD" }),
  )));
  assert.equal(result.records.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.ok(result.rejected.every((item) => /more than one currency/.test(item.message)));
});

test("identical imports have stable ids and duplicate ids in one file are rejected", async () => {
  const row = record({ sourceRecordId: "" });
  const contents = fileWithRows(row);
  const first = await parseImportFile(csvFile(contents));
  const retry = await parseImportFile(csvFile(contents));
  assert.equal(first.records[0].sourceRecordId, retry.records[0].sourceRecordId);

  const repeatedId = record({ sourceRecordId: "SRC-SAME" });
  const duplicate = await parseImportFile(csvFile(fileWithRows(repeatedId, repeatedId)));
  assert.equal(duplicate.records.length, 1);
  assert.equal(duplicate.rejected.length, 1);
  assert.match(duplicate.rejected[0].message, /duplicate Source Record ID/);
});

test("validates plain decimal numeric formats and surcharge percentages", async () => {
  const invalid = await parseImportFile(csvFile(fileWithRows(record({ tariff: "1,000" }))));
  assert.equal(invalid.records.length, 0);
  assert.match(invalid.rejected[0].message, /plain decimal/);
  const invalidPercent = await parseImportFile(csvFile(fileWithRows(record({ tariff: "5%" }))));
  assert.equal(invalidPercent.records.length, 0);
  assert.match(invalidPercent.rejected[0].message, /plain decimal/);

  const surcharge = await parseImportFile(csvFile(fileWithRows(record({
    dataType: "Area Operational Surcharge",
    annualRate: "5%",
    sourceRecordId: "SUR-1",
  }))));
  assert.equal(surcharge.records[0].annualSurchargeRate, 0.05);

  const excessiveScale = await parseImportFile(csvFile(fileWithRows(record({ tariff: "1.12345" }))));
  assert.equal(excessiveScale.records.length, 0);
  assert.match(excessiveScale.rejected[0].message, /at most 4 decimal places/);
});

test("rejects every row with a conflicting MGR value for the same month and slot", async () => {
  const first = record({ minimumRent: "100000", sourceRecordId: "MGR-1" });
  const second = record({ minimumRent: "110000", sourceRecordId: "MGR-2" });
  const result = await parseImportFile(csvFile(fileWithRows(first, second)));
  assert.equal(result.records.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.ok(result.rejected.every((item) => /conflicting Minimum Base Rent/.test(item.message)));
});

test("reads supported Excel workbooks through the same validation layer", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Data").addRow(headers);
  workbook.worksheets[0].addRow([
    "2026-10", "Example Tenant", "T-01", "Example Ltd", "Example", "S-01", "Station A", "",
    "Slot Revenue", "IDR", "", 1, 125000, "", "Billed", "", 100000, "", "XLS-1",
  ]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const result = await parseImportFile({ originalname: "import.xlsx", buffer });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].sourceRecordId, "XLS-1");
});
