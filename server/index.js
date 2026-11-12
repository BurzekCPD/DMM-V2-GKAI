import app from "./app.js";
import { pool } from "./db.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
if (process.env.DEMO_MODE === "true" && !["127.0.0.1", "::1", "localhost"].includes(host)) {
  throw new Error("DEMO_MODE can only bind to localhost (127.0.0.1, ::1, or localhost).");
}

await pool.query("SELECT 1");
const server = app.listen(port, host, () => {
  console.log(`Executive dashboard listening on http://${host}:${port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
