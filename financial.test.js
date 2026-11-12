import assert from "node:assert/strict";
import test from "node:test";
import { calculateAmount, calculateRealisation, daysInMonth, isMgrFulfilled } from "./financial.js";

test("keeps the existing RTC, slot, and service-charge formulas unchanged", () => {
  assert.equal(calculateAmount({ dataType: "Revenue Trip Count (RTC)", trips: 5, tariff: 20 }), 100);
  assert.equal(calculateAmount({ dataType: "Slot Revenue", quantity: 2, tariff: 50 }), 100);
  assert.equal(calculateAmount({ dataType: "Service Charge", quantity: 2, tariff: 10 }), 90);
});

test("uses actual calendar days in the retained surcharge calculation", () => {
  assert.equal(daysInMonth("2024-02"), 29);
  assert.equal(daysInMonth("2025-02"), 28);
  assert.equal(calculateAmount({
    month: "2024-02",
    dataType: "Area Operational Surcharge",
    quantity: 1,
    tariff: 365,
    annualSurchargeRate: 1,
  }), 29);
});

test("prefers explicit realization and derives only when explicit rows are absent", () => {
  const rows = [
    { dataType: "Slot Revenue", quantity: 1, tariff: 100, billingStatus: "Billed" },
    { dataType: "Revenue Trip Count (RTC)", trips: 2, tariff: 10, billingStatus: "Unbilled" },
    { dataType: "Realisation (Billed)", totalAmount: 80 },
  ];
  assert.equal(calculateRealisation(rows, "Realisation (Billed)"), 80);
  assert.equal(calculateRealisation(rows, "Realisation (Unbilled)"), 20);
});

test("MGR comparison includes the minimum boundary", () => {
  assert.equal(isMgrFulfilled(100, 100), true);
  assert.equal(isMgrFulfilled(99.99, 100), false);
});
