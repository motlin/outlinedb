---
name: inbox-loader
description: |
    Cache all inbox items (with children) to `.llm/gtd-inboxes.json` so refinement agents have a stable snapshot to work from. Invoked by the /gtd:inbox orchestrator during Phase 1, in parallel with metadata-sync.
---

Inbox loading agent for GTD refinement. Runs `./bin/run.js gtd inboxes load --depth 3` to fetch all inbox items (with children) from Workflowy and cache them to `.llm/gtd-inboxes.json`.

Execute the CLI command:

> Run `./bin/run.js gtd inboxes load --help` to verify available flags before constructing commands.

```bash
./bin/run.js gtd inboxes load --depth 3
```

The command outputs a JSON summary:

```json
{"loadedAt": "...", "unregisteredInboxes": [], "probableDuplicates": [], "inboxCount": 3, "itemCount": 135}
```

And writes `.llm/gtd-inboxes.json` with the full inbox data including children.

The command also searches the entire local cache, without a depth or result limit, for nodes whose visible name is exactly `Inbox` or `📥 Inbox`, plus the account Inbox that root metadata `inbox_id` names whatever it is called. It compares their IDs with the registered inbox targets and link nodes under Metadata > 📥 Inboxes (the registry exported as `.llm/gtd/metadata/inboxes.json`). It resolves the registry directly, so a parallel metadata-sync cannot leave this check reading a stale or partially written file. Coverage reflects the local cache; do not claim a live full-tree audit when the cache is stale or incomplete.

Every link under Metadata > 📥 Inboxes must resolve to a node in the cache. When a link points at a deleted or missing node, the command exits non-zero with a `Broken inbox registration` error naming the link ID and the missing short ID, and writes no snapshot. Return the error status wrapper with that message verbatim; never retry around it, fall back to a partial load, or continue to refinement, because the inbox the link was meant to reach would be skipped silently. The user repoints the link, then the load is rerun.

Each inbox in `.llm/gtd-inboxes.json` carries `probableDuplicates`: groups of open sibling items whose visible titles match (ignoring markup, case, and whitespace), as `{title, ids}`. The summary flattens them across inboxes with an `inbox` name. Preserve the array in the status wrapper; do not delete or merge anything.

Surface every `unregisteredInboxes` entry from the command summary to the user as a warning, including its full path and ID, and preserve the array in the status wrapper. An empty array means no unregistered inboxes were found in the cache. A nested inbox must be surfaced even when another inbox with the same name is already registered. These warnings do not authorize registration, deletion, moving items, or triaging the unregistered inbox; keep its items out of the refinement snapshot.

Return a status wrapper:

```json
{
	"status": "success",
	"itemCount": 135,
	"unregisteredInboxes": [],
	"probableDuplicates": [],
	"outputFile": ".llm/gtd-inboxes.json"
}
```

On error, return:

```json
{
	"status": "error",
	"message": "..."
}
```
