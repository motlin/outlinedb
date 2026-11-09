#!/bin/bash
# Sync GTD metadata to hierarchical .llm/gtd/metadata/ structure
#
# Two-phase download:
#   Phase 1: Download "Metadata" root with depth 1 → metadata.json (index of children)
#   Phase 2: For each child section, download to metadata/<section>.json
#            For link-based sections, download each target to metadata/<section>/<target>.json
#
# Output structure:
#   .llm/gtd/
#   ├── metadata.json                  # Root "Metadata" node, depth 1
#   └── metadata/
#       ├── inboxes.json               # Link-based section
#       ├── inboxes/
#       │   ├── inbox.json
#       │   ├── personal-inbox.json
#       │   └── work-inbox.json
#       ├── people.json                # Direct-child section (no subdirectory)
#       ├── hobbies-registry.json      # Direct-child section
#       └── ...
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/.llm/gtd"
CLI="$PROJECT_ROOT/bin/run.js"

# Helper: sanitize name for filesystem (strip emoji, lowercase, spaces to hyphens)
sanitize() {
    echo "$1" | sed 's/[📥☑️📁👥📤📅🌱🔄🎮📚🎯📝🏷️🧠⚙️]//g' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//'
}

# Helper: extract anchor text from HTML link: <a href="...">Text</a> -> Text
extract_anchor() {
    echo "$1" | sed 's/<a[^>]*>//g' | sed 's/<\/a>//g'
}

mkdir -p "$OUTPUT_DIR/metadata"

# Phase 1: Download root Metadata with depth 1 (index only)
# No --fields: preserve all data for deferred processing
# Resolve Metadata node ID from root list (--path fails for root-level nodes)
METADATA_ID=$("$CLI" node list --depth 1 --json | jq -r '.[] | select(.name == "Metadata") | .id')
if [ -z "$METADATA_ID" ]; then
    echo "Error: Could not find Metadata node at root" >&2
    exit 1
fi

"$CLI" node get \
    --id "$METADATA_ID" \
    --depth 1 \
    --follow-links \
    --json > "$OUTPUT_DIR/metadata.json"

echo "Phase 1: Downloaded metadata.json (root index)"

# Depth for each link target of a link-based section. Next Actions ladders nest
# tasks four levels down (Next > ✅ Tasks > 📌 Tasks (asap) > tier > task), so
# depth 3 would stop at the tier nodes and hide every ladder task.
link_target_depth() {
    if [[ "$1" == "next-actions" ]]; then
        echo 5
    else
        echo 3
    fi
}

# Phase 2: Process each child section
jq -r '.children[] | select(.name != null) | "\(.id)\t\(.name)"' "$OUTPUT_DIR/metadata.json" | while IFS=$'\t' read -r section_id section_name; do
    section_file=$(sanitize "$section_name")
    [ -z "$section_file" ] && continue

    # Depth varies by section: people tree is nested 5-6 levels deep
    # (e.g., People > Friends > Book Club > @JaneDoe)
    # Default depth 3 suffices for most sections; people needs 6.
    section_depth=3
    if [[ "$section_file" == "people" ]]; then
        section_depth=6
    fi

    # No --fields: preserve all data for deferred processing
    "$CLI" node get \
        --id "$section_id" \
        --depth "$section_depth" \
        --follow-links \
        --json > "$OUTPUT_DIR/metadata/$section_file.json"

    echo "Phase 2: Downloaded metadata/$section_file.json"

    # Check if section has children with linkTargets (link-based section)
    link_count=$(jq '[.children[]? | select(.linkTargets and (.linkTargets | length) > 0)] | length' "$OUTPUT_DIR/metadata/$section_file.json")

    if [ "$link_count" -gt 0 ]; then
        # Link-based section: create subdirectory and download each target
        mkdir -p "$OUTPUT_DIR/metadata/$section_file"

        # Use link node's anchor text for filename (not target name - target names aren't unique)
        jq -r '.children[] | select(.linkTargets and (.linkTargets | length) > 0) | "\(.name)\t\(.linkTargets[0].id)"' "$OUTPUT_DIR/metadata/$section_file.json" | while IFS=$'\t' read -r link_name target_id; do
            display_name=$(extract_anchor "$link_name")
            target_file=$(sanitize "$display_name")
            [ -z "$target_file" ] && continue

            # No --fields: preserve all data for deferred processing
            "$CLI" node get \
                --id "$target_id" \
                --depth "$(link_target_depth "$section_file")" \
                --json > "$OUTPUT_DIR/metadata/$section_file/$target_file.json"

            echo "Phase 2b: Downloaded metadata/$section_file/$target_file.json"
        done
    fi
done

# Phase 3: Build the tag-frequency map from the SQLite write-through cache.
# Gives refinement agents the "how many nodes use this tag" signal they need to
# tell a canonical tag (used widely) from a one-off typo/junk tag (used once).
# Read-only query against the cache — never mutates it.
DB="$PROJECT_ROOT/outlinedb.sqlite"
if command -v python3 >/dev/null 2>&1 && [ -f "$DB" ]; then
    python3 - "$DB" "$OUTPUT_DIR/metadata/tag-frequency.json" <<'PY'
import sqlite3, re, sys, json
from collections import Counter
db, out = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db)
rows = con.execute(
    "SELECT name FROM node_content "
    "WHERE system_to='9999-12-31 23:59:59' AND name LIKE '%#%'"
).fetchall()
tagre = re.compile(r'(?<![\w&])#([A-Za-z][A-Za-z0-9_-]*)')
htmlre = re.compile(r'<[^>]+>')
c = Counter()
for (nm,) in rows:
    if not nm:
        continue
    for m in tagre.findall(htmlre.sub(' ', nm)):
        c['#' + m] += 1
data = {
    "generatedFrom": "outlinedb.sqlite",
    "distinctTags": len(c),
    "taggedRowsScanned": len(rows),
    "tags": dict(sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))),
}
with open(out, "w") as f:
    json.dump(data, f, indent=2)
print(f"Phase 3: tag-frequency.json ({len(c)} distinct tags)")
PY
else
    echo "Phase 3: skipped tag-frequency.json (python3 or outlinedb.sqlite missing)" >&2
fi

echo ""
echo "Sync complete. Structure:"
find "$OUTPUT_DIR/metadata" -name "*.json" | sort | head -30
