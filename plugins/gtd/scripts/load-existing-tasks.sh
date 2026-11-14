#!/bin/bash
# Load existing tasks for duplicate detection during GTD capture
#
# Reads Next Actions lists, active projects, and recent calendar entries
# to enable duplicate detection when capturing new items.
#
# Usage:
#   ./load-existing-tasks.sh
#
# Output: JSON to stdout in format:
#   {
#     "nextActions": [{"id": "...", "name": "...", "createdAt": "..."}],
#     "projectTasks": [{"id": "...", "name": "...", "projectName": "..."}],
#     "recentMeetings": [{"id": "...", "name": "...", "date": "..."}]
#   }
#
# Exit codes:
#   0 - Success
#   1 - Error (e.g., metadata directory not found, CLI failure)

set -euo pipefail

# The project is the working directory, not the script's location: installed plugin copies live under ~/.claude/plugins/cache.
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
METADATA_DIR="${GTD_METADATA_DIR:-$PROJECT_ROOT/.llm/gtd/metadata}"
CLI="$PROJECT_ROOT/bin/run.js"

# Check that metadata directory exists
if [[ ! -d "$METADATA_DIR" ]]; then
    echo '{"error": "metadata directory not found. Run sync-metadata.sh first."}' >&2
    exit 1
fi

# Calculate date thresholds
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS date command
    THIRTY_DAYS_AGO=$(date -v-30d +%Y-%m-%d)
    SEVEN_DAYS_AGO=$(date -v-7d +%Y-%m-%d)
else
    # GNU date command (Linux)
    THIRTY_DAYS_AGO=$(date -d "30 days ago" +%Y-%m-%d)
    SEVEN_DAYS_AGO=$(date -d "7 days ago" +%Y-%m-%d)
fi

# Find all Next Actions JSON files in the hierarchical structure
NEXT_ACTIONS_DIR="$METADATA_DIR/next-actions"

# Find all Projects JSON files in the hierarchical structure
PROJECTS_DIR="$METADATA_DIR/projects"

# Find Calendar JSON files
CALENDAR_DIR="$METADATA_DIR/calendar"

# Function to fetch incomplete tasks from Next Actions files
# Reads from hierarchical metadata/next-actions/*.json files
fetch_next_actions_tasks() {
    local all_tasks="[]"

    # Check if next-actions directory exists
    if [[ ! -d "$NEXT_ACTIONS_DIR" ]]; then
        echo "$all_tasks"
        return
    fi

    # Process each Next Actions JSON file
    for json_file in "$NEXT_ACTIONS_DIR"/*.json; do
        [[ -f "$json_file" ]] || continue

        # Extract incomplete tasks from the raw node data
        # Structure: .children[] contains tasks (may be nested in containers)
        local tasks=$(jq '
            [
                .. | objects | select(.id != null and .name != null) |
                # Exclude completed tasks
                select(.completed != true and .completed != "true" and .completedAt == null) |
                # Exclude container nodes (Tasks lists with emoji prefixes or known patterns)
                select(.name | test("^(📌|⏰|☑️|✅|📄|📋) ") | not) |
                # Exclude asap ladder tier nodes (1st, 2nd, ..., Done)
                select(.name | test("^\\s*(Done|[0-9]+(st|nd|rd|th))\\s*$") | not) |
                # Exclude the root node (has children array at top level)
                select(.children == null or (.children | length) == 0 or (.name | test("^(📥|☑️|📁|👥|📤|📅|🌱|🔄|🎮|📚|🎯|📝|🏷️|🧠|⚙️)") | not)) |
                # Exclude empty names
                select(.name | length > 0) |
                {id: .id, name: .name, createdAt: (.created_at // .createdAt // null)}
            ] | unique_by(.id)
        ' "$json_file" 2>/dev/null || echo '[]')

        all_tasks=$(echo "$all_tasks" "$tasks" | jq -s 'add | unique_by(.id)')
    done

    echo "$all_tasks"
}

# Function to fetch tasks from active projects
# Reads from hierarchical metadata/projects/*.json files
fetch_project_tasks() {
    local all_tasks="[]"

    # Check if projects directory exists
    if [[ ! -d "$PROJECTS_DIR" ]]; then
        echo "$all_tasks"
        return
    fi

    # Process each Project JSON file
    for json_file in "$PROJECTS_DIR"/*.json; do
        [[ -f "$json_file" ]] || continue

        # Extract project name from the file
        local project_name=$(jq -r '.name // ""' "$json_file" 2>/dev/null || echo "")

        # Extract incomplete tasks from the raw node data
        local tasks=$(jq --arg projectName "$project_name" '
            [
                .. | objects | select(.id != null and .name != null) |
                # Exclude completed tasks
                select(.completed != true and .completed != "true") |
                # Exclude project header nodes (start with emoji like 🔧, 📦, 🎮)
                select(.name | test("^(📁|🔧|📦|🎮|🌐|📝|🎨|🔌|🚫|✅|🏰|🦁|🤖|🧬)") | not) |
                # Exclude nodes that are just hashtags
                select(.name | test("^#[a-z-]+$") | not) |
                # Exclude empty names
                select(.name | length > 0) |
                {id: .id, name: .name, projectName: $projectName}
            ] | unique_by(.id) | .[0:20]
        ' "$json_file" 2>/dev/null || echo '[]')

        all_tasks=$(echo "$all_tasks" "$tasks" | jq -s 'add | unique_by(.id)')
    done

    # Limit to prevent excessive output
    echo "$all_tasks" | jq '.[0:100]'
}

# Function to fetch recent calendar entries
# Reads from hierarchical metadata/calendar/*.json files
fetch_recent_meetings() {
    local all_meetings="[]"

    # Check if calendar directory exists
    if [[ ! -d "$CALENDAR_DIR" ]]; then
        # Fall back to fetching directly from Workflowy if no cached calendar data
        local result=$("$CLI" node get \
            --path "Calendar" \
            --depth 4 \
            --json \
             2>/dev/null || echo '{"children": []}')

        local meetings=$(echo "$result" | jq --arg cutoff "$SEVEN_DAYS_AGO" '
            def extractDate:
                if test("<time[^>]*startYear=\"(\\d+)\"[^>]*startMonth=\"(\\d+)\"[^>]*startDay=\"(\\d+)\"") then
                    capture("<time[^>]*startYear=\"(?<year>\\d+)\"[^>]*startMonth=\"(?<month>\\d+)\"[^>]*startDay=\"(?<day>\\d+)\"") |
                    "\(.year)-\(.month | tonumber | . + 100 | tostring | .[1:])-\(.day | tonumber | . + 100 | tostring | .[1:])"
                else
                    null
                end;

            [
                .. | objects | select(.name != null) |
                (.name | extractDate) as $date |
                select($date != null and $date >= $cutoff) |
                . as $dateNode |
                (.children // [])[] |
                {id: .id, name: .name, date: $date}
            ] | unique_by(.id)
        ' 2>/dev/null || echo '[]')

        echo "$meetings"
        return
    fi

    # Process each Calendar JSON file
    for json_file in "$CALENDAR_DIR"/*.json; do
        [[ -f "$json_file" ]] || continue

        # Extract meetings from date nodes within the past 7 days
        # Date nodes have <time> elements with startYear, startMonth, startDay
        local meetings=$(jq --arg cutoff "$SEVEN_DAYS_AGO" '
            # Helper to extract date from <time> element
            def extractDate:
                if test("<time[^>]*startYear=\"(\\d+)\"[^>]*startMonth=\"(\\d+)\"[^>]*startDay=\"(\\d+)\"") then
                    capture("<time[^>]*startYear=\"(?<year>\\d+)\"[^>]*startMonth=\"(?<month>\\d+)\"[^>]*startDay=\"(?<day>\\d+)\"") |
                    "\(.year)-\(.month | tonumber | . + 100 | tostring | .[1:])-\(.day | tonumber | . + 100 | tostring | .[1:])"
                else
                    null
                end;

            # Recursively find date nodes and their children
            [
                .. | objects | select(.name != null) |
                (.name | extractDate) as $date |
                select($date != null and $date >= $cutoff) |
                . as $dateNode |
                (.children // [])[] |
                {id: .id, name: .name, date: $date}
            ] | unique_by(.id)
        ' "$json_file" 2>/dev/null || echo '[]')

        all_meetings=$(echo "$all_meetings" "$meetings" | jq -s 'add | unique_by(.id)')
    done

    echo "$all_meetings"
}

# Fetch all data
NEXT_ACTIONS_TASKS=$(fetch_next_actions_tasks)
PROJECT_TASKS=$(fetch_project_tasks)
RECENT_MEETINGS=$(fetch_recent_meetings)

# Build the final output
jq -n \
    --argjson nextActions "$NEXT_ACTIONS_TASKS" \
    --argjson projectTasks "$PROJECT_TASKS" \
    --argjson recentMeetings "$RECENT_MEETINGS" \
    '{
        nextActions: $nextActions,
        projectTasks: $projectTasks,
        recentMeetings: $recentMeetings
    }'
