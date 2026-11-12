export const SERVICE_CHARGE_AREA = 4.5;

const realizationComponents = new Set([
  "Revenue Trip Count (RTC)",
  "Slot Revenue",
  "Service Charge",
  "Area Operational Surcharge",
]);

export function daysInMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

export function calculateAmount(record) {
  if (record.amountOverride !== undefined && record.amountOverride !== null) return record.amountOverride;
  switch (record.dataType) {
    case "Revenue Trip Count (RTC)":
      return record.trips * record.tariff;
    case "Slot Revenue":
      return (record.quantity ?? 1) * record.tariff;
    case "Service Charge":
      return (record.quantity ?? 1) * SERVICE_CHARGE_AREA * record.tariff;
    case "Area Operational Surcharge":
      return (record.quantity ?? 1) * record.tariff * record.annualSurchargeRate / 365 * daysInMonth(record.month);
    case "Revenue Forecast Target":
      return record.quantity * record.tariff;
    case "Realisation (Billed)":
    case "Utility Cost":
      return record.totalAmount;
    case "Realisation (Unbilled)":
      if (record.totalAmount !== null) return record.totalAmount;
      return (record.trips ?? record.quantity) * record.tariff;
    case "Electricity Usage":
    case "Water Usage":
      return record.quantity;
    default:
      return 0;
  }
}

export function calculateRealisation(records, type) {
  const explicit = records.filter((record) => record.dataType === type);
  if (explicit.length) return explicit.reduce((total, record) => total + calculateAmount(record), 0);

  const status = type === "Realisation (Billed)" ? "billed" : "unbilled";
  return records
    .filter((record) => realizationComponents.has(record.dataType)
      && String(record.billingStatus || "").toLowerCase() === status)
    .reduce((total, record) => total + calculateAmount(record), 0);
}

export function isMgrFulfilled(slotRevenue, minimumBaseRent) {
  return slotRevenue >= minimumBaseRent;
}
