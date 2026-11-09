#!/usr/bin/env bash
set -euo pipefail

# OutlineDB CLI Demo
# Demonstrates all CLI functionality with data flowing from one step to the next

CLI="./bin/run.js"

# Colors for output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

section() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}$1${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

step() {
    echo ""
    echo -e "${YELLOW}📌 $1${NC}"
    echo -e "$ $2"
    read -rp "Press Enter to run..."
}

capture() {
    echo -e "${GREEN}→ Captured $1=$2${NC}"
}

echo "🎯 OutlineDB CLI Demo - Comprehensive CLI Exploration"
echo "Press Enter to continue through each step, or Ctrl+C to exit."
echo ""
echo "This demo captures IDs from earlier commands and uses them in later commands."
echo "All mutations use --dry-run for safety."

# =============================================================================
# Section 1: Overview & Cache Status
# =============================================================================
section "Section 1: Overview & Cache Status"

step "1.1 Show help" "$CLI --help"
$CLI --help

step "1.2 Check cache status (human readable)" "$CLI cache status"
$CLI cache status

step "1.3 Check cache status (JSON)" "$CLI cache status --json | jq"
$CLI cache status --json | jq

# =============================================================================
# Section 2: Discovery - Root Level
# =============================================================================
section "Section 2: Discovery - Root Level"

step "2.1 List root nodes (human readable)" "$CLI node list"
$CLI node list
step "2.2 List root nodes (JSON)" "$CLI node list --json | jq"
OUTPUT=$($CLI node list --json)
echo "$OUTPUT" | jq

step "2.3 Capture \$[0].id" "jq -r '.[0].id'"
NODES_0_ID=$(echo "$OUTPUT" | jq -r '.[0].id')
capture "NODES_0_ID" "$NODES_0_ID"

# =============================================================================
# Section 3: Navigation - Drilling Down
# =============================================================================
section "Section 3: Navigation - Drilling Down"

step "3.1 List children of \$[0]" "$CLI node list --parent-id $NODES_0_ID"
$CLI node list --parent-id "$NODES_0_ID"
step "3.2 List children (JSON) and capture first child ID" "$CLI node list --parent-id $NODES_0_ID --json | jq"
OUTPUT=$($CLI node list --parent-id "$NODES_0_ID" --json)
echo "$OUTPUT" | jq
CHILD_ID=$(echo "$OUTPUT" | jq -r '.[0].id')
capture "CHILD_ID" "$CHILD_ID"

step "3.3 Get node details" "$CLI node get --id $CHILD_ID"
$CLI node get --id "$CHILD_ID"
step "3.4 Get node with children (depth 2)" "$CLI node get --id $CHILD_ID --depth 2"
$CLI node get --id "$CHILD_ID" --depth 2
step "3.5 Get node (JSON) and capture grandchild ID" "$CLI node get --id $CHILD_ID --depth 2 --json | jq"
OUTPUT=$($CLI node get --id "$CHILD_ID" --depth 2 --json)
echo "$OUTPUT" | jq

# Try to get grandchild, fall back to CHILD_ID if no children
GRANDCHILD_ID=$(echo "$OUTPUT" | jq -r '.children[0].id // empty')
if [ -z "$GRANDCHILD_ID" ]; then
    echo -e "${YELLOW}Note: No grandchildren found, using CHILD_ID for remaining operations${NC}"
    GRANDCHILD_ID="$CHILD_ID"
fi
capture "GRANDCHILD_ID" "$GRANDCHILD_ID"

# =============================================================================
# Section 4: Reference Methods (ID vs Path)
# =============================================================================
section "Section 4: Reference Methods (ID vs Path)"

step "4.1 Get node by ID" "$CLI node get --id $NODES_0_ID"
$CLI node get --id "$NODES_0_ID"
step "4.2 Get node name for path lookup" "$CLI node get --id $NODES_0_ID --json | jq -r '.name'"
OUTPUT=$($CLI node get --id "$NODES_0_ID" --json)
echo "$OUTPUT" | jq
NODES_0_NAME=$(echo "$OUTPUT" | jq -r '.name')
capture "NODES_0_NAME" "$NODES_0_NAME"

step "4.3 Convert path to ID" "$CLI utils path-to-id --path \"$NODES_0_NAME\""
$CLI utils path-to-id --path "$NODES_0_NAME"
step "4.4 Get same node via path" "$CLI node get --path \"$NODES_0_NAME\""
$CLI node get --path "$NODES_0_NAME"
echo ""
echo -e "${GREEN}Key point: ID and path are interchangeable.${NC}"
echo -e "${GREEN}Special IDs like 'inbox' work anywhere an ID is accepted.${NC}"

# =============================================================================
# Section 5: Semantic Search
# =============================================================================
section "Section 5: Semantic Search"

step "5.1 Search for content (human readable)" "$CLI ai search --query \"project ideas\""
$CLI ai search --query "project ideas" || echo "(Search returned no results)"

step "5.2 Search (JSON)" "$CLI ai search --query \"project ideas\" --json | jq"
OUTPUT=$($CLI ai search --query "project ideas" --json || echo "[]")
echo "$OUTPUT" | jq

step "5.3 Capture search result ID" "jq -r '.[0].id'"
SEARCH_RESULT_ID=$(echo "$OUTPUT" | jq -r '.[0].id // empty')
if [ -z "$SEARCH_RESULT_ID" ]; then
    echo -e "${YELLOW}Note: No search results, using CHILD_ID for remaining operations${NC}"
    SEARCH_RESULT_ID="$CHILD_ID"
fi
capture "SEARCH_RESULT_ID" "$SEARCH_RESULT_ID"

step "5.4 View found node" "$CLI node get --id $SEARCH_RESULT_ID"
$CLI node get --id "$SEARCH_RESULT_ID"
step "5.5 Search with different model" "$CLI ai search --query \"tasks\" --model bge --limit 3"
$CLI ai search --query "tasks" --model bge --limit 3 || echo "(Search returned no results)"

step "5.6 Search with similarity scores" "$CLI ai search --query \"meeting notes\" --show-distance"
$CLI ai search --query "meeting notes" --show-distance || echo "(Search returned no results)"

# =============================================================================
# Section 6: Node Details & Field Selection
# =============================================================================
section "Section 6: Node Details & Field Selection"

step "6.1 Get node (full JSON)" "$CLI node get --id $CHILD_ID --json | jq"
$CLI node get --id "$CHILD_ID" --json | jq

step "6.2 Get node (selected fields)" "$CLI node get --id $CHILD_ID --json --fields id,name,note | jq"
$CLI node get --id "$CHILD_ID" --json --fields id,name,note | jq

step "6.3 Get node with children (selected fields)" "$CLI node get --id $CHILD_ID --depth 3 --json --fields id,name,children | jq"
$CLI node get --id "$CHILD_ID" --depth 3 --json --fields id,name,children | jq

# =============================================================================
# Section 7: Create Operations (Dry Run)
# =============================================================================
section "Section 7: Create Operations (Dry Run)"

step "7.1 Create node in inbox" "$CLI node create --parent-id inbox --name \"Demo Task\" --dry-run"
$CLI node create --parent-id inbox --name "Demo Task" --dry-run

step "7.2 Create node under captured parent" "$CLI node create --parent-id $NODES_0_ID --name \"Demo Item\" --dry-run"
$CLI node create --parent-id "$NODES_0_ID" --name "Demo Item" --dry-run

step "7.3 Create node with note" "$CLI node create --parent-id $CHILD_ID --name \"Demo\" --note \"Created in demo\" --dry-run"
$CLI node create --parent-id "$CHILD_ID" --name "Demo" --note "Created in demo" --dry-run

step "7.4 Create nested nodes from JSON" "$CLI node create --parent-id inbox --json '{\"name\":\"Parent\",\"children\":[{\"name\":\"Child 1\"},{\"name\":\"Child 2\"}]}' --dry-run"
$CLI node create --parent-id inbox --json '{"name":"Parent","children":[{"name":"Child 1"},{"name":"Child 2"}]}' --dry-run

step "7.5 Create under search result" "$CLI node create --parent-id $SEARCH_RESULT_ID --name \"Found via search\" --dry-run"
$CLI node create --parent-id "$SEARCH_RESULT_ID" --name "Found via search" --dry-run

# =============================================================================
# Section 8: Update Operations (Dry Run)
# =============================================================================
section "Section 8: Update Operations (Dry Run)"

step "8.1 Update node name" "$CLI node update --id $CHILD_ID --name \"Updated Name\" --dry-run"
$CLI node update --id "$CHILD_ID" --name "Updated Name" --dry-run

step "8.2 Update node note" "$CLI node update --id $GRANDCHILD_ID --note \"Updated via CLI\" --dry-run"
$CLI node update --id "$GRANDCHILD_ID" --note "Updated via CLI" --dry-run

step "8.3 Update search result" "$CLI node update --id $SEARCH_RESULT_ID --name \"Renamed\" --note \"With note\" --dry-run"
$CLI node update --id "$SEARCH_RESULT_ID" --name "Renamed" --note "With note" --dry-run

# =============================================================================
# Section 9: Complete/Uncomplete Operations (Dry Run)
# =============================================================================
section "Section 9: Complete/Uncomplete Operations (Dry Run)"

step "9.1 Complete node" "$CLI node complete --id $CHILD_ID --dry-run"
$CLI node complete --id "$CHILD_ID" --dry-run

step "9.2 Complete grandchild" "$CLI node complete --id $GRANDCHILD_ID --dry-run"
$CLI node complete --id "$GRANDCHILD_ID" --dry-run

step "9.3 Uncomplete node" "$CLI node uncomplete --id $CHILD_ID --dry-run"
$CLI node uncomplete --id "$CHILD_ID" --dry-run

# =============================================================================
# Section 10: Move Operations (Dry Run)
# =============================================================================
section "Section 10: Move Operations (Dry Run)"

step "10.1 Move to inbox" "$CLI node move --node-id $GRANDCHILD_ID --parent-id inbox --dry-run"
$CLI node move --node-id "$GRANDCHILD_ID" --parent-id inbox --dry-run

step "10.2 Move to captured parent" "$CLI node move --node-id $GRANDCHILD_ID --parent-id $NODES_0_ID --dry-run"
$CLI node move --node-id "$GRANDCHILD_ID" --parent-id "$NODES_0_ID" --dry-run

step "10.3 Move with position" "$CLI node move --node-id $CHILD_ID --parent-id $NODES_0_ID --position bottom --dry-run"
$CLI node move --node-id "$CHILD_ID" --parent-id "$NODES_0_ID" --position bottom --dry-run

step "10.4 Move search result to inbox" "$CLI node move --node-id $SEARCH_RESULT_ID --parent-id inbox --dry-run"
$CLI node move --node-id "$SEARCH_RESULT_ID" --parent-id inbox --dry-run

# =============================================================================
# Section 11: Delete Operations (Dry Run)
# =============================================================================
section "Section 11: Delete Operations (Dry Run)"

step "11.1 Delete node" "$CLI node delete --id $GRANDCHILD_ID --dry-run"
$CLI node delete --id "$GRANDCHILD_ID" --dry-run

step "11.2 Delete search result" "$CLI node delete --id $SEARCH_RESULT_ID --dry-run"
$CLI node delete --id "$SEARCH_RESULT_ID" --dry-run

# =============================================================================
# Summary
# =============================================================================
section "Demo Complete!"

echo ""
echo "Variables captured during demo:"
echo "  NODES_0_ID=$NODES_0_ID"
echo "  CHILD_ID=$CHILD_ID"
echo "  GRANDCHILD_ID=$GRANDCHILD_ID"
echo "  NODES_0_NAME=$NODES_0_NAME"
echo "  SEARCH_RESULT_ID=$SEARCH_RESULT_ID"
echo ""
echo "All mutation operations used --dry-run (no actual changes were made)."
echo ""
echo -e "${GREEN}✅ Demo complete!${NC}"
