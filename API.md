# API contracts

All endpoints are same-origin. Responses containing financial or session data use `Cache-Control: no-store`. Outside local demo mode, all endpoints except `/health` require the private owner session, and mutations require `X-CSRF-Token` from `/api/auth/session` or a successful login. With `DEMO_MODE=true`, sign-in and CSRF are disabled only for loopback requests; the mode is rejected in production and the server cannot bind to a non-loopback host. Do not expose demo mode to a network. No CORS access is configured.

## Authentication

### `GET /api/auth/session`

Returns `{ "authenticated": boolean, "csrfToken": string | null, "demoMode": boolean }`. In local demo mode, `authenticated` is `true`, `csrfToken` is `null`, and login/logout are disabled.

### `POST /api/auth/login`

JSON body: `{ "password": "..." }`. Returns `{ "authenticated": true, "csrfToken": "..." }`. Login is rate limited; there is no registration endpoint.

### `POST /api/auth/logout`

Authenticated and CSRF-protected; returns `204`.

## Reporting and import

### `GET /api/dashboard?currency=IDR`

Returns `{ records, currencies, currencyRequired, reportingCurrency, totalRecords, lastSuccessfulSync, lastImportedAt, sources }`. Source entries include `configured` and `implemented`; schedules remain unset until a source adapter is implemented. `currency` is optional only when the stored dataset contains zero or one currency. For a multi-currency dataset, an omitted currency returns no records and `currencyRequired: true`. No exchange-rate conversion occurs.

Each record contains `month`, `station`, `stationId`, `tenant`, `tenantId`, `company`, `brand`, `slot`, `dataType`, `trips`, `quantity`, `tariff`, `totalAmount`, `currency`, `billingStatus`, `annualSurchargeRate`, `minimumBaseRent`, `unit`, `source`, `sourceRecordId`, `sourceFile`, `sourceRowNumber`, and `importedAt`.

The endpoint returns an error rather than a partial result when more than 100,000 filtered rows would be returned.

### `POST /api/imports`

Multipart form field `file`, CSV or `.xlsx`, maximum size controlled by `MAX_UPLOAD_BYTES` (default 5 MiB) and 100,000 data rows. Each row requires Month, Tenant, Tenant ID, Slot, Data Type, and one explicit ISO 4217 currency per upload. Valid rows are committed in one database transaction; invalid rows are retained in the rejection queue. Existing records are not updated. Returns batch ID, status, accepted, rejected, and duplicate counts.

### `GET /api/imports`

Returns the latest 100 import batches with source file, currency, status, counts, and timestamps.

### `GET /api/imports/:batchId/rejections`

Returns rejected row numbers, validation explanations, and captured source row values for authorized review.

### `GET /api/quality`

Returns missing station identifiers, required amount and surcharge gaps, rejected-row count, currency distribution, conflicting slot-ID associations, and a clear statement that authoritative tenant/slot matching is unavailable. Imports reject rows without a tenant identifier rather than substituting the tenant name.

### `GET /api/reconciliation?month=YYYY-MM`

Returns recorded reconciliation results and explicit blockers for POS totals, invoice/payment matching, and approved control totals. Until source data and control totals exist, `results` is empty; no successful reconciliation is implied.

## Source synchronization

### `GET /api/sync/status`

Returns source-connector configuration and last recorded sync outcomes. Unconfigured connectors have no scheduled time.

### `POST /api/sync/pos` and `POST /api/sync/tenant_billing`

Currently return `503` with the list of source fields/access dependencies required. The request is logged as skipped; no source is contacted.

## Health

### `GET /health`

Returns `{ "status": "ok" }` for process-level health only. It does not disclose database or connector state.
