# Executive Revenue & Station Performance Dashboard

This project is a single-owner dashboard with a vanilla-JavaScript frontend, Express API, and PostgreSQL reporting store. Local demo mode skips sign-in only on loopback; production remains private and authenticated. The backend is the only component allowed to access the database. It serves only an explicit allowlist of frontend files; it does not serve the repository directory.

## Current status

- The frontend has no sign-in screen. Local demo mode is restricted to localhost; outside demo mode, reporting APIs still require the backend's authenticated owner session. An authenticated sign-in client is not currently included.
- When the backend is unavailable, the dashboard displays an explicitly labeled local showcase sourced from `tenant-data.js` on localhost. It maps the snapshot's base rent and service charge into display records without inventing revenue. The source does not identify a reporting period or currency, so the showcase labels November 2026 and IDR as assumptions and disables imports/live connections.
- Manual CSV and `.xlsx` import with required currency, field alias mapping, row-level rejection records, duplicate detection, and source-file/row provenance.
- Initial PostgreSQL schema for source records, reporting facts, POS, tenant billing, payments, utilities, reconciliation, imports, and audit history.
- POS and tenant billing connectors are intentionally **unconfigured**. No live source has been contacted or verified.
- The import template preserves the dashboard's reporting-oriented record fields, but existing browser-local data is not automatically migrated; re-import only authorized source files through the private backend. No browser-side tenant snapshot or USD assumption is used.
- Financial calculations preserve the current service-charge, surcharge, realization, and MGR behavior; see [FINANCIAL-RULES.md](./FINANCIAL-RULES.md) for formulas requiring business confirmation.

## Requirements and local setup

- Node.js 20 or later and npm.
- PostgreSQL 14 or later.
- For local demo, copy `.env.example` to `.env` and set `DATABASE_URL`; keep `DEMO_MODE=true` and `HOST=127.0.0.1`. Demo mode is loopback-only and must not be exposed to a network.
- To preview the UI without Node.js, npm, or PostgreSQL, run `python demo-server.py` and open `http://127.0.0.1:8000`. This serves only an allowlist of front-end files and tenant-snapshot showcase records.
- For any non-demo deployment, set `DEMO_MODE=false`, a strong random `SESSION_SECRET`, `DATABASE_URL`, and `DASHBOARD_PASSWORD_HASH`.
- Generate a bcrypt hash using `npm run password-hash`; paste its output into `.env` locally. Never put a plaintext password in source control or frontend configuration.
- Create a least-privilege database role and database, then run `npm install` and `npm run migrate`.
- Run `npm start` and open the printed local URL. The default bind address is loopback (`127.0.0.1`).

Production deployment must use `DEMO_MODE=false`, HTTPS, `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, and an explicitly configured trusted proxy only when one is present. See [DEPLOYMENT.md](./DEPLOYMENT.md).

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — architecture and API overview.
- [DATA-MAPPING.md](./DATA-MAPPING.md) — canonical fields and source mapping.
- [FINANCIAL-RULES.md](./FINANCIAL-RULES.md) — preserved calculations and reconciliation assumptions.
- [DEPLOYMENT.md](./DEPLOYMENT.md) — environment, database, backup, restore, and troubleshooting.
- [API.md](./API.md) — API contracts.

## Validation

Run `npm test` for import and financial-calculation tests after installing dependencies. Tests and live database migrations have not been run in the current environment because Node.js/npm and PostgreSQL are not installed or configured.
