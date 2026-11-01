---
description: Drizzle ORM migration patterns for this project. Use when creating database migrations, understanding why meta files are version controlled, or troubleshooting migration issues.
---

# Database Migrations

This project uses Drizzle ORM for database schema management and migrations.

## Migration Folder Structure

```text
packages/shared/src/db/migrations/
├── meta/
│   ├── _journal.json
│   └── 0000_snapshot.json
└── 0000_initial.sql
```

`0000_initial.sql` is a baseline that collapsed the earlier 0001-0050 history. drizzle-kit generated it from `schema.ts`, and the `node_fts` full-text virtual table is appended by hand because drizzle-kit does not generate virtual tables. Its journal `when` equals the last collapsed migration's, so a database migrated through the old history treats the baseline as applied instead of re-running it.

## Why meta/ Files Are Version Controlled

**The `packages/shared/src/db/migrations/meta/` folder MUST be version controlled.**

Drizzle official documentation states: "Don't put anything from the drizzle folder into gitignore"

Reasons:

- **Snapshot comparison** - Drizzle Kit compares previous snapshots to current schema when generating migrations
- **Team consistency** - All developers need identical snapshots to generate consistent migrations
- **Migration ordering** - The `_journal.json` tracks migration order and is required for applying migrations
- **Deterministic builds** - Without tracked meta files, different developers would generate different migrations for the same schema changes

The meta files are generated output, but they are **required inputs** for future migration generation. This is why they must be tracked in version control.

## Generating Migrations

Always use `drizzle-kit generate` with the `--name` flag to create migrations:

```bash
vp exec drizzle-kit generate --name descriptive_migration_name
```

This generates both the SQL file and updates `meta/_journal.json` automatically. Never create migration SQL files manually without also updating the journal.

After adding or changing a migration, run `vp run gen:migrations` to regenerate the Durable Object bundle (`packages/shared/src/db/migrations-bundle.generated.ts`).
