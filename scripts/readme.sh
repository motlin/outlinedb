#!/usr/bin/env bash
# Regenerate the oclif toc/usage/commands sections of README.md from the built CLI (packages/cli/dist).
# With --check, regenerate into a temp copy and fail when README.md differs, leaving README.md untouched.
# Deterministic and offline: fixed help width, and the usage section's platform/node line is pinned.
set -euo pipefail

cd "$(dirname "$0")/.."

mode="${1:-write}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
generated="$work/README.md"
cp README.md "$generated"

# oclif warns about a missing lib/ because the root tsconfig has no outDir; the commands come from packages/cli/dist
COLUMNS=120 vp exec oclif readme --readme-path "$generated" > /dev/null 2> "$work/oclif.log" || {
    cat "$work/oclif.log" >&2
    exit 1
}

# Pin the `outlinedb --version` example so the output does not depend on the machine that generated it,
# and tag oclif's bare help fences as text for markdownlint's MD040
awk '
    /^outlinedb\/[^ ]+ [^ ]+ node-v[^ ]+$/ { sub(/ [^ ]+ node-v[^ ]+$/, " darwin-arm64 node-v24.22.0") }
    /^```/ {
        if (!inside && $0 == "```") { $0 = "```text" }
        inside = !inside
    }
    { print }
' "$generated" > "$work/pinned.md"
mv "$work/pinned.md" "$generated"
vp fmt "$generated" > /dev/null 2>&1

if [ "$mode" = "--check" ]; then
    if ! diff -u README.md "$generated"; then
        echo "README.md is stale; run 'just readme' and commit the result" >&2
        exit 1
    fi
    echo "README.md is current"
else
    cp "$generated" README.md
fi
