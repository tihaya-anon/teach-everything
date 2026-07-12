import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  return { client, db };
}

export type Database = ReturnType<typeof createDatabase>["db"];
