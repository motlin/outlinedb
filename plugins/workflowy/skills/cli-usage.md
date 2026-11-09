---
description: Rules for running OutlineDB CLI commands. MUST be followed when executing CLI invocations.
---

# OutlineDB CLI Usage Rules

- **Never add `2>/dev/null`** to CLI commands. Errors must be visible so you can debug them. Silent failures lead to wrong improvised fallbacks.
- **Never improvise alternative CLI commands** when a command from a prompt file fails. Instead, debug the failure using `--help` to check flags.
- **Never assume flags transfer between commands.** Each command has its own flags — run `<command> --help` to verify before using a flag you haven't confirmed.
- **Use `--json` output to find node IDs.** Never parse tree output with grep — the tree format interleaves URLs with entry names and off-by-one errors will update the wrong nodes. Use `node search --json` or `node get --json` instead:

```bash
# Search returns shortIds
./bin/run.js node search --query 'search text' --json | jq -r '.[] | "\(.shortId) | \(.name)"'

# Get all entries under a parent with full UUIDs
./bin/run.js node get --path "path,to,parent" --depth 2 --json | jq -r '
  .. | objects | select(.name? and (.name | test("pattern"))) | "\(.id) | \(.name)"
'

# Get the full UUID behind a shortId
./bin/run.js node get --id <shortId> --depth 0 --json | jq -r '.id'
```

- **Short IDs work for writes.** `--id`, `--node-id`, and `--parent-id` accept a 12-character short ID; the CLI expands it from the cache and errors if it finds no match. Only raw API calls need the full UUID.

- **Never overwrite text you did not just read — pass `--expect-name`.** Any `node update --name` that rewrites a node's visible text must carry `--expect-name` holding the exact text of the read the new text was derived from. The CLI compares it to the node's current name and refuses the write (non-zero exit, no mutation) when they differ, so a node the user edited since your read is a loud no-op instead of silent data loss:

```bash
./bin/run.js node update --id <node-id> --name '<new text>' --expect-name '<exact text you read>'
```

Treat a refusal as a skip, not a retry: re-read the node, rebuild the edit against its current text, and never re-run the same write with the guard dropped. Values containing apostrophes use `'"'"'` escaping inside **both** single-quoted strings.

- **`--expect-name` guards against the local cache, not the API.** `node get` reads only the cache — its inherited `--force-refresh` flag is inert there — so both your read and the guard see whatever the cache last stored. Sync first, or the guard will approve a write over text that changed on workflowy.com:

```bash
./bin/run.js cache sync-node --id <parent-uuid> --recursive
./bin/run.js node get --id <node-id> --json --fields id,name
./bin/run.js node update --id <node-id> --name '<new text>' --expect-name '<name from that get>'
```

- **A snapshot captured earlier in the conversation is never a backup.** Before a prose-rewriting pass (humanizer, tag cleanup, emoji pass, wording polish) over nodes the user may be editing — and before restoring "what it said before" from earlier context — re-read the live nodes, show the before/after diff, and get confirmation. Text captured earlier in the session may be several user edits stale, and writing it back is a silent revert of their own work, not a restore.

- **Ghost nodes: if a node reads fine but every write 404s, deep-refresh its parent.** When `node get` returns a node (even with `--force-refresh`) but `node move`/`node update`/`node delete` on it fails with `404`, the node is a "ghost": it still exists in the local cache but was deleted or replaced on the server, usually by concurrent editing on workflowy.com. `--force-refresh` does NOT fix this — it reads the stale cache. Run a recursive API sync of a PARENT to drop the ghost IDs and pull current server state, then re-fetch IDs and retry:

```bash
# Real resync from the API (not just cache read). Sync the parent section recursively.
./bin/run.js cache sync-node --id <parent-uuid> --recursive
```

Tell-tale signs: writes to one specific node 404 while sibling nodes move fine, and retrying/`--force-refresh` never clears it. `cache sync-node` on the ghost node itself also 404s (the API has no such node) — sync the parent instead.
