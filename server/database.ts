import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { createHash } from "node:crypto";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { prepareLegacyPlans } from "./plans";

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDatabase(location: string): Promise<Database> {
  if (
    location.startsWith("postgres://") ||
    location.startsWith("postgresql://")
  ) {
    const pool = new pg.Pool({ connectionString: location, max: 5 });
    return {
      query: (sql, params) => pool.query(sql, params),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  let release: (() => Promise<void>) | undefined;
  if (location !== ":memory:") {
    await mkdir(dirname(location), { recursive: true });
    await mkdir(location, { recursive: true });
    release = await lockfile.lock(location, { retries: 0 });
  }
  const db = new PGlite(location === ":memory:" ? undefined : location);
  try {
    await db.waitReady;
  } catch (error) {
    await release?.();
    throw error;
  }
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({ query: (sql, params) => tx.query(sql, params) }),
      ),
    async close() {
      try {
        await db.close();
      } finally {
        await release?.();
      }
    },
  };
}

export async function migrate(db: Database) {
  const directory = new URL("./migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d{3}-[a-z-]+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    const name = file.slice(0, -4);
    const sql = await readFile(new URL(file, directory), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(782341)");
      await tx.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL)",
      );
      const existing = await tx.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(
            "적용된 migration을 수정할 수 없습니다. 새 migration을 추가하세요.",
          );
        return;
      }
      for (const statement of sql.split(";").filter((value) => value.trim()))
        await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations VALUES ($1,$2)", [
        name,
        checksum,
      ]);
    });
  }
  await prepareLegacyPlans(db);
}
