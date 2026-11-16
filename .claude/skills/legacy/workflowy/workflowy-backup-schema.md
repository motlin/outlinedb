---
description: Workflowy backup file format, field mappings to API, and timestamp conversion
---

# Workflowy Backup vs API Schema Analysis

## Overview

Comparison of Workflowy's backup file format (`*.workflowy.backup`) with their Web API to plan offline mode functionality.

## Schema Comparison

### Field Mappings

| Backup File     | Web API               | Notes                                                                       |
| --------------- | --------------------- | --------------------------------------------------------------------------- |
| `id`            | `id`                  | Identical UUIDs                                                             |
| `nm`            | `name`                | Same content (both include HTML tags like `<span class="colored c-green">`) |
| `ct`            | `createdAt`           | Different timestamp formats (see below)                                     |
| `lm`            | `modifiedAt`          | Different timestamp formats (see below)                                     |
| `cp`            | `completedAt`         | Only present when completed                                                 |
| `ch`            | _(separate API call)_ | Backup embeds children, API requires parent_id query                        |
| `metadata`      | `data`                | Similar structure, backup has more fields                                   |
| _(not present)_ | `priority`            | API adds sibling ordering                                                   |
| _(not present)_ | `completed`           | API adds boolean flag                                                       |
| `no`            | `note`                | Optional note field                                                         |

### Timestamp Formats

Both formats use **seconds** (not milliseconds):

- **API**: Standard Unix timestamps (seconds since Jan 1, 1970 00:00:00 UTC)
- **Backup**: Seconds since **December 24, 2011 at 18:44:02 UTC** (1:44:02 PM EST)

#### Conversion Formula

The database stores node creation, modification, and completion times as Unix timestamps (integers). Backup files use Workflowy's custom epoch, so they must be converted:

```typescript
// Backup to Unix timestamp
const WORKFLOWY_EPOCH = 1_324_752_242;
unix_timestamp = backup_timestamp + WORKFLOWY_EPOCH;
```

**Note**: This conversion is only for node data columns (`createdAt`, `modifiedAt`, `completedAt`). The temporal tracking columns (`system_from`, `system_to`) are INTEGER microseconds since the Unix epoch instead, and CLI and MCP JSON render them as ISO 8601 text with microseconds.

### Data Structure Differences

#### Backup File

- Single JSON array with entire tree embedded
- Children in `ch` array within each node
- ~20MB file with full hierarchy
- Example:

```json
{
	"id": "00000000-0000-0000-0000-000000000001",
	"nm": "<span class=\"colored c-green\">Personal</span>",
	"ct": 9437457,
	"lm": 405904342,
	"metadata": {"layoutMode": "bullets"},
	"ch": [/* embedded children */]
}
```

#### Web API

- Paginated responses, one level at a time
- Requires separate API calls per parent node
- Example:

```json
{
	"id": "00000000-0000-0000-0000-000000000001",
	"name": "<span class=\"colored c-green\">Personal</span>",
	"priority": 400,
	"completed": false,
	"createdAt": 1334189699,
	"modifiedAt": 1730656583,
	"completedAt": null,
	"data": {"layoutMode": "bullets"}
}
```

## Key Findings

### What's Compatible

- **Node IDs are identical** - Can use backup IDs directly with API
- **Content matches** - Both include HTML formatting (no stripping needed)
- **Structure is navigable** - Can traverse paths like "Journal" in both

### Limitations

- **Timestamps need conversion** - Must add epoch offset for date operations
- **No priority field in backup** - Can't determine exact sibling order
- **Metadata differences** - Backup has extra fields (AI chat, mirrors) not in API

## Offline Mode Implementation

### Advantages of Backup-Based Offline Mode

- **Single file load** - No multiple API calls needed
- **Instant navigation** - Full hierarchy available in memory
- **Faster operations** - No network latency for multi-level traversals
- **Complete snapshot** - All data from a specific point in time

### Implementation Considerations

- **Memory usage** - Must load entire ~20MB file
- **Timestamp conversion** - Use `backupToUnixTime()` helper for node data columns
- **Path resolution** - Implement recursive traversal through `ch` arrays
- **Sync challenges** - Can't merge changes back without API

## Conclusion

The backup file provides a viable foundation for offline mode with identical IDs and content to the API. The main challenge is timestamp conversion, which can be handled with a simple offset. The embedded hierarchy actually makes offline operations more efficient than online API calls for complex traversals.
