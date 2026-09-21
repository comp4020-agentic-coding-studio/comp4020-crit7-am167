import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { seed } from "./seed";


// One SQLite file is the app's whole persistent state. In production
// fly.toml points DATABASE_PATH at the machine's volume (/data), which is
// how state survives a reload and a redeploy; locally it defaults to an
// untracked file in .data/.
const path = process.env.DATABASE_PATH ?? "./.data/app.db";
mkdirSync(dirname(path), { recursive: true });

const client = new Database(path);
client.pragma("journal_mode = WAL");
// bookings reference rooms and users; let SQLite enforce that rather than
// trusting every call site to
client.pragma("foreign_keys = ON");

export const db = drizzle(client);

/** Escape hatch for the one thing Drizzle can't express here: wrapping a
 *  read-then-write in a single SQLite transaction, which is what makes
 *  double-booking impossible (see src/lib/booking.ts). */
export const sqlite = client;

// Migrations run at boot, on whatever machine holds the volume — the
// recommended shape for SQLite on Fly, where there's no separate machine to
// run them from. The flow: edit src/lib/schema.ts, `pnpm db:generate`,
// commit the migration it writes to drizzle/.
migrate(db, { migrationsFolder: "./drizzle" });

// Campus, rooms and demo people are reference data, not user data: the app
// is useless without them, so they're planted at boot rather than by a
// separate command someone has to remember on a fresh volume. Idempotent.
seed(db, client);
