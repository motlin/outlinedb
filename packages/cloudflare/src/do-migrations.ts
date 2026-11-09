import {journal, migrations} from "@outlinedb/shared/db-migrations-bundle";

export const doMigrationConfig = {
	// Drizzle's migrator wants a mutable journal; the bundle is `as const`.
	journal: {entries: journal.entries.map((entry) => ({...entry}))},
	migrations,
};
