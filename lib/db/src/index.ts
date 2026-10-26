import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  // A query that runs past two minutes is stuck, not working: it is cut so it cannot hold a connection the whole app needs.
  statement_timeout: 120_000,
  connectionString: process.env.DATABASE_URL,
  // Resilience settings — survive host blips and maintenance windows.
  max:                    10,
  idleTimeoutMillis:      60_000,   // release idle connections after 60s
  connectionTimeoutMillis: 10_000,  // fail fast if DB unreachable; pool will retry
  allowExitOnIdle:        false,    // keep pool alive even when no queries running
});

// Prevent unhandled pool errors from crashing the process.
// pg-pool emits "error" for background idle-connection failures;
// without this listener Node.js would throw an uncaughtException.
pool.on("error", (err) => {
  console.error("[pg-pool] idle client error — will reconnect automatically:", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
