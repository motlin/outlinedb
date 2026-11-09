---
name: gtd-workflowy-structure
description: Understand and configure the GTD Workflowy structure. Use this to set up GTD paths for a new user or reference configured paths.
---

# GTD Workflowy Structure

This skill helps configure and reference the Workflowy node structure for GTD.

## First-Time Setup

If the user hasn't configured their GTD paths yet, guide them through setup:

### Find Root Nodes

Run this command to see root-level nodes:

```bash
./bin/run.js node list --data-source api
```

Look for nodes like "Personal", "Work", or similar top-level organizational nodes.

### Find GTD Lists

For each root node (e.g., Personal, Work), find the GTD-style lists:

```bash
./bin/run.js utils path-to-id --path "Personal" --data-source api | xargs -I{} ./bin/run.js node list --parent-id {}
./bin/run.js utils path-to-id --path "Work" --data-source api | xargs -I{} ./bin/run.js node list --parent-id {}
```

Look for nodes matching GTD concepts:

- **Inbox** - Capture bucket (might have 📥 emoji)
- **Next Actions** - Actionable tasks (might have ☑️ emoji)
- **Calendar** - Date-specific items (might have 📅 emoji)
- **Waiting For / Delegate** - Items waiting on others (might have 📤 emoji)
- **Projects** - Multi-step outcomes (might have 📁 emoji)
- **Someday/Maybe** - Future possibilities (might have 🌱 emoji)
- **Reference** - Non-actionable information (might have 📚 emoji)

## CLI Command Reference

### Listing Nodes

```bash
# List root nodes
./bin/run.js node list --data-source api

# List children of a path
./bin/run.js utils path-to-id --path "📥 Inbox" --data-source api | xargs -I{} ./bin/run.js node list --parent-id {}

# Use cache for speed (may be stale)
./bin/run.js utils path-to-id --path "📥 Inbox" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
```

### Creating Nodes

```bash
# Create node under a parent path
./bin/run.js node create --parent-path "📥 Inbox" --name "New task"

# Create node under a parent ID
./bin/run.js node create --parent-id <parent-uuid> --name "New task"

# Dry run to preview
./bin/run.js node create --parent-path "📥 Inbox" --name "Test" --dry-run
```

### Moving Nodes

```bash
# Move by path
./bin/run.js node move --node-path "📥 Inbox,Task" --parent-path "☑️ Next Actions"

# Move by ID
./bin/run.js node move --node-id <uuid> --parent-id <parent-uuid>
```

### Deleting Nodes

```bash
./bin/run.js node delete --id <uuid>
```

## Verifying Setup

After configuration, verify paths work:

```bash
# Test each configured path
./bin/run.js utils path-to-id --path "<personal-inbox-path>" --data-source api | xargs -I{} ./bin/run.js node list --parent-id {}
./bin/run.js utils path-to-id --path "<work-inbox-path>" --data-source api | xargs -I{} ./bin/run.js node list --parent-id {}
# ... etc
```

## Notes

- Node names often include emojis - copy exact names from node list output
- Paths are comma-separated: `"Root,Child,Grandchild"`
- Node IDs are UUIDs that never change (paths can change if renamed)
- Store both paths AND IDs for robustness
