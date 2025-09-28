import { Pool } from "pg";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function withTx<T>(fn: (client: any) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await fn(client);
    await client.query("COMMIT");
    return res;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}