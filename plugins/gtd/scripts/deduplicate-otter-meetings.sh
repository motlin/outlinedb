#!/bin/bash
# Deduplicate Otter meetings by detecting exact Otter ID matches
#
# Usage:
#   ./deduplicate-otter-meetings.sh [--parent-path PATH] [--dry-run]
#
# Options:
#   --parent-path PATH  Path to parent node (e.g., "📆 Calendar"). Defaults to "📆 Calendar"
#   --dry-run          Show what would be deleted without actually deleting
#
# Example:
#   ./deduplicate-otter-meetings.sh
#   ./deduplicate-otter-meetings.sh --parent-path "📆 Calendar" --dry-run

set -euo pipefail

# The project is the working directory, not the script's location: installed plugin copies live under ~/.claude/plugins/cache.
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$PROJECT_ROOT"

PARENT_PATH="📆 Calendar"
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --parent-path)
      PARENT_PATH="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Get parent node ID from path (suppress SQL logs)
NODE_OUTPUT=$(./bin/run.js node get --path "$PARENT_PATH" --depth 0 --json 2>&1 | awk 'BEGIN {in_json=0} /^\{/ {in_json=1} in_json {print} /^\}/ {exit}')
PARENT_ID=$(echo "$NODE_OUTPUT" | jq -r '.id' 2>/dev/null || true)

if [[ -z "$PARENT_ID" ]]; then
  echo "❌ Error: Could not find node at path: $PARENT_PATH"
  exit 1
fi

echo "🔍 Deduplicating Otter meetings under: $PARENT_PATH"
echo ""

# Get calendar data once to avoid multiple API calls
CALENDAR_DATA=$(./bin/run.js node get --id "$PARENT_ID" --depth 2 --json 2>/dev/null)

# Get all duplicate Otter IDs
DUPLICATE_IDS=$(echo "$CALENDAR_DATA" | jq -r '.children[] | select(.name | test("otter\\.ai/u/")) | .name' | sed -E 's/.*otter\.ai\/u\/([a-zA-Z0-9_-]+).*/\1/' | sort | uniq -d || true)

if [[ -z "$DUPLICATE_IDS" ]]; then
  echo "✅ No duplicate Otter meetings found!"
  exit 0
fi

DELETED_COUNT=0
ENTRIES_PROCESSED=0

for OTTER_ID in $DUPLICATE_IDS; do
  # Find all nodes with this Otter ID
  ENTRIES=$(echo "$CALENDAR_DATA" | jq -c ".children[] | select(.name | contains(\"otter.ai/u/$OTTER_ID\"))" || true)

  # Process each entry
  COUNT=0
  while IFS= read -r ENTRY; do
    [[ -z "$ENTRY" ]] && continue

    NODE_ID=$(echo "$ENTRY" | jq -r '.id')
    TITLE=$(echo "$ENTRY" | jq -r '.name' | sed 's/<[^>]*>//g' | head -c 40)
    ENTRIES_PROCESSED=$((ENTRIES_PROCESSED + 1))

    if [ $COUNT -gt 0 ]; then
      # Delete duplicate (skip first one)
      if [[ "$DRY_RUN" == true ]]; then
        echo "  [DRY-RUN] Would delete: $TITLE (Otter: $OTTER_ID)"
      else
        if ! ./bin/run.js node delete --id "$NODE_ID"; then
          echo "❌ Error: Failed to delete $NODE_ID ($TITLE, Otter: $OTTER_ID)" >&2
          exit 1
        fi
        echo "  ✓ Deleted: $TITLE (Otter: $OTTER_ID)"
      fi
      DELETED_COUNT=$((DELETED_COUNT + 1))
    else
      echo "  Keeping: $TITLE (Otter: $OTTER_ID)"
    fi
    COUNT=$((COUNT + 1))
  done <<< "$ENTRIES"

done

echo ""
echo "📊 Deduplication Summary:"
echo "   Path: $PARENT_PATH"
echo "   Entries with duplicates: $ENTRIES_PROCESSED"
echo "   Duplicates removed: $DELETED_COUNT"
if [[ "$DRY_RUN" == true ]]; then
  echo "   Mode: DRY-RUN (no changes made)"
fi
echo "✅ Done!"
