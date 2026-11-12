# Financial calculations and reconciliation assumptions

## Currency and units

- The reporting currency preference is IDR, but every imported row must carry its own three-letter currency code.
- The localhost tenant-snapshot showcase lacks a source currency field; IDR is an explicitly labeled preview assumption, not validated currency metadata.
- The API does not mix currencies: a user must select one currency if multiple are present.
- No USD default or exchange-rate conversion remains in the dashboard. Production/backend records display in full original currency units; the separately labeled localhost showcase applies the threshold-based display abbreviation documented below.
- Database fields retain original amount/currency. Exchange-rate records require source, effective date, and approver; no conversion workflow is currently enabled.
- Frontend display uses the selected ISO currency; electricity and water show their supplied unit rather than currency.

## Preserved formulas — confirmation required

The existing formulas were not reinterpreted as approved accounting policy:

1. **RTC amount:** `trips × tariff`.
2. **Slot revenue:** `(quantity or 1) × tariff`.
3. **Service charge:** `(quantity or 1) × 4.5 × tariff`. The area factor `4.5` and tariff-per-area assumption need confirmation.
4. **Area operational surcharge:** `(quantity or 1) × tariff × annual rate ÷ 365 × actual days in month`. Confirm whether this annualization and day-count basis are contractually correct.
5. **Forecast target:** `quantity × tariff`.
6. **Billed/unbilled realization:** explicit realization records take precedence per month; otherwise the current logic sums RTC, slot revenue, service charge, and area surcharge rows marked with that billing status. This derivation can overstate realization if source rows represent overlapping amounts; do not treat it as recognized revenue without reconciliation.
7. **MGR fulfillment:** per slot, sum slot-revenue rows and compare against supplied minimum base rent; service charges are excluded. Confirm period proration, credits, and amendments with the business owner.

These are retained to avoid silently changing commercial rules. Source mappings should provide already-calculated amounts where the source is authoritative, but the canonical dashboard still needs a business-approved rule for which amount is authoritative for each data type.

## Revenue groups and double-counting guardrails

- The composition chart now includes only slot revenue, service charge, and area operational surcharge. RTC, forecast, and billed/unbilled realization are excluded from that composition chart.
- The summary retains separate legacy measure cards. It does not add a new “total recognized revenue” because source accounting definitions are unavailable.
- Forecast achievement currently compares the separate billed plus unbilled realization measures to the forecast. This is a presentation metric, not proof that recognized, billed, or collected revenue are equivalent.
- No collected revenue, receivable, collection-rate, or total recognized-revenue KPI is calculated from the available manual record schema. Those require invoice/payment identifiers, statuses, dates, and approved accounting treatment.
- `REVENUE_DISPLAY_DIVISOR` and the USD-to-IDR constant were removed; all monetary display is in the selected original currency at full displayed unit.

## Local tenant snapshot showcase

- The local showcase maps the snapshot's supplied `baseRent` and `serviceCharge` values directly to slot-rent and service-charge display records. It does not fabricate revenue because both fields are present.
- The snapshot has no reporting period, source currency, invoice status, MGR, or POS data. The UI labels November 2026 and IDR as display assumptions, sets billing status to not applicable, and does not synthesize forecast, utility, or transaction data.
- For the showcase only, when an individual amount's absolute value is greater than IDR 1,000,000, display divides that value by 1,000; values at or below the threshold display in full IDR. Monetary views do not append a unit word. Source fixture values are not changed, but this mixed-unit display is not suitable for financial reporting.

## Reconciliation status

POS-to-source totals, invoice totals, payment matching, approved-financial-source totals, credit/reversal treatment, and closing-period controls cannot be reconciled until real source data and expected totals are provided. The schema provides reconciliation result storage, but no synthetic successful result is created.

The current JavaScript calculation layer uses floating-point numbers. It should not be treated as an audited ledger or used as a final settlement/close calculation until decimal precision, rounding policy, and the commercial rules above are approved and tested against source totals.
