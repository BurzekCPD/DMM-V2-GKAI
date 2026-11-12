# Architecture and integration status

## Data flow

```text
Authorized POS / billing sources (not supplied)
                   │ future source-specific adapters
Manual CSV / .xlsx ├──> Express validation and mapping
                   │          │
                   │          ├── rejected rows + reasons
                   │          └── transactional, idempotent inserts
                   ▼
             PostgreSQL reporting store
                   │ authenticated, parameterized API
                   ▼
         Existing HTML/CSS/vanilla-JS dashboard
```

The browser never connects directly to PostgreSQL or to an operational system. Express serves only an explicit frontend allowlist; it does not expose the original `tenant-data.js`, migration files, server source, environment files, or repository directory listings. The transformed `demo-data.js` snapshot is served by Express only for non-production loopback requests when `DEMO_MODE=true`; otherwise that route returns no content.

## Security boundary

- Local demo mode is an explicit opt-in (`DEMO_MODE=true`) that skips sign-in only outside production. It accepts requests only from loopback addresses and the server refuses to bind to a non-local host in this mode. Do not expose demo mode to a network.
- The frontend has no sign-in screen. Production/non-demo APIs require an owner session and exactly one configured owner password hash; there is no registration or user-management UI. The backend retains bcrypt verification, rate-limited login, session-ID regeneration, PostgreSQL-backed sessions, HttpOnly/SameSite cookies, CSRF tokens for authenticated mutations, and same-origin checks. A sign-in client must be provided before using the protected frontend outside local demo mode.
- Credentials are read by the backend from environment variables. `config.js` contains only the reporting-currency display preference.
- `DEMO_MODE` is rejected in production. HTTPS and a secure session cookie are required in production. Keep PostgreSQL private and grant the application role only the required schema access.
- `demo-data.js` contains a local showcase transformation of the legacy tenant snapshot (base rent and service charge). It is not served to remote clients; do not publish the repository root through a separate static host.

## Storage and provenance

`server/migrations/001_initial_schema.sql` creates normalized station, tenant, slot, POS transaction, billing invoice/item, payment, operational, and utility tables, plus reporting records, import batches/rejections, source registry, sync/reconciliation logs, approved exchange-rate records, audit logs, and sessions.

Reporting rows retain source ID, source record ID, original filename, row number, source hash, original amount, currency, and import timestamp. Repeating an identical file uses deterministic file-hash/row-number IDs when the user has not supplied a stable ID. A source-record ID conflict is ignored as a duplicate; existing financial values are never updated by a repeated import.

The reporting API currently reads manually imported canonical dashboard records. The specialized operational tables are ready for source-specific adapters but are not populated by any claimed live integration.

## Connectors and synchronization

`server/connectors/index.js` reports POS and billing connectors as unconfigured and returns an explicit unavailable response to a manual sync request. No endpoint, credential, source schema, incremental cursor, retry schedule, or successful sync is fabricated. Scheduling should only be enabled after source access, capacity, and field semantics are agreed. The proposed cadence is POS every five minutes and billing every fifteen minutes/on source events.

## Reporting API

See [API.md](./API.md). All data and import endpoints require the authenticated session. The dashboard endpoint refuses to aggregate multiple currencies without an explicit currency selection and refuses to return a partial dataset above its 100,000-row API limit.

## Known design limits

- Reconciliation with POS/source totals, invoice totals, and payments is not available until actual source totals and data are supplied.
- The tenant/slot foreign keys are populated from imported values; they do not prove a match against an authoritative registry. The quality view explicitly reports this limitation.
- The initial slot dimension uses a globally unique slot key. If a source reuses slot labels across tenants or stations, imports need canonical unique IDs; conflicting associations are surfaced and do not overwrite the first stored dimension mapping.
- The existing client-side financial formulas use JavaScript numbers. Imports are bounded to the safe integer range, but those formulas are not an audited accounting engine; confirm precision and business rules before using results for closing or settlement.
- The showcase snapshot contains no reporting month or currency. Its November 2026 period and IDR currency are clearly marked display assumptions, not source-system facts. Base rent is used for the slot-rent view and service charge is displayed as supplied; neither is validated as recognized revenue. For showcase display only, amounts with an absolute value above 1,000,000 are divided by 1,000 without appending a unit word. Fixture amounts remain unscaled. The threshold causes mixed display units and must not be used for financial reporting.
- Year-on-year/year-to-date analysis, station month-on-month comparisons, and billing/collection KPIs are not yet implemented; adding them requires defined periods and source-backed invoice/payment data.
- Exchange-rate schema exists for approved conversion provenance, but conversion is deliberately not implemented. Original currencies are kept separate.
- No production authentication, database, backup restore, or source integration test has been performed in this workspace.
