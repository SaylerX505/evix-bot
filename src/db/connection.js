import pg from "pg";

const { Pool } = pg;
let pool;

export function getPool() {
  if (!pool) throw new Error("Database has not been initialized.");
  return pool;
}

export async function initPool(databaseUrl) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  if (pool) {
    await closePool();
  }

  const nextPool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  try {
    await nextPool.query("SELECT 1");
    pool = nextPool;
    return pool;
  } catch (error) {
    await nextPool.end().catch(() => null);
    throw error;
  }
}

export async function closePool() {
  const current = pool;
  pool = undefined;
  await current?.end();
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function withTransaction(callback) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}
