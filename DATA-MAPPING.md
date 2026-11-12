# Canonical data mapping

The mapping file is [server/config/field-mappings.json](./server/config/field-mappings.json). Manual CSV/Excel field aliases are configurable there; field names are normalized for case, spaces, and hyphens. The mapping is not a claim that the listed columns exist in any external system.

## Manual reporting import

Required: `Month` (`YYYY-MM`), `Tenant`, `Tenant ID`, `Slot`, `Data Type`, and `Currency` (three-letter ISO code). Recommended: stable `Source Record ID`, `Station`, `Station ID`, `Company`, and `Brand`.

| Canonical field | Accepted manual aliases | Notes |
|---|---|---|
| reporting month | Month, Reporting Month, Billing Period | Required; first day stored as the period key |
| tenant / tenant ID | Tenant, Tenant Name / Tenant ID, Tenant Code | Both tenant name and source tenant ID are required; missing IDs are rejected rather than fabricated |
| slot | Slot, Slot ID, Commercial Slot ID | Required |
| station / station ID | Station, Station Name / Station ID, Station Code | Missing station ID is accepted but flagged by data quality; station names are not treated as identifiers |
| data type | Data Type, Record Type | Must match an existing supported dashboard type |
| currency | Currency, Currency Code | Required on every row; one currency per file |
| transaction count | Trips, Transaction Count | Nonnegative decimal |
| quantity | Quantity, Area, Consumption | Nonnegative decimal |
| tariff | Tariff, Unit Rate | Nonnegative decimal; its unit semantics require business confirmation |
| original amount | Total Amount, Amount, Transaction Value | Nonnegative decimal; retained with the original currency |
| billing state | Billing Status, Status | Billed, Unbilled, or Not applicable |
| surcharge rate | Annual Surcharge Rate | Decimal (for example `0.05`) or percent (`5%`) |
| minimum rent | Minimum Base Rent, Minimum Guaranteed Revenue | Nonnegative decimal |
| source identity | Source Record ID, Record ID, Transaction ID | Recommended; omission uses file SHA-256 plus row number |

Amounts and quantities must be plain decimal strings with no thousands separators or currency symbols, with at most four decimal places; annual surcharge rates allow up to eight. Higher precision is rejected rather than rounded to fit the database columns. Excel `.xlsx` cells are read as displayed text and then passed through the same validation.

## POS connector requirements (not configured)

The source-specific adapter must map transaction ID, transaction timestamp, station ID, tenant ID, commercial-slot ID, transaction count/value, applicable tariff, transaction status, reversal/cancellation status, source-system reference, and explicit currency. The authorized source owner must provide API/database documentation, field semantics, an approved test environment, credentials via server-only environment/secret storage, and a reliable incremental change key.

## Billing connector requirements (not configured)

Map tenant ID/name, company, brand, station ID, commercial-slot ID, billing period, base rental, MGR, service charge, area operational surcharge, invoice number/amount, billing state, payment state, outstanding amount, invoice date, payment date, and currency. Payment-level identifiers, dates, values, statuses, and invoice linkage are needed for collection reconciliation.

Unavailable source fields must remain unavailable/rejected or explicitly nullable according to the agreed mapping; do not infer source column names or silently substitute another field.

The current slot dimension uses `Slot` as a globally unique key. Until the schema is revised to use source-specific composite slot identities, imports must use canonical globally unique slot IDs. Conflicting tenant/station associations are shown in data quality, and the first dimension association is not overwritten by later imports; dashboard fact rows retain their imported station and tenant snapshots.
