import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { assertSafeDatabaseEnvironment } from "./assert-safe-environment";

assertSafeDatabaseEnvironment({ nodeEnv: process.env.NODE_ENV, databaseUrl: process.env.DATABASE_URL });

const client = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

export const database = drizzle(client);
