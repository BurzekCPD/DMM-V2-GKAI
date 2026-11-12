import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import connectPgSimple from "connect-pg-simple";
import express from "express";
import { rateLimit } from "express-rate-limit";
import session from "express-session";
import helmet from "helmet";
import multer from "multer";
import { pool } from "./db.js";
import { parseImportFile } from "./importer.js";
import { connectorStatus, getConnector } from "./connectors/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const app = express();
const PgSessionStore = connectPgSimple(session);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024);
const MAX_IMPORT_ROWS = 100_000;
const DEMO_MODE = process.env.DEMO_MODE === "true";
const SESSION_SECRET = process.env.SESSION_SECRET;
const DASHBOARD_PASSWORD_HASH = process.env.DASHBOARD_PASSWORD_HASH;
const supportedCurrencyCodes = new Set(Intl.supportedValuesOf("currency"));
const reportingCurrency = (process.env.REPORTING_CURRENCY || "IDR").toUpperCase();

if (DEMO_MODE && process.env.NODE_ENV === "production") {
  throw new Error("DEMO_MODE cannot be enabled in production.");
}
if (!DEMO_MODE) {
  if (!SESSION_SECRET || SESSION_SECRET.length < 32 || /replace-with/i.test(SESSION_SECRET)) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
  if (!DASHBOARD_PASSWORD_HASH || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(DASHBOARD_PASSWORD_HASH)) {
    throw new Error("DASHBOARD_PASSWORD_HASH must be a bcrypt password hash; public registration is disabled.");
  }
}
if (process.env.NODE_ENV === "production" && process.env.SESSION_COOKIE_SECURE !== "true") {
  throw new Error("SESSION_COOKIE_SECURE=true is required in production.");
}
if (!Number.isSafeInteger(MAX_UPLOAD_BYTES) || MAX_UPLOAD_BYTES < 1) {
  throw new Error("MAX_UPLOAD_BYTES must be a positive integer.");
}
if (!supportedCurrencyCodes.has(reportingCurrency)) {
  throw new Error("REPORTING_CURRENCY must be a supported ISO 4217 currency code.");
}
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use((req, res, next) => {
  if (!DEMO_MODE) return next();
  const remoteAddress = req.socket.remoteAddress?.replace(/^::ffff:/i, "");
  if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1") {
    return res.status(403).json({ error: "Local demo mode is available only from this machine." });
  }
  next();
});
app.use(express.json({ limit: "64kb" }));
if (!DEMO_MODE) {
  app.use(session({
    name: "executive_dashboard_session",
    store: new PgSessionStore({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: false,
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.SESSION_COOKIE_SECURE === "true",
      sameSite: "strict",
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
    },
  }));
}
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

function requireAuth(req, res, next) {
  if (DEMO_MODE) return next();
  if (!req.session.user) return res.status(401).json({ error: "Authentication required." });
  next();
}

function assertSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
    return res.status(403).json({ error: "Cross-origin requests are not allowed." });
  }
  next();
}

function requireCsrf(req, res, next) {
  if (DEMO_MODE) return next();
  const provided = req.get("x-csrf-token");
  const expected = req.session.csrfToken;
  if (!provided || !expected) return res.status(403).json({ error: "CSRF token is required." });
  const supplied = Buffer.from(provided);
  const stored = Buffer.from(expected);
  if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) {
    return res.status(403).json({ error: "CSRF token is invalid." });
  }
  next();
}

function audit(action, details = {}, batchId = null, sourceId = null) {
  return pool.query(
    `INSERT INTO audit_logs (action, details, batch_id, source_id)
     VALUES ($1, $2::jsonb, $3, $4)`,
    [action, JSON.stringify(details), batchId, sourceId],
  );
}

function mapRecord(row) {
  return {
    month: row.month,
    station: row.station_name || "",
    stationId: row.station_id || "",
    tenant: row.tenant_name,
    tenantId: row.tenant_id,
    company: row.company || "",
    brand: row.brand || "",
    slot: row.slot_id,
    dataType: row.data_type,
    trips: row.transaction_count === null ? null : Number(row.transaction_count),
    quantity: row.quantity === null ? null : Number(row.quantity),
    tariff: row.tariff === null ? null : Number(row.tariff),
    totalAmount: row.original_amount === null ? null : Number(row.original_amount),
    billingStatus: row.billing_status,
    annualSurchargeRate: row.annual_surcharge_rate === null ? null : Number(row.annual_surcharge_rate),
    minimumBaseRent: row.minimum_base_rent === null ? null : Number(row.minimum_base_rent),
    unit: row.unit || "",
    currency: row.currency,
    source: row.source_id,
    sourceRecordId: row.source_record_id,
    sourceFile: row.source_file_name,
    sourceRowNumber: row.source_row_number,
    importedAt: row.created_at,
  };
}

const allowedFilters = new Set(["month", "station", "tenant", "brand", "slot", "dataType", "billingStatus", "currency"]);
function buildRecordFilters(query) {
  const clauses = [];
  const values = [];
  const add = (column, value) => {
    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  };
  for (const [key, value] of Object.entries(query)) {
    if (!allowedFilters.has(key) || !value) continue;
    if (typeof value !== "string" || value.length > 200) {
      const error = new Error(`Filter ${key} must be a single value of at most 200 characters.`);
      error.status = 400;
      throw error;
    }
    switch (key) {
      case "month":
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
          const error = new Error("Month filter must use YYYY-MM format.");
          error.status = 400;
          throw error;
        }
        values.push(`${value}-01`);
        clauses.push(`reporting_month = $${values.length}::date`);
        break;
      case "station": add("station_name", value); break;
      case "tenant": add("tenant_name", value); break;
      case "brand": add("brand", value); break;
      case "slot": add("slot_id", value); break;
      case "dataType": add("data_type", value); break;
      case "billingStatus": add("billing_status", value); break;
      case "currency":
        if (!supportedCurrencyCodes.has(value.toUpperCase())) {
          const error = new Error("Currency filter must be a supported ISO 4217 currency code.");
          error.status = 400;
          throw error;
        }
        add("currency", value.toUpperCase());
        break;
      default: break;
    }
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

async function bulkInsert(client, table, columns, rows, conflict, returning = "") {
  const rowsPerBatch = Math.max(1, Math.floor(60_000 / columns.length));
  let insertedCount = 0;
  for (let offset = 0; offset < rows.length; offset += rowsPerBatch) {
    const chunk = rows.slice(offset, offset + rowsPerBatch);
    const values = [];
    const placeholders = chunk.map((row, rowIndex) => {
      const firstParameter = rowIndex * columns.length;
      values.push(...row);
      return `(${columns.map((_, columnIndex) => `$${firstParameter + columnIndex + 1}`).join(", ")})`;
    });
    const result = await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders.join(", ")}
       ${conflict}${returning ? ` RETURNING ${returning}` : ""}`,
      values,
    );
    insertedCount += returning ? result.rowCount : chunk.length;
  }
  return insertedCount;
}

async function insertImport(parsed, file) {
  if (parsed.records.length + parsed.rejected.length > MAX_IMPORT_ROWS) {
    const error = new Error(`An import may contain no more than ${MAX_IMPORT_ROWS.toLocaleString()} data rows.`);
    error.status = 413;
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batchResult = await client.query(
      `INSERT INTO data_import_batches
         (source_id, original_filename, file_sha256, currency, status)
       VALUES ('manual_csv', $1, $2, $3, 'processing')
       RETURNING batch_id`,
      [path.basename(file.originalname), parsed.fileHash, parsed.currency],
    );
    const batchId = batchResult.rows[0].batch_id;
    const stations = new Map();
    const tenants = new Map();
    const slots = new Map();
    for (const record of parsed.records) {
      const stationId = record.stationId || null;
      if (stationId) stations.set(stationId, [stationId, record.stationName || stationId]);
      tenants.set(record.tenantId, [record.tenantId, record.tenantName, record.company || null, record.brand || null]);
      slots.set(record.slotId, [record.slotId, record.tenantId, stationId]);
    }
    await bulkInsert(client, "stations", ["station_id", "name"], [...stations.values()],
      "ON CONFLICT (station_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()");
    await bulkInsert(client, "tenants", ["tenant_id", "name", "company", "brand"], [...tenants.values()],
      `ON CONFLICT (tenant_id) DO UPDATE SET name = EXCLUDED.name,
       company = EXCLUDED.company, brand = EXCLUDED.brand, updated_at = now()`);
    await bulkInsert(client, "commercial_slots", ["slot_id", "tenant_id", "station_id"], [...slots.values()],
      "ON CONFLICT (slot_id) DO NOTHING");

    const sourceFileName = path.basename(file.originalname);
    const recordRows = parsed.records.map((record) => [
      batchId, "manual_csv", record.sourceRecordId, sourceFileName, record.sourceRowNumber,
      record.sourceHash, `${record.month}-01`, record.stationId || null, record.tenantId,
      record.slotId, record.stationName || null, record.tenantName, record.company || null,
      record.brand || null, record.dataType, record.trips, record.quantity, record.tariff,
      record.totalAmount, record.currency, record.billingStatus, record.annualSurchargeRate,
      record.minimumBaseRent, record.unit || null,
    ]);
    const acceptedCount = await bulkInsert(
      client,
      "dashboard_records",
      [
        "batch_id", "source_id", "source_record_id", "source_file_name", "source_row_number",
        "source_hash", "reporting_month", "station_id", "tenant_id", "slot_id", "station_name",
        "tenant_name", "company", "brand", "data_type", "transaction_count", "quantity", "tariff",
        "original_amount", "currency", "billing_status", "annual_surcharge_rate",
        "minimum_base_rent", "unit",
      ],
      recordRows,
      "ON CONFLICT (source_id, source_record_id) DO NOTHING",
      "record_id",
    );
    const duplicateCount = parsed.records.length - acceptedCount;
    const rejectionRows = parsed.rejected.map((rejection) => [
      batchId, rejection.rowNumber, rejection.message, JSON.stringify(rejection.raw),
    ]);
    await bulkInsert(client, "import_rejections",
      ["batch_id", "source_row_number", "error_message", "rejected_row"],
      rejectionRows,
      "ON CONFLICT DO NOTHING");
    const rejectedCount = parsed.rejected.length;
    const status = rejectedCount ? "completed_with_errors" : "completed";
    await client.query(
      `UPDATE data_import_batches SET accepted_count = $2, rejected_count = $3,
         duplicate_count = $4, status = $5, completed_at = now() WHERE batch_id = $1`,
      [batchId, acceptedCount, rejectedCount, duplicateCount, status],
    );
    await client.query(
      `INSERT INTO audit_logs (action, source_id, batch_id, details)
       VALUES ('manual_import', 'manual_csv', $1, $2::jsonb)`,
      [batchId, JSON.stringify({ filename: path.basename(file.originalname), acceptedCount, rejectedCount, duplicateCount })],
    );
    await client.query("COMMIT");
    return { batchId, status, acceptedCount, rejectedCount, duplicateCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/login", assertSameOrigin, loginLimiter, async (req, res, next) => {
  if (DEMO_MODE) return res.status(404).json({ error: "Sign-in is disabled in local demo mode." });
  try {
    if (typeof req.body?.password !== "string" || req.body.password.length > 1024) {
      return res.status(400).json({ error: "A valid password is required." });
    }
    if (!await bcrypt.compare(req.body.password, DASHBOARD_PASSWORD_HASH)) {
      await audit("login_failed");
      return res.status(401).json({ error: "Invalid password." });
    }
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.user = { id: "owner" };
    req.session.csrfToken = randomBytes(32).toString("base64url");
    await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    await audit("login_succeeded");
    res.json({ authenticated: true, csrfToken: req.session.csrfToken });
  } catch (error) { next(error); }
});

app.get("/api/auth/session", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    authenticated: DEMO_MODE || Boolean(req.session.user),
    csrfToken: DEMO_MODE ? null : req.session.user ? req.session.csrfToken : null,
    demoMode: DEMO_MODE,
  });
});

app.post("/api/auth/logout", requireAuth, assertSameOrigin, requireCsrf, async (req, res, next) => {
  if (DEMO_MODE) return res.status(404).json({ error: "Sign-out is unavailable in local demo mode." });
  try {
    await audit("logout");
    await new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
    res.clearCookie("executive_dashboard_session", { httpOnly: true, sameSite: "strict", secure: process.env.SESSION_COOKIE_SECURE === "true", path: "/" });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get("/api/dashboard", requireAuth, async (req, res, next) => {
  try {
    const filters = buildRecordFilters(req.query);
    const currencies = await pool.query("SELECT DISTINCT currency FROM dashboard_records ORDER BY currency");
    const currencyValues = currencies.rows.map((row) => row.currency.trim());
    const currencyRequired = !req.query.currency && currencyValues.length > 1;
    const total = currencyRequired
      ? { rows: [{ count: 0 }] }
      : await pool.query(
        `SELECT count(*)::int AS count FROM dashboard_records ${filters.where}`,
        filters.values,
      );
    if (total.rows[0].count > 100_000) {
      return res.status(413).json({ error: "The filtered record set exceeds 100,000 rows. Narrow the reporting filters before loading it." });
    }
    const results = currencyRequired ? { rows: [] } : await pool.query(
      `SELECT to_char(reporting_month, 'YYYY-MM') AS month, station_id, tenant_id, slot_id,
         station_name, tenant_name, company, brand, data_type, transaction_count, quantity,
         tariff, original_amount, currency, billing_status, annual_surcharge_rate,
         minimum_base_rent, unit, source_id, source_record_id, source_file_name,
         source_row_number, created_at
       FROM dashboard_records ${filters.where}
       ORDER BY reporting_month, station_name NULLS LAST, tenant_name, slot_id, source_row_number`,
      filters.values,
    );
    const [latest, latestImport] = await Promise.all([
      pool.query(
      `SELECT max(completed_at) AS last_successful_sync FROM synchronization_logs
       WHERE status = 'succeeded'`,
      ),
      pool.query(
        `SELECT max(completed_at) AS last_imported_at FROM data_import_batches
         WHERE accepted_count > 0`,
      ),
    ]);
    res.set("Cache-Control", "no-store");
    res.json({
      records: results.rows.map(mapRecord),
      currencies: currencyValues,
      currencyRequired,
      reportingCurrency,
      totalRecords: currencyRequired ? 0 : total.rows[0].count,
      lastSuccessfulSync: latest.rows[0].last_successful_sync,
      lastImportedAt: latestImport.rows[0].last_imported_at,
      sources: connectorStatus.map((source) => ({
        id: source.id,
        type: source.type,
        configured: source.configured,
        implemented: source.implemented,
        schedule: source.configured && source.implemented ? source.schedule : null,
      })),
    });
  } catch (error) { next(error); }
});

app.get("/api/imports", requireAuth, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT batch_id, source_id, original_filename, currency, status, accepted_count,
         rejected_count, duplicate_count, created_at, completed_at
       FROM data_import_batches ORDER BY created_at DESC LIMIT 100`,
    );
    res.set("Cache-Control", "no-store");
    res.json({ imports: result.rows });
  } catch (error) { next(error); }
});

app.get("/api/quality", requireAuth, async (_req, res, next) => {
  try {
    const [records, rejected, currencies, slotConflicts] = await Promise.all([
      pool.query(
        `SELECT count(*) FILTER (WHERE station_id IS NULL)::int AS missing_station,
           count(*) FILTER (
             WHERE data_type IN ('Realisation (Billed)', 'Utility Cost') AND original_amount IS NULL
           )::int AS missing_required_amount,
           count(*) FILTER (
             WHERE data_type = 'Area Operational Surcharge' AND annual_surcharge_rate IS NULL
           )::int AS missing_surcharge_rate,
           count(*)::int AS total_records
         FROM dashboard_records`,
      ),
      pool.query("SELECT count(*)::int AS count FROM import_rejections"),
      pool.query(
        `SELECT currency, count(*)::int AS count FROM dashboard_records
         GROUP BY currency ORDER BY currency`,
      ),
      pool.query(
        `SELECT count(*)::int AS count FROM (
           SELECT slot_id FROM dashboard_records
           GROUP BY slot_id
           HAVING count(DISTINCT tenant_id) > 1 OR count(DISTINCT station_id) > 1
         ) AS conflicting_slots`,
      ),
    ]);
    res.set("Cache-Control", "no-store");
    res.json({
      checks: {
        missingStationIdentifiers: records.rows[0].missing_station,
        missingRequiredAmounts: records.rows[0].missing_required_amount,
        missingSurchargeRates: records.rows[0].missing_surcharge_rate,
        rejectedImportRows: rejected.rows[0].count,
        ambiguousSlotIdentifiers: slotConflicts.rows[0].count,
        totalRecords: records.rows[0].total_records,
        currencies: currencies.rows.map((row) => ({ currency: row.currency.trim(), count: row.count })),
      },
      referenceMatching: "Not verified: authoritative POS, billing, tenant, and slot registries have not been connected.",
    });
  } catch (error) { next(error); }
});

app.get("/api/reconciliation", requireAuth, async (req, res, next) => {
  try {
    let month = null;
    if (req.query.month) {
      if (typeof req.query.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)) {
        return res.status(400).json({ error: "Month must use YYYY-MM format." });
      }
      month = `${req.query.month}-01`;
    }
    const values = [];
    let where = "";
    if (month) {
      values.push(month);
      where = "WHERE reporting_month = $1::date";
    }
    const result = await pool.query(
      `SELECT reconciliation_id, source_id, reporting_month, currency, reconciliation_type,
         source_total, dashboard_total, variance, status, explanation, created_at
       FROM reconciliation_results ${where}
       ORDER BY created_at DESC LIMIT 200`,
      values,
    );
    res.set("Cache-Control", "no-store");
    res.json({
      results: result.rows,
      blockers: [
        "POS-to-source totals are unavailable until an authorized POS feed and source control totals are supplied.",
        "Invoice-to-billing totals and billed-to-payment matching are unavailable until tenant billing and payment data are supplied.",
        "Dashboard-to-approved-financial-source reconciliation requires an approved control total and accounting rule.",
      ],
    });
  } catch (error) { next(error); }
});

app.get("/api/imports/:batchId/rejections", requireAuth, async (req, res, next) => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.batchId)) {
      return res.status(400).json({ error: "Import batch ID is invalid." });
    }
    const result = await pool.query(
      `SELECT source_row_number, error_message, rejected_row
       FROM import_rejections WHERE batch_id = $1 ORDER BY source_row_number`,
      [req.params.batchId],
    );
    res.json({ rejections: result.rows });
  } catch (error) { next(error); }
});

app.post("/api/imports", requireAuth, assertSameOrigin, requireCsrf, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Choose a CSV or .xlsx file to import." });
    let parsed;
    try {
      parsed = await parseImportFile(req.file);
    } catch (error) {
      error.status = 400;
      throw error;
    }
    const result = await insertImport(parsed, req.file);
    res.status(201).json(result);
  } catch (error) { next(error); }
});

app.get("/api/sync/status", requireAuth, async (_req, res, next) => {
  try {
    const logs = await pool.query(
      `SELECT DISTINCT ON (source_id) source_id, started_at, completed_at, status,
         imported_count, rejected_count, duplicate_count, error_message
       FROM synchronization_logs ORDER BY source_id, started_at DESC`,
    );
    res.json({
      sources: connectorStatus.map((source) => ({
        ...source,
        nextScheduledSync: null,
        lastSync: logs.rows.find((row) => row.source_id === source.id) || null,
      })),
    });
  } catch (error) { next(error); }
});

app.post("/api/sync/:sourceType", requireAuth, assertSameOrigin, requireCsrf, async (req, res, next) => {
  try {
    const source = connectorStatus.find((item) => item.type === req.params.sourceType);
    if (!source) return res.status(404).json({ error: "Unknown data source." });
    try {
      getConnector(source.type);
    } catch (error) {
      if (!["CONNECTOR_NOT_CONFIGURED", "CONNECTOR_NOT_IMPLEMENTED"].includes(error.code)) throw error;
      await pool.query(
        `INSERT INTO synchronization_logs (source_id, status, error_message, completed_at)
         VALUES ($1, 'skipped', $2, now())`,
        [source.id, error.message],
      );
      return res.status(503).json({ error: error.message, requiredFields: source.requiredFields });
    }
  } catch (error) { next(error); }
});

const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/financial.js", "financial.js"],
  ["/styles.css", "styles.css"],
  ["/config.js", "config.js"],
  ["/ED.html", "ED.html"],
]);
app.get("/demo-data.js", (req, res) => {
  const remoteAddress = req.socket.remoteAddress?.replace(/^::ffff:/i, "");
  if (!DEMO_MODE || process.env.NODE_ENV === "production"
    || (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1")) {
    return res.status(204).end();
  }
  res.sendFile(path.join(root, "demo-data.js"));
});
for (const [route, filename] of staticFiles) {
  app.get(route, (_req, res) => res.sendFile(path.join(root, filename)));
}

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API endpoint not found." });
  res.status(404).type("text").send("Not found");
});

app.use((error, _req, res, _next) => {
  console.error("Request failed:", error.message);
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "The upload exceeds the configured file-size limit." : error.message;
    return res.status(400).json({ error: message });
  }
  if (error.message.includes("Invalid opening quote") || error.message.includes("Invalid Record Length")) {
    return res.status(400).json({ error: "The uploaded CSV is malformed." });
  }
  res.status(error.status || 500).json({
    error: error.status && error.status < 500 ? error.message : "The request could not be completed.",
  });
});

export default app;
