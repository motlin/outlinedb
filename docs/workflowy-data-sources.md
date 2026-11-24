# Workflowy data sources: why this project merges four of them

Status: describes the code at the time of writing. Every claim cites a file or a test. Anything inferred rather than read from code is marked UNVERIFIED.

## Why this project exists

Workflowy holds more data on its server than any single way of reading it returns. The product has no export that is both complete and machine-friendly. So this project reads from several access paths, merges them into one local SQLite database, and keeps that database useful as a read model for the CLI, the MCP server, the local web app and the Cloudflare Durable Object.

The consequences shape the whole codebase.

- No source is complete, so no importer may treat its own absence-of-data as deletion of data it cannot see. This is the lesson behind most of the importer guards described below.
- Each field has a "best source". The importers are field-routed: each one writes only the tables it can speak for.
- Reads are served from SQLite, and SQLite is the source of truth. A write lands in our DB first. In mirror mode (`WORKFLOWY_API_KEY` set) the same unit of work enqueues outbox rows, and `outbox drain` later sends them to workflowy.com (`outbox status` shows what is pending). Standalone mode (no key) writes only to our DB. Never mutate SQLite outside the CLI or the app: a direct write skips its outbox rows, so workflowy.com never sees it.
- The standalone and Cloudflare work ("break-away") needs the union of all sources captured locally, because after break-away nothing can re-fetch what the cache lacks. See `.llm/plans/2026-10-25-standalone-dual-write.md`.

## The four sources

The set is not the one a casual reading suggests. The three obvious sources are the public REST API, the internal web-app API and the Dropbox JSON backup. The fourth is a second file in the same Dropbox app folder: the Dropbox "History" plain-text export. It is downloaded and archived, but no importer reads it.

| # | Source | Entry point in code | Auth | Imported into the cache |
| --- | --- | --- | --- | --- |
| 1 | Public REST API (`/api/v1/*`) | `packages/shared/src/api/workflowy-client.ts` | Bearer API key (`WORKFLOWY_API_KEY`) | Yes: `cache import-api`, per-node reads, write-through read-backs |
| 2 | Internal web-app API (`/get_tree_data/`, `/get_initialization_data`, `/get_user_data/`, `/push_and_poll`, ...) | `packages/shared/src/api/workflowy-internal-client.ts`, `packages/shared/src/internal/*` | Session cookie from the `/login/` form (`./bin/run.js internal login`, or the Worker's Connect) | Yes, partly: relationships and item metadata; account state; expansion |
| 3 | Dropbox "Data" backup (`*.workflowy.backup`, JSON) | `packages/cli/src/services/cache-import.ts`, `packages/shared/src/schemas/backup-node.ts` | Dropbox refresh token | Yes: `cache import-backup(s)` |
| 4 | Dropbox "History" export (`*.txt`, indented plain-text outline) | `packages/cli/src/commands/dropbox/download-backup.ts`, `packages/cli/src/utils/backup-archive.ts` | Dropbox refresh token | No: storage only |

Other candidates, checked and rejected as data access paths:

- The official Workflowy MCP or AI connector. Nothing in `packages/*/src` calls it. `packages/mcp` is this project's own MCP server over the local cache.
- OPML, Markdown and plain-text export through the Workflowy UI. The only OPML, Markdown and text code in this repo is the local web app's own export dialog (`.llm/upstream-sync/local-inventory.md`, section "Export"), which formats the local tree. It is not a route to upstream data. The upstream formatter was only run against mock items during parity research (`.llm/upstream-sync/README.md`).
- Share links. The share operations are catalogued in the internal-API notes (`.llm/upstream-sync/internal-api.md`, section "Op types") but no importer reads shared trees.
- The Cloudflare "bookmarklet" collector. It appears only as a design proposal in `.llm/plans/2026-10-18-cloudflare-multi-user-research.md` and has no code. It would call the same internal endpoints as source 2 from inside a user's own browser tab.
- The `/trash/*` endpoints. These are part of the internal API (source 2). Only `POST /trash/restore/<id>/` is used, by `restore` in `packages/shared/src/internal/adapter.ts`. Listing trash contents is documented but unused.

### Source 1: public REST API

Code: `packages/shared/src/api/workflowy-client.ts`, validated by `packages/shared/src/types/workflowy.ts`.

Endpoints in use:

- `GET /api/v1/nodes` (roots) and `GET /api/v1/nodes?parent_id=<id>` (children of one node)
- `GET /api/v1/nodes/<id>`
- `GET /api/v1/nodes-export`: the whole tree as a flat list with `parent_id`
- `POST /api/v1/nodes/`, `POST /api/v1/nodes/<id>` (update), `DELETE /api/v1/nodes/<id>`
- `POST /api/v1/nodes/<id>/complete`, `/uncomplete`, `/move`
- `POST /api/v1/nodes/<id>/mirror` (create a mirror) and `DELETE /api/v1/nodes/<id>/mirror`

Authentication: `Authorization: Bearer <key>`. Setting `WORKFLOWY_API_URL` points the client at another base URL.

Rate limits:

- `nodes-export` is limited to one request per minute (comment on `exportAllNodes`, and the user-facing error in `packages/cli/src/commands/cache/import-api.ts`).
- Other endpoints are throttled with HTTP 429. The client never retries: `fetchOnce` makes one attempt and a 429 throws `Workflowy rate limit: ... answered 429 ...` naming the wait from the `Retry-After` header or the JSON body's `retry_after` seconds. Bursts of per-node reads (`cache sync-node --recursive`, one `GET /nodes?parent_id=` per node) are the likeliest to hit it. Tests: `packages/cli/test/services/api-sync.test.ts`, section "Rate limit handling (429)".
- An abuse-protection 403 carries its only explanation in the response body, so `describeFailure` quotes up to 500 characters of it.

Payload shape (`WorkflowyNodeSchema`, a strict zod schema):

- `id`, `name`, `note`, `parent_id`, `priority`, `completed`, `createdAt`, `modifiedAt`, `completedAt`
- `data.layoutMode`, `data.ai.inChat`, `data.isReferencesRoot`
- Timestamps are Unix seconds. `priority` is a sparse number that sorts siblings, not a dense index.

Freshness: live. A per-node read is always current. `nodes-export` is a snapshot taken when the request is served.

What it lacks: mirrors (creation returns ids, but reads carry no mirror fields), backlinks, virtual roots, calendar metadata, `numbered_start`, attachments, tag colors, stars, settings, expansion, sharing. `data.ai` and `data.isReferencesRoot` are accepted by the schema, but `processNodes` in `packages/shared/src/cache/api-import.ts` copies none of them into the cache.

Known problems:

- Stale mirror text. The REST API and backups can return text stored on a mirror node, left behind by old writes to the mirror id. Workflowy renders a mirror with its original's text. `packages/shared/src/cache/mirror-text.ts` makes every reader ignore a mirror row's own text. Tests: `packages/cli/test/services/mirror-text.test.ts`.
- Deleting a mirror or its ancestor through the generic delete leaves the id in the original's mirror list, and deleting an original leaves its mirror empty instead of promoting it. Upstream's web app does both correctly. The bug report draft is `.llm/workflowy-bug-report-mirror-delete.md`. The write-through client compensates: `delete-plan.ts` plans mirror promotion and `CacheService.promoteOriginal` records it.
- Deleted nodes lingering. A per-node read (`cache sync-node`, `refreshChildren`) only sees the children it asks about. A node deleted on workflowy.com stays in the cache until a full `import-api`, which phases out every node absent from the export. A node created on workflowy.com is missing until it is re-read. `storeChildren` in `packages/shared/src/cache/cache-service.ts` phases out cached children missing from a children list, but it deliberately never touches the attribute tables (`#1712` comment: the REST API carries none of them, so closing them would be permanent data loss).
- Phantom placeholders. `storeChildren` inserts a blank placeholder row for a parent the cache has never seen, so a partial sync can show a nameless node until a full import fills it in.

### Source 2: internal web-app API

Code: `packages/shared/src/api/workflowy-internal-client.ts` (reads, login) and `packages/shared/src/internal/*` (the `/push_and_poll` write path). The protocol is decoded from the shipped web bundle, with byte offsets and CONFIRMED/UNCONFIRMED labels, in `.llm/upstream-sync/internal-api.md`. Live probe results are in `.llm/upstream-sync/internal-api-probes.md`.

Endpoints:

- `POST /ajax_login`: the old username-and-password login. As of 2026-11-22 workflowy.com answers 404 here, and nothing calls it.
- `GET`/`POST /login/`: the server-rendered login form that replaced `/ajax_login`. The GET sets cookies; each POST (the form's hidden values, `email`, and the fields the last reply asked for, with those cookies) answers the same form with the next input to fill (`password`, then perhaps a `code`) and any `errorlist`, a reCAPTCHA, or the `sessionid` cookie. `packages/shared/src/api/workflowy-login-form.ts` relays it a step at a time. The CLI's `internal login` reads the email from `WORKFLOWY_USERNAME`, prompts for each field a step asks for (the password masked, then the authenticator code), keeps the answers only in memory, stops at a captcha, and saves the verified cookie jar to `.llm/workflowy-session` through a `SessionCookieStore`. The internal client never logs in itself: a refused cookie throws `SessionRejectedError` (or `LoggedOut` on `/push_and_poll`), whose message says to run `./bin/run.js internal login`. The Worker's per-account Connect (`POST /api/v1/workflowy-connection`) uses it and keeps the attempt's cookie jar sealed in the account's Durable Object for ten minutes, never a password or code. Each POST also sends what a browser sends unasked (checked boxes and radios, the default submit button's name), and a hidden input echoing an earlier answer (a password carried to the code step) is kept by name only, with the browser sending that answer again. An `errorlist` saying the code expired ends the attempt (`409 workflowy-login-code-expired`); every step's reply carries a trace of method, path, the form's names, status, redirect and cookie names, never a value.
- `POST /api/auth?client_version=23`: what workflowy.com's own login page script calls instead of posting the form. `{email, allowSignup}` answers `{authType: "password" | "code"}` (`code` is a code emailed to the person, not an authenticator code); then `{email, password, code, next}` (the unused one empty) answers `{sid}`, `{errors}`, `{logged_out}`, or `{is_mfa_required, sid}`, after which an authenticator challenge (`WF.AppMfa.challenge`) runs before the session counts. The Connect relay does not use it yet.
- `GET /get_initialization_data?...`: user id, `dateJoinedTimestampInSeconds`, `initialMostRecentOperationTransactionId`, a `wfclientid` header, the visible feature list. The live server sends only tree info here, so `fetchSession` also reads `GET /get_user_data/` for the user record, settings, globals, root metadata and `entropyKey`.
- `GET /get_tree_data/`: the flat item list of the main tree with each item's `metadata`, plus `server_expanded_projects_list` and the tree's transaction id. It is the only complete source of expansion state.
- `GET /get_settings/`, `POST /change_settings`, `/get_enabled_features/`
- `POST /push_and_poll`: every tree write, with `client_id`, `client_version` (21), `push_poll_data` (a JSON array of per-tree operation batches) and `push_poll_id`. 18 operation types are catalogued: `edit`, `bulk_create`, `move`, `bulk_move`, `delete`, `undelete`, `complete`, `uncomplete`, the share family, and `set_read_state`.
- `POST /trash/restore/<id>/`
- File-proxy paths (`/file-proxy/signed-preview|signed-original/...`) that return a short-lived signed S3 URL. This is the only way to reach attachment bytes (`signedFileUrl`).

Authentication: the session cookie plus a `WF-TRANSIENT-ID` header. No CSRF token appears in the bundle; `crosscheck_user_id` in POST bodies is the only cross-check. Password login fails for Google-SSO accounts and, in all likelihood, for MFA accounts. A Workflowy captcha challenge (`CaptchaRequired`) cannot be solved from Node and is never retried.

Rate limits: none on the client side beyond a 500 ms push debounce and a single in-flight push. Server limits are UNVERIFIED. The server does report item quotas (`monthly_item_quota`). In practice `/get_tree_data/` is slow for a large outline, so the web app throttles forced re-reads (`FRESH_EXPANSION_THROTTLE_MS` in `packages/shared/src/internal/adapter.ts`) and serves cached account state younger than 30 s (`FRESHNESS_MS`).

Payload shape: each `/get_tree_data/` item carries `id`, `nm`, `no`, `ct`, `lm`, `lmb`, `cb`, `cp`, `pr` and `metadata` (per `.llm/upstream-sync/internal-api.md`, section "Gaps a-l", item j). `TreeItemSchema` reduces it to `id` and `metadata`, because the importer only wants metadata. Timestamps are seconds since the account's join date, the same epoch backups use.

Freshness: live, and the only source where a write by another client shows up within seconds (the web app itself learns about remote edits through a websocket nudge plus a one-hour poll).

Known problems:

- Silent drops. If a batch fails server-side with an unrecognised error, the web client drops the in-flight operations. `PushAndPoll` therefore verifies by re-reading. A metadata patch whose value is an array is silently not pushed by the web client, so metadata must use objects, never arrays.
- Mirror data in item metadata is client-maintained, not server-derived. Dead mirror ids persist (see the data model below).
- The protocol is undocumented and gated by `client_version`. One upstream change can break it.

### Source 3: Dropbox "Data" backup (JSON)

Code: `packages/cli/src/services/cache-import.ts`, `packages/cli/src/services/backup-import.ts`, `packages/shared/src/schemas/backup-node.ts`, `packages/cli/src/utils/backup-archive.ts`.

Workflowy's "backup to Dropbox" account setting (`backup_to_dropbox`) writes one file per day into `/Apps/WorkFlowy/Data/` named `<account>.<YYYY-MM-DD>.workflowy.backup`. `dropbox download-backup` copies new files into `backups/Data/`, compresses each with zstd (`.zst`), and folds old months into `archive/<YYYY-MM>.tar.zst`. After downloading, the command deletes all but the three newest files per Dropbox folder (`MAX_REMOTE_BACKUPS`), so the local `backups/` directory is the long-term store.

Authentication: a Dropbox refresh token plus app key and secret, or a short-lived access token. No Workflowy credentials are needed to read it, but converting its timestamps needs the account epoch (see below).

Payload shape (`BackupNodeSchema`): a nested array of `{id, nm, no, ct, lm, cp, ch, metadata}`. The metadata schema is strict, which has repeatedly aborted whole imports when Workflowy added a field. Four commits added accepted-but-ignored keys to cope: `table.skipHeaders`, `video`, `calendar.day_prefix` and `isDeleted` on `s3File`. Fields in metadata: `layoutMode`, `isReferencesRoot`, `mirror` (`originalId`+`isMirrorRoot`, or `mirrorRootIds`, or `backlinkMirrorRootIds`), `backlink` (`sourceID`, `targetID`), `isVirtualRoot`, `virtualRootIds`, `changes` (`ct.by`, `cp.by`, `mn`), `ai`, `s3File`, `calendar`, `numbered_start`, `restorableUniqueNode`, `integrations`, `table`, `video`.

Timestamps (`ct`, `lm`, `cp`) are seconds since the account join date. `getOrFetchWorkflowyEpoch` resolves the epoch from `WORKFLOWY_EPOCH`, then the live `account.date_joined_sec`, then the internal API (bootstrapping the account and seeding its row).

Ordering: there is no priority field. Position is the array index inside `ch`, and the backup import maps each parent's children in that order onto `node_metadata.order_key` (`orderKeysFor`).

Freshness: one snapshot per day, taken by Workflowy on its own schedule. Hours to a day behind the live account.

What it lacks: anything account-level (settings, stars, tag colors, expansion, `entropyKey`), the `numbered_start` value (accepted but ignored by the importer), `integrations` and `table` (accepted, not stored), and attachment bytes (it carries only file metadata).

Known problems:

- Dead mirror references persist in backups: ids of deleted mirrors remain in the original's `mirrorRootIds`, and a mirror keeps `originalId` after its original is deleted. `mergeItemRelationships` therefore keeps only rows whose both sides are live nodes. Tests: `packages/cli/test/services/cache.test.ts`, describe blocks "dangling mirror records" and "mirror records".
- Staleness against newer writes. A backup is older than the cache whenever anything was written since. Merging it naively would tombstone every node created after the snapshot. The watermark guard compares content timestamps (not cache-write time) and protects only the nodes the snapshot predates, so an older backup still contributes attachments and mirrors without rolling back newer writes. `force` waives it. Tests: describe block "stale-snapshot watermark guard".
- A backup with under half the nodes of a non-trivial cache is rejected as corrupt.

### Source 4: Dropbox "History" export (plain text)

The same Dropbox app folder has a second sibling, `/Apps/WorkFlowy/History/`, holding `WorkFlowy (<account>).<YYYY-MM-DD>.txt`. `download-backup` and `list-backups` handle both folders (`DropboxFolder = "Data" | "History"`), and `backups archive` archives both. `listBackups` in `backup-archive.ts` states the policy: "History backups are storage-only and intentionally excluded."

A structural check of one local file (names masked, no content read) shows an indented outline with one dash bullet per node, nesting by four-space indent, a few hundred checkbox-style markers, some inline link markup, and multi-line continuation lines. There are no node ids and no metadata of any kind. Because of that, it cannot be merged into a table keyed by node id. I did not write a parser, so completeness of notes and exact markers is UNVERIFIED.

Its value is as a human-readable second opinion and a last-resort recovery format. It is the only source that does not depend on the shape of Workflowy's internal JSON. It lacks everything a node-id-keyed cache needs: ids, parents as ids, timestamps, mirrors, metadata.

`findLatestBackupFile` in `packages/cli/src/commands/cache/import-backup.ts` scans `History` too, but `parseBackupFilename` in `packages/cli/src/utils/backup-validation.ts` only accepts the `.workflowy.backup` name inside a `Data` directory (and a legacy JSON name), so a History `.txt` is never selected for import.

## Field-by-field matrix

Legend: has = the source returns it and the importer stores it. partial = returned or stored incompletely. payload = present in the response, but the importer drops it. missing = not returned. n/a = not applicable.

| Field                                                                  | 1 REST                                                         | 2 Internal                                                   | 3 Dropbox Data                               | 4 Dropbox History                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- | -------------------------------------- |
| Node id                                                                | has                                                            | has                                                          | has                                          | missing                                |
| Name (HTML)                                                            | has                                                            | payload (`nm`; importer reads metadata only)                 | has (`nm`)                                   | partial (text only, format UNVERIFIED) |
| Note                                                                   | has                                                            | payload (`no`)                                               | has (`no`)                                   | partial (UNVERIFIED)                   |
| Parent                                                                 | has (`parent_id`)                                              | payload (flat items)                                         | has (by nesting)                             | partial (by indent, no ids)            |
| Sibling order                                                          | has (sparse `priority`)                                        | payload (`pr`)                                               | partial (array index, priority inferred)     | partial (line order)                   |
| Completed flag                                                         | has                                                            | payload (`cp` present)                                       | has                                          | partial (checkbox markers, UNVERIFIED) |
| Completed time                                                         | has (`completedAt`)                                            | payload (`cp`)                                               | has (`cp`, epoch-relative)                   | missing                                |
| Created time                                                           | has                                                            | payload (`ct`)                                               | has (`ct`)                                   | missing                                |
| Modified time                                                          | has                                                            | payload (`lm`)                                               | has (`lm`)                                   | missing                                |
| Created by, modified by                                                | missing                                                        | payload (`cb`, `lmb`)                                        | partial (`changes.ct.by` stored)             | missing                                |
| layoutMode                                                             | has (`data.layoutMode`)                                        | has (`node_metadata.layout_mode`, bullets as NULL)           | has                                          | missing                                |
| Mirrors (original, mirror roots)                                       | missing (creation returns ids only)                            | has (`mirror.*`)                                             | has (`mirror.*`)                             | missing                                |
| Backlinks                                                              | missing                                                        | has                                                          | has                                          | missing                                |
| Virtual roots                                                          | missing                                                        | has                                                          | has                                          | missing                                |
| References roots                                                       | partial (schema accepts `isReferencesRoot`, importer drops it) | has                                                          | has                                          | missing                                |
| Calendar metadata (`dateId`, level, root)                              | missing                                                        | has (`calendar_metadata`, `calendar_levels`)                 | has (`calendar_metadata`, `calendar_levels`) | missing                                |
| Calendar day-id scheme (needs `entropyKey`)                            | missing                                                        | has (via `/get_user_data/`, stored in `account.entropy_key`) | missing                                      | missing                                |
| numbered_start                                                         | missing                                                        | has (kept)                                                   | partial (accepted, ignored)                  | missing                                |
| priority.defaultToBottom                                               | missing                                                        | has (kept)                                                   | missing                                      | missing                                |
| table, video layout flags                                              | missing                                                        | partial (`table` kept; video not)                            | partial (accepted, not stored)               | missing                                |
| Attachment metadata (`s3File`)                                         | missing                                                        | payload                                                      | has (`s3_files`)                             | missing                                |
| Attachment bytes                                                       | missing                                                        | has (signed URL via file-proxy, `signedFileUrl`)             | missing                                      | missing                                |
| AI chat marker (`ai.inChat`)                                           | partial (schema accepts, importer drops)                       | payload                                                      | has (`ai_metadata`)                          | missing                                |
| Integrations (e.g. calendar sync ids)                                  | missing                                                        | payload                                                      | partial (accepted, not stored)               | missing                                |
| Account settings                                                       | missing                                                        | has (`/get_user_data/`, `/get_settings/`)                    | missing                                      | missing                                |
| Root metadata: stars, saved searches, tag colors, date and time format | missing                                                        | has (`rootProjectMetadata`, stored in the account tables)    | missing                                      | missing                                |
| Expansion state                                                        | missing                                                        | has (`server_expanded_projects_list`)                        | missing                                      | missing                                |
| Feature flags                                                          | missing                                                        | has                                                          | missing                                      | missing                                |
| User id, join date, epoch                                              | missing                                                        | has                                                          | missing                                      | missing                                |
| Deleted nodes (trash)                                                  | missing                                                        | partial (`/trash/contents/*` documented, unused)             | missing                                      | missing                                |
| Sharing (share ids, shared emails and URLs)                            | missing                                                        | payload (share ops only; no importer)                        | missing                                      | missing                                |
| Tag text (`#tag`, `@mention`)                                          | has (inside HTML)                                              | payload                                                      | has (inside HTML)                            | partial (inside text)                  |
| Freshness                                                              | live; `nodes-export` is a snapshot                             | live                                                         | one snapshot per day                         | one snapshot per day                   |

Notes on the cells that matter:

- The internal payload includes ids, names, notes and timestamps, but `InternalTreeItemSchema` keeps only `id` and `metadata` and `keptInternalMetadata` keeps only `numbered_start`, `calendar`, `layoutMode`, `table`, `restorableUniqueNode` and `priority.defaultToBottom`. That is a deliberate narrowing, and each dropped field is a potential gap if the other sources ever disappear.
- Mirrors and references roots go through one normalizer, `collectItemRelationships` in `packages/shared/src/cache/item-relationships.ts`, so source 2 and source 3 produce identical rows. A `backlink.sourceID` is stored as a mirror of the source. `virtualRootIds` is a flipped copy of `mirrors` and is not stored.
- Backlinks are not stored. A backlink item is a live `mirrors` row whose mirror's parent is a live references root: its source is the original, and its target is the root's parent (`currentBacklinkItems`). `upstreamRelationshipMetadata` rebuilds `backlinkMirrorRootIds` and `backlink{sourceID, targetID}` from that join.
- The tables only backups fill today are `ai_metadata`, `s3_files`, `changes_metadata`, `calendar_metadata` and `calendar_levels`. Tree data does not write them.

## The mirror data model

Mirrors are the single most confusing part of the data and the main reason a REST-only cache is wrong.

- An original node has `metadata.mirror.mirrorRootIds`, a map of mirror ids to `true`. The original holds the text.
- A mirror root has `metadata.mirror.originalId` and `isMirrorRoot: true`. A mirror has no text of its own: Workflowy renders the original's name and note, and the cache reads them from the original (`mirror-text.ts`, applied by `CacheService`, `NodeTreeReader`, `PathBuilder` and the search conditions).
- `backlinkMirrorRootIds` is the same relationship for backlink items under a generated references root.
- The cache stores one row per pair in `mirrors(mirror_id, original_id)` plus the bitemporal columns. Completion is also derived: a mirror is completed exactly when its original is (`effective-completion.ts`).
- Both directions are client-maintained upstream. The web app creates a mirror by `bulk_create` of a node with `mirror.originalId` and an `edit` patch that adds the id to the original's `mirrorRootIds`. The server does not clean up after a REST-side delete, which is why dead ids occur.
- `import-api` does not touch the `mirrors` table by itself. Without tree data, only backup imports fill and repair it. With tree data, `importFromApi` merges `mirrors` and `references_roots` in the same unit of work. Mirror rows close when either node is gone (the merge keeps only rows whose both sides are live). Tests: `packages/cli/test/services/cache.test.ts`, describe blocks "mirror rows of deleted nodes" and the tree-data tests.
- To repair mirror rows, re-import a backup, then run `import-api` for current content.

## How the importers merge the sources today

```mermaid
flowchart LR
  subgraph Sources
    A[1 REST API]
    B[2 Internal API]
    C[3 Dropbox Data JSON]
    D[4 Dropbox History text]
  end
  A -->|nodes-export, per-node reads| IA[import-api / sync-node]
  B -->|get_tree_data| IA
  B -->|get_user_data, get_initialization_data| AS[account tables]
  B -->|get_tree_data metadata| IM[calendar_metadata, node_display_metadata, node_table_cell_sizes]
  C --> IB[import-backup]
  D -.->|archived, not read| ARC[backups/History]
  IA --> NC[node_content / node_metadata]
  IA --> REL[mirrors, references_roots]
  IB --> NC
  IB --> REL
  IB --> ATTR[ai, s3, changes, calendar tables]
  NC --> DB[(SQLite cache, bitemporal)]
  REL --> DB
  ATTR --> DB
  IM --> DB
  AS --> DB
```

### Importer 1: `cache import-api`

Code: `packages/cli/src/commands/cache/import-api.ts`, `packages/shared/src/cache/api-import.ts`. Tests: `packages/shared/test/api-import.test.ts`, `packages/cli/test/services/cache.test.ts`.

- Fetches `nodes-export` (source 1), then `/get_tree_data/` (source 2) when internal credentials exist.
- Merges content and metadata in batches under one system time (`beginApiImport`, `applyApiBatch`, `finishApiImport`). A three-batch import yields the same rows as a one-shot import.
- Phases out every live node no batch mentioned (`endNodeComposites`), together with its owned parts.
- With tree data, merges relationships and references roots globally in the same unit of work. Without it, their rows are left untouched (`ImportFromApiOptions.treeItems` doc comment).
- After the import, `importInternalMetadata` merges the kept metadata keys into typed temporal tables in one unit of work: `calendar` into `calendar_metadata`/`calendar_levels`, `layoutMode` into `node_metadata.layout_mode` (bullets as NULL), `numbered_start`, `restorableUniqueNode`, `table.headers`/`.skipHeaders`/`.bg` and `priority.defaultToBottom` into `node_display_metadata`, and `table.sizes` into `node_table_cell_sizes`. Only nodes already in `node_content` are written; rows of nodes the snapshot no longer reports are closed, never deleted.

### Importer 2: `cache import-backup` and `import-backups`

Code: `packages/cli/src/services/cache-import.ts`. Tests: `packages/cli/test/services/cache.test.ts`, `packages/cli/test/utils/backup-archive.test.ts`.

- Downloads missing files, then imports each backup in date order.
- Validates with the strict zod schema, converts epoch-relative timestamps, infers sibling priorities from tree position.
- Writes content, metadata, and every attribute table (`ai_metadata`, `s3_files`, `changes_metadata`, `calendar_*`) globally through the shared `applyRows`.
- Merges `mirrors` globally, and filters out any row whose either side is not a live node.
- Applies the stale-snapshot protection and the corrupt-backup guard described above.

### Per-node refresh (`sync-node`, write-through read-backs)

Code: `packages/cli/src/services/node-sync.ts`, `storeChildren` in `cache-service.ts`. Reads one level of children from the REST API at a time, upserts them, and phases out cached children that are missing from that list. After the recursive pass it merges mirrors (backlink items included) and references roots from tree data, filtered to nodes the cache already holds, so a partial sync neither invents rows nor closes rows it cannot see. Test: `packages/cli/test/services/node-sync-relationships.test.ts`.

### Account state refresh

Code: `packages/shared/src/internal/adapter.ts`, `packages/shared/src/cache/account-store.ts`. Account, root metadata and settings come from `/get_user_data/` and are decomposed into typed temporal tables, one column or row per upstream key: `account` (join date, entropy key, username, email), `root_preferences`, `account_settings`, `tag_colors`, `stars`, `star_order`, `location_renames`, `enabled_features`, `visible_features`, `changelog_reads`, `surveys`, `saved_views`, `ai_assistants` and `ai_prompt_buttons`. Expansion keys come from `/get_tree_data/` into `expanded_nodes`, and the tree's transaction id into `tree_transactions`. A refresh and every accepted local write merge into the same tables, so a changed value is a new version and history keeps every earlier one. `api_import_timestamp` records the last refresh (`account`, the 30s staleness check) and the expansion seed (`expanded_nodes`). `surveys` keeps upstream's `surveys.<id>` entries (status, 1-5 rating, time) for parity only: upstream never re-shows a survey that has an entry and its one survey trigger is dev-only (`localhost:8000`), so the survey dialog is not ported. `changelog_reads` keeps upstream's `changelog.read.<id>` flags for upstream's release notes, read-only parity data; our own What's New entries (`packages/web/src/client/whats-new-entries.ts`) announce our features only, and their read state lives in our own `whats_new_reads` table (`/api/v1/whats-new`), never in upstream's root metadata.

### Cloudflare sync

Code: `packages/cloudflare/src/sync.ts`, `workflowy-import.ts`. The Worker holds no Workflowy credentials of its own: an account connects with its own workflowy.com login, and only the session cookie is kept, sealed in its Durable Object. The one-time import (`workflowy-import.ts`) reads the whole tree and account state over that session. When the account turns on keep-syncing, an alarm run is the transaction-log catch-up: one `/push_and_poll` from the stored transaction id, which replays remote edits into the nodes and edge tables, after which open tabs get `tree.changed`. Like workflowy.com's own web app, it learns of remote edits from the signal WebSocket and polls hourly (`SYNC_INTERVAL_MINUTES`, default 60): while any tab reports itself visible, the account's Durable Object holds `/ws/signal/<wfclientid>/` over the stored session (`packages/cloudflare/src/upstream-signal.ts`), catches up once on opening it, and pulls the catch-up alarm to now on each nudge, so nudges that arrive before it runs share one catch-up. The last tab to hide or close releases it. A dropped socket is not reopened until the next visibility message or hourly run, and a refused session closes it and marks the connection expired. A catch-up failure shows as the run's `internalSyncError` and is retried on schedule; one no retry can fix (`need_refreshed_project_tree`, no transaction id) stops the sync until the account imports again.

### Temporal history

Every table is bitemporal on `system_from` and `system_to`, INTEGER microseconds since the Unix epoch (`FAR_FUTURE_DATE`, `Number.MAX_SAFE_INTEGER`, marks the live row). Output people or clients read (`node get`/`node list` JSON, MCP tool results, `cache status`, `outbox status`) renders them as ISO 8601 text with microseconds through `systemTimeToIso`, with a live row's `systemTo` as null; `cache temporal-rollback --to` takes readable UTC text. A change closes the old row and inserts a new one at one system time, so history survives every import. Composite handling means ending a node ends its owned rows (metadata, attribute tables, mirror rows where it is either side) in the same unit of work (`node-composite.ts`; design in `.llm/plans/2026-10-18-temporal-composites-design.md`, which includes measured stale-row counts that predate some of the fixes). `cache temporal-rollback` reverses an import, and rolls the account tables back with the tree. `account_state` keeps only the last calendar layout's undo writes, non-bitemporal, until undo derives from history.

### Precedence rules

- Node text, parent, order, completion: the most recent importer wins. In practice that is REST (live), because it runs daily and per write. A backup only wins for nodes newer than the cache cannot contradict: the watermark guard protects nodes that postdate the snapshot, and the backup never overrides a newer REST write.
- Mirror text: always the original's, whatever any source says.
- Relationships (mirrors, references roots): the latest import that carries them, from source 2 or 3, is the full desired state. Rows outside it are closed, never deleted. An `import-api` run without tree data leaves them alone.
- Attribute tables (`ai`, `s3`, `changes`): backups only. `calendar_*`: backups and `import-api` with tree data, whichever ran last.
- Item metadata that only the internal API holds (`numbered_start`, `restorableUniqueNode`, `table`, `priority.defaultToBottom`): `node_display_metadata` and `node_table_cell_sizes`, merged on each `import-api` with tree data.
- Account-level state: internal API and our own accepted writes, merged as new versions into the account tables.

### Still unavailable from all four

- Attachment bytes cannot be imported, only fetched on demand through a signed URL, and only while the Workflowy account exists. `s3_files` holds metadata. This is the break-away deadline called out in `.llm/plans/2026-10-25-standalone-dual-write.md`.
- Sharing: share ids, shared emails, URLs and permission levels. Nothing reads them.
- Comments and read-state (`set_read_state`): no importer.
- Trash contents and the history of deleted nodes (the temporal tables record only what an import saw disappear).
- A per-node authoritative last-modified-by and created-by for multi-user trees. The payload carries `cb` and `lmb`, but the importer drops both. `changes.ct.by` from backups is the only stored creator.
- A server-side change feed. The web app uses a websocket plus a one-hour poll, and the cache can only poll.
- Fields upstream adds later. The strict backup schema fails loudly on new metadata keys; the internal reader passes unknown keys through and the importer ignores them. Both are silent gaps until someone looks.
- Account-level data in backups. Stars, tag colors, settings and expansion exist only through the internal API, so a session-less restore from backups alone loses them. The standalone plan adds durable copies for exactly this reason.

## Outbox drain: which upstream API each kind of write uses and why

Our DB is the source of truth for writes. A command or the web app writes the local tables first, through `LocalTreeWriter` (`packages/shared/src/cache/local-tree-writer.ts`), `LocalCalendar` and `LocalAccount`; `node update`, for example, calls `local.updateNode` (`packages/cli/src/commands/node/update.ts`). In mirror mode the same unit of work records which parts of which nodes are now ahead of workflowy.com: node rows in `outbox` keyed by node and aspect (`OUTBOX_ASPECTS` in `packages/shared/src/cache/outbox.ts`: create, name, note, placement, completion, metadata, mirror, delete), and account rows in `account_outbox` keyed by subject and key (`ACCOUNT_OUTBOX_SUBJECTS` in `packages/shared/src/cache/account-outbox.ts`: root metadata, setting, saved view, expansion, feature). Rows hold no payload; the drain reads the current local value when it sends, so a burst of edits coalesces into one row.

The drain runs after each CLI write (`drainAfterWrite` in `packages/cli/src/services/local-writes.ts`) and on demand with `outbox drain`. It needs the internal-API session (`./bin/run.js internal login`), because every node write goes out as internal ops: the internal API takes an exact index and client-chosen ids, so the ids and order chosen locally survive the trip. A failed or unacknowledged push records `last_error` on the rows it carried and leaves them pending for the next drain; nothing is retried in a loop. Imports respect pending rows: `api-import.ts` keeps the local value of every field whose aspect is pending, and does not end a node that still has pending rows.

| Kind of write | Upstream API the drain uses | Why |
| --- | --- | --- |
| Node create, placement, name, note, completion, metadata, mirror link, delete, restore | Internal `/push_and_poll` ops in one push (`bulk_create`, `move`, `edit`, `complete`, `uncomplete`, `delete`, `undelete`), built by `packages/shared/src/internal/outbox-drain.ts` | Exact indexes and client-chosen ids keep upstream identical to the local tree. A row closes only once the server run echoes its op |
| `numbered_start`, `priority.defaultToBottom`, layout on any node, calendar metadata and deterministic calendar ids | Internal `edit` ops with metadata patches (`metadata-patch.ts`) | No public field exists. Day ids come from a uuid5 seeded with the account `entropyKey` (`calendar-ids.ts`), so only a client that picks its own ids can reproduce them |
| Mirrors and backlinks | Internal ops: a new mirror's link, and an edit of each original listing the mirrors and backlink items it gained or lost | These links live only in the internal data model's metadata |
| Stars, tag colors, date format, week start, notes root (root metadata) | One internal `edit` on the root project (`projectid` `"None"`), patched against a fresh bootstrap's root metadata (`account-outbox-drain.ts`) | These live in root-item metadata, not in any REST resource |
| Legacy saved views | `POST /change_settings` with one `saved_views_json_delta` | Saved views are a server-stored setting, sent as a delta of the views that changed |
| Account settings | `POST /change_settings`, one per setting | The only route for server-stored settings |
| Feature flags | `POST /features/enable/<codename>` or `/features/disable/<codename>` | The only route for feature flags |
| Expansion | `project_expansions_delta` field of `/push_and_poll` | Expansion has no operation type, it is a side-channel of the push |

Node rows drain before account rows, since a star or setting may name a node whose create was pending (`WorkflowyInternalAdapter.drainOutbox` in `packages/shared/src/internal/adapter.ts`). The public REST client (`packages/shared/src/cache/workflowy-write-through-client.ts`) remains for reads and refreshes, not for delivering writes. Account-level writes land in the account tables as new versions, so those tables (with their history) are the seed of the standalone copy.

## Standalone copy

The flip in the standalone plan (`.llm/plans/2026-10-25-standalone-dual-write.md`) has landed: writes go to our DB first, mirror mode drains an outbox to Workflowy, and imports merge around pending rows rather than overwrite them (see the outbox section above). Standalone mode (no `WORKFLOWY_API_KEY`) writes only to our DB. Decisions recorded there: mirror mode (two-way copy) stays the long-lived default, order keys are local and fractional, and the plan runs after the upstream-parity roadmap. The biggest dependency on this document is the "still unavailable" list above: everything on it has to be copied out, or accepted as lost, before the paid account lapses.

## Test and tool reference

- REST client: `packages/cli/test/services/api-sync.test.ts` (including 429 handling)
- API import and batching: `packages/shared/test/api-import.test.ts`, `packages/cli/test/services/cache.test.ts`
- Backup import, mirrors, watermark guard: `packages/cli/test/services/cache.test.ts`
- Backup schema tolerance: `packages/shared/test/backup-node-schema.test.ts`
- Tree-data metadata: `packages/shared/test/import-internal-metadata.test.ts`, `packages/cli/test/services/node-sync-relationships.test.ts`
- Mirror text: `packages/cli/test/services/mirror-text.test.ts`
- Internal client and write path: `packages/shared/test/internal.test.ts`, `push-and-poll.test.ts`
- REST and backup equivalence on fixtures: `packages/shared/test/round-trip.test.ts`
- Live protocol probing: `./bin/run.js internal probe` (writes `.llm/upstream-sync/internal-api-probes.md`)
- Output schemas of the cache read model: `./bin/run.js node schema`
