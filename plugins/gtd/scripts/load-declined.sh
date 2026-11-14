#!/bin/bash
# Load declined items from Session Memory to stdout
#
# Queries Workflowy Session Memory for items declined in the past 7 days,
# preventing re-asking about the same items during bulk capture.
#
# Usage:
#   ./load-declined.sh [lookback_days]
#
# Arguments:
#   lookback_days - Number of days to look back (default: 7)
#
# Output: JSON to stdout in format:
#   {"lookbackDays": 7, "items": [{"source": "chrome", "identifier": "https://...", "declinedAt": "2025-12-30T10:00:00Z"}]}
#
# Exit codes:
#   0 - Success (even if no declined items found)
#   1 - Error (e.g., CLI failure)

set -euo pipefail

# The project is the working directory, not the script's location: installed plugin copies live under ~/.claude/plugins/cache.
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CLI="$PROJECT_ROOT/bin/run.js"

# Default lookback period
LOOKBACK_DAYS="${1:-7}"

# Calculate the cutoff date (7 days ago)
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS date command
    CUTOFF_DATE=$(date -v-"${LOOKBACK_DAYS}"d +%Y-%m-%d)
else
    # GNU date command (Linux)
    CUTOFF_DATE=$(date -d "${LOOKBACK_DAYS} days ago" +%Y-%m-%d)
fi

# Fetch Session Memory with depth 3 to get date nodes and their children
RAW_OUTPUT=$("$CLI" node get \
    --path "Metadata,🧠 Session Memory" \
    --depth 3 \
    --json \
    --fields id,name,children 2>/dev/null || echo '{"error": "Failed to read Session Memory"}')

# Check for errors
if echo "$RAW_OUTPUT" | jq -e '.error' >/dev/null 2>&1; then
    echo '{"lookbackDays": '"$LOOKBACK_DAYS"', "items": [], "error": "Failed to read Session Memory"}' >&2
    exit 1
fi

# Process the output to extract declined items
# Look for entries matching patterns:
#   - "capture-declined: <source>: <identifier>" (new format from task)
#   - "bulk-capture-declined: <url>" (legacy format)
jq --arg cutoff "$CUTOFF_DATE" --argjson lookback "$LOOKBACK_DAYS" '
# Helper function to parse declined entry
# Returns {source, identifier} or null if not a declined entry
def parseDeclined:
    if startswith("capture-declined: ") then
        # New format: "capture-declined: chrome: https://..."
        ltrimstr("capture-declined: ") |
        split(": ") |
        if length >= 2 then
            {source: .[0], identifier: (.[1:] | join(": "))}
        else
            null
        end
    elif startswith("bulk-capture-declined: ") then
        # Legacy format: "bulk-capture-declined: https://..."
        ltrimstr("bulk-capture-declined: ") |
        {source: "chrome", identifier: .}
    else
        null
    end;

{
    lookbackDays: $lookback,
    items: [
        (.children // [])[] |
        # Filter date nodes >= cutoff date
        select(.name >= $cutoff) |
        .name as $dateNode |
        # Process children (log entries) of each date node
        (.children // [])[] |
        .name as $entryName |
        ($entryName | parseDeclined) as $parsed |
        select($parsed != null) |
        {
            source: $parsed.source,
            identifier: $parsed.identifier,
            declinedAt: ($dateNode + "T00:00:00Z")
        }
    ]
}' <<< "$RAW_OUTPUT"
