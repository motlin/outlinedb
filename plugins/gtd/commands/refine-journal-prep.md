---
name: refine-journal-prep
description: Prep half of journal refinement — load metadata, scan the recent live calendar window (plus one archive month only in archive mode), compute people/hobby/category/typo/emoji refinements, and stage them to .llm/gtd/review/proposals/refine-journal.json. Autonomous only; mutates no nodes and does not advance Scanner-State.
---

# Refine Journal — Prep

Compute the next archive month's journal refinements plus the recent live-calendar window and **stage** them. This is the autonomous, parallel-safe half of the journal refinement split — the matching/compute work, plus all the heavy people/hobby/category/typo/emoji rules. It mirrors `refine-inbox` (which writes `🔍` suggestions for `inbox` to apply); here the apply half is `refine-journal-apply`, which reads the staged file.

Carries the full refinement rules; the apply command is thin. Stage proposals to `.llm/gtd/review/proposals/refine-journal.json` per `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md` (the on-disk schema). Then stop.

## Prep contract (read this first)

This command runs inside a Phase 0 prep subagent (`${CLAUDE_PLUGIN_ROOT}/skills/dag-llm-tasks.md`). Obey the prep contract strictly:

- **Autonomous only.** Never call `AskUserQuestion` / `TaskCreate` / `TaskUpdate` / `TodoWrite`. Ambiguities are staged (⚠️ + an `ambiguity` block), never resolved interactively here.
- **No node mutation.** Make **zero** `node update` / `node create` calls. The only output is the staged JSON file under `.llm/gtd/review/`.
- **No Scanner-State advance.** Do **not** add the archive month to `months_completed`, move `last_completed_month`, or write recent-live coverage. That happens only in `refine-journal-apply`, so an aborted prep never skips a month or marks live entries covered. You may set `current_month_in_progress` for visibility, but do not advance.
- **Read, don't rebuild, metadata.** The DAG runs `metadata-sync` once before fan-out. Read the cached `.llm/gtd/metadata/` files; never trigger a concurrent rebuild.
- **`--dry-run`** is the verification mode: compute and write the `.json`, but the assertion is that zero `node` writes happen — which is already true for prep. Honor it as a no-op that still stages.
- **`--no-hints`** skips the Clef people hints (see Load advisory people hints) and tags from the text alone. Pair it with `--dry-run` to compare proposals with and without hints. `ai suggest-labels` writes only the CLI's local `node_label_suggestions` table, never a Workflowy node, so it is allowed in prep and in `--dry-run`.

## Scope: recent by default, archive only on request

Two modes, and the default is the narrow one:

- **Recent mode (default, and always what the daily review runs).** Scan only the recent live window. Stage no `scope: "archive"` proposals and do not read the archive cursor at all.
- **Archive mode.** Additionally scan one backwards archive month. Enter this mode **only** when the invocation explicitly asks for it — a standalone `/gtd:refine-journal` run whose arguments request archive backfill (e.g. `archive`, `backfill`, or a named month). The Phase 0 DAG never requests it.

The backwards walk was generating almost nothing but "this 2022 entry lacks a leading emoji" and drowning the handful of real fixes on recent entries, so it is opt-in. When in recent mode, skip the archive month selection below and leave `last_completed_month` / `months_completed` untouched.

## Pick the archive month and recent window

State lives under `Metadata > ⚙️ Scanner State > refine-journal` as a JSON child node:

```json
{
	"last_completed_month": "2025-06",
	"months_completed": ["2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11"],
	"total_entries_updated": 89,
	"direction": "backwards",
	"current_month_in_progress": null,
	"recent_live_months_reviewed": ["2026-06", "2026-07"],
	"recent_live_reviewed_at": "2026-07-05T09:30:00-04:00",
	"recent_live_entries_reviewed": 42
}
```

> Run `./bin/run.js node get --help` to verify available flags before constructing commands.

```bash
./bin/run.js node get --path "Metadata,⚙️ Scanner State,refine-journal" --depth 2
```

**In archive mode only**, read this state, then pick the archive month immediately **before** `last_completed_month` (backwards through time). If no state exists yet, check whether `refine-calendar` or `calendar-people-tagging` state exists and migrate from it (same format, just rename the key). Do not write the advance back here.

Compute the recent live window in both modes: the current calendar month and the prior calendar month, based on the local date at runtime. This window is always scanned every run, regardless of `months_completed` or `recent_live_months_reviewed`, because live entries are still changing and newly-created entries otherwise never receive emoji, people, hobby, typo, media, or `#exercise` refinements.

Track the two concepts separately:

- **Archive progress** uses `last_completed_month` and `months_completed` only for the backwards archive cursor.
- **Recent live coverage** uses `recent_live_months_reviewed`, `recent_live_reviewed_at`, and `recent_live_entries_reviewed` only for reporting that the live current/prior window was covered. Never add recent live months to `months_completed`.

## Load metadata (read cache)

Refresh the cache only if it is stale (more than 1 day old); otherwise read it as-is. In the DAG, the single `metadata-sync` has already run, so this is normally a no-op read.

```bash
# Only if running standalone and the cache is stale
if [ ! -f .llm/gtd/metadata/people.json ] || [ "$(find .llm/gtd/metadata/people.json -mtime +1)" ]; then
  ${CLAUDE_PLUGIN_ROOT}/scripts/sync-metadata.sh
fi
```

### People

Use the cached people tree at `.llm/gtd/metadata/people.json` — it contains the full tree at depth 6, including deeply nested groups (e.g., Friends > Book Club > @JaneDoe).

Build a compact lookup of all @Name tags and their paths:

```bash
jq '[.. | objects | select(.name? and (.name | type == "string") and (.name | startswith("@")) and (.name | test("^@[A-Z]"))) | {name, id, shortId}]' .llm/gtd/metadata/people.json
```

Also read `.llm/gtd/people-disambiguation.md` for people-only nickname and name-spelling mappings. Never write non-people terms there. Prep does not update either reference file; stage unresolved terms for the apply walk, following the explanation-routing rules in `${CLAUDE_PLUGIN_ROOT}/skills/refinement-text-rules.md`. A homonym row earns its place only when it carries context that resolves the ambiguity (companions, setting, activity); never enumerate same-named people, coworkers especially, just to record that several exist -- with no distinguishing context to give, leave the name out.

**When matching a name, always search the full cached tree** — do not rely on partial CLI fetches. Names can be nested 5+ levels deep.

### Hobbies

Use the cached hobbies registry at `.llm/gtd/metadata/hobbies-registry.json` and extract a compact lookup (tag, full name, aliases):

```bash
jq '[.children[] | .name as $section | .children[] | select(.name | length > 0) | {
  tag: (.name | gsub("<[^>]+>"; "") | gsub("^[^#]*"; "")),
  section: $section,
  fullName: ([.children[]? | select(.name | startswith("Full name:"))]
    | .[0].name // null | if . then ltrimstr("Full name: ") else null end),
  aliases: [.children[]? | select((.name | test("^(Full name:|Emoji:|Start:|End:|Status:|Type:|Details:|People:)")) | not) | .name]
}]' .llm/gtd/metadata/hobbies-registry.json
```

This reduces ~130KB of raw data to ~4KB. Both `🟢 Current` and `📦 Archived` hobbies are included — archived hobbies still appear in past calendar entries.

Use the `tag` field for the replacement text, `fullName` for primary matching (e.g., "Blood on the Clocktower" → `#botc`), and `aliases` for secondary matching (descriptions that may contain matchable terms).

### Emoji mappings

Extract emoji mappings from the cached hobbies registry:

```bash
jq '[.. | objects | select(.name and (.name | type == "string")) |
    (.name | gsub("<[^>]+>"; "") | gsub("^[^#]*"; "") | ltrimstr("#") | gsub("^\\s+|\\s+$"; "")) as $tag |
    (.children[]?.name | select(type == "string" and startswith("Emoji: ")) | sub("^Emoji: *"; "")) as $emoji |
    select($emoji and ($tag | length > 0)) | {key: $tag, value: $emoji}]
  | from_entries' .llm/gtd/metadata/hobbies-registry.json
```

This produces a tag→emoji lookup like:

```json
{
	"exercise": "💪",
	"reading": "📚",
	"gaming": "🎮",
	"running": "🏃"
}
```

### Tag frequency (for tag hygiene)

Read `.llm/gtd/metadata/tag-frequency.json` — a `{ "tags": { "#tag": count, … } }` map of how many current nodes use each tag across the whole tree, produced by `sync-metadata.sh`. It is the signal for the Tag hygiene rules below: a canonical tag is used widely; a one-off typo or junk tag is used once.

```bash
# Counts for the tags found in an entry, plus the top canonical tags to match casing against
jq '.tags' .llm/gtd/metadata/tag-frequency.json
```

Combine with the registry lookups already loaded (hobbies registry, context-tags, project tags) to form the "known tag" set — every registered tag plus any tag with count ≥ 10.

## Fetch archive and recent live entries

**Read live text fresh — never from a stale snapshot.** The DAG's `Import` barrier has already rewritten the local cache to the current API state, so derive every entry's `before` from a fresh `node get` run in this prep. Do not reuse a prior staged proposal, an older `.llm` calendar dump, or entry text carried from an earlier step. The `--expect-name` guard is the backstop, but staged `before` text should already match live data.

In archive mode, use the calendar archive path with the target archive month (skip this fetch entirely in recent mode):

```bash
./bin/run.js node get --path "Personal,📅 Calendar,🗃️ Archive,2020 - 2029 decade,<year>,<month>" --depth 3
```

Then fetch the live calendar root and keep only current-month and prior-month entries outside `🗃️ Archive`:

```bash
./bin/run.js node get --id 6bf42551caa3 --depth 4
```

If the CLI in this checkout does not support `--id` for `node get`, use the path form for the same node:

```bash
./bin/run.js node get --path "Personal,📅 Calendar" --depth 4
```

When scanning the live tree:

- Exclude the `🗃️ Archive` subtree entirely.
- Include entries dated in the current or prior month, whether they are direct children of `📅 Calendar` or nested under live year/month containers.
- Use the entry date from the calendar node header, not modified time.
- De-duplicate by full node UUID if an entry appears in both the archive fetch and live fetch.

## Load advisory people hints (Clef)

Hosted Clef on Workers AI scores which registry people each entry involves. Its verify-pass scores are **hints**, never decisions; the People tagging rules below still make every call. Hints are people only: the eval found Clef tag hints too imprecise, so never request or use tag hints.

Run it on the live calendar root from the prior month on, and in archive mode once more on the archive month node:

```bash
# Recent live window: <prior-yyyy-mm> is the prior calendar month, e.g. 2026-10
op run -- ./bin/run.js ai suggest-labels --parent-id 6bf42551caa3 --since <prior-yyyy-mm> --kind person --verifier clef --threshold 0.84 --json
# Archive mode only: the archive month's node id and that month
op run -- ./bin/run.js ai suggest-labels --parent-id <archive-month-id> --since <archive-yyyy-mm> --kind person --verifier clef --threshold 0.84 --json
```

- The output is `[{nodeId, suggestions: [{label, kind, score, source}]}]`. Index it by `nodeId` (full UUID). Entries already scored against their current text are not rescored, so a daily run only pays for new or edited entries.
- `0.84` with the full-Clef verifier and people-only scoring (`--kind person`) is the measured cut for 0.90 precision; below it, ignore the suggestion.
- Any non-zero exit (missing `CLOUDFLARE_AI_TOKEN`, API error) or a `--no-hints` run: skip hints and tag people exactly as the rules below describe. Hints are an optimization; prep never fails for lack of them.

## Load the decline ledger

Read `.llm/gtd/review/refine-journal-declined.json` before computing anything (treat a missing file as `[]`). It is an array of `{nodeId, before, after, declinedAt}` objects that `refine-journal-apply` appends on every Reject, modeled on the email-calendar decisions ledger. A rejection is final: the user said "keep as written", and the same refinement must not come back the next morning.

```bash
jq '.' .llm/gtd/review/refine-journal-declined.json 2>/dev/null || echo '[]'
```

Apply it **after** computing each entry's proposal (below), since the match is on the computed `after`:

- **Same `(nodeId, after)` pair** — a ledger entry with the same full `nodeId` and a byte-identical `after` means this exact refinement was already rejected. Drop the proposal.
- **Rejected emoji picker, entry unchanged** — a ledger entry with `after: null` records a rejected emoji-only ⚠️ proposal. Because each run rolls fresh contextual options, its `after` can never match; instead, if the ledger entry's `before` equals the entry's current live text byte-for-byte, the user already declined to emoji this exact text. Drop the emoji proposal.

Anything else is fair game. A different `after` (a new people tag found, a typo the earlier pass missed) or an entry whose text changed since the rejection is a new proposal, not a repeat. Never rewrite or prune the ledger from prep.

## Compute refinements

For each in-scope archive or recent live entry, scan for all refinement types simultaneously, applying the rules below. **Tag first, emoji second** so tag-based emoji mappings work. Never truncate entry text. Do not present anything — compute the full `before`/`after` and the exact `applyOps`, then stage.

Also apply the shared `${CLAUDE_PLUGIN_ROOT}/skills/refinement-text-rules.md`, including its actor-first emoji rule.

Read `.llm/gtd/journal-vocabulary.md` when it exists (gitignored; holds the household shorthand, the voice-to-text mishearing table, and the holiday/observance emoji table). It resolves terms that look like typos but are not, and mishearings that look correct but are not — neither is inferable from the entry text alone. Never copy its contents into `plugins/`.

### Change type indicators

| Icon | Type        | Description                                                 |
| ---- | ----------- | ----------------------------------------------------------- |
| 👤   | People      | Name → @Name (independent)                                  |
| 🎮   | Hobby       | Activity name → #hobby-tag (independent)                    |
| 🏷️   | Category    | Add category tag (e.g., #exercise) — depends on hobby match |
| 📺   | Media       | Normalize SxxEyy + add #watched (independent)               |
| ✏️   | Typo        | Spelling/grammar correction (independent)                   |
| #️⃣   | Tag hygiene | Fix a tag typo/casing, or flag an unregistered/junk tag     |
| 😀   | Emoji       | Add emoji prefix — runs **after** all tagging               |
| ⚠️   | Ambiguous   | Needs user input — stage an `ambiguity` block               |

### People tagging rules

#### Matching

- Match person names (first, last, or full) against the `👥 People` metadata tree
- Check `.llm/gtd/people-disambiguation.md` for known nickname/typo mappings
- Use the entry's Clef people hints (see Load advisory people hints) as a checklist of people to look for, not as answers. Tag a hinted person only when the entry text actually names or clearly refers to them (a first name, nickname, or relational reference that resolves to that person). Never insert a hinted `@Name` the text does not support, and never let a hint override `.llm/gtd/people-disambiguation.md`, a homonym ⚠️ `ambiguity`, or the decline ledger. A person the text names but no hint covers is still tagged as usual.
- Hint noise to reject (seen in the first live run): the journal's own author, hinted on first-person words (`I`, `me`, `we`), since the journal never tags its author; fictional characters or public figures who share a registry first name (a TV character, an author being discussed); and a hint for a reference the entry already tags under another `@Name`.
- Generic references like "my parents", "Mom", "Dad" — tag as the specific individuals **only when it is a genuine relational reference**, never when the word is part of an event or place name (e.g. a "Parents Night Out" event)
- Re-tagging is a judgment call, not a script — follow `${CLAUDE_PLUGIN_ROOT}/skills/refinement-text-rules.md`

#### Inline replacement

Replace names inline where they appear in the text — never append tags at the end:

```text
Before: Alice and Bob hosted a murder mystery dinner
After:  @AliceBrown and @BobBrown hosted a murder mystery dinner
```

Replace the phrase directly with the tag — no parentheticals:

```text
✅ @Person went
❌ <relationship> (@Person) went
```

Skip the replacement if a tag already follows the reference, and leave possessive phrasing intact when guarding (see Possessives after @tags).

#### Transcribed text and Otter bullets

- **Never tag inside quoted/transcribed text.** When an entry transcribes someone's message or speech (e.g. `Speaker: Hi …`), keep the quote verbatim — only the speaker label gets a tag.
- **Never edit Otter meeting-transcript bullets** (`• Speaker N …` children of Otter meeting nodes). Exclude them from tagging sweeps.

#### Ambiguity

- Two people with the same name — guess based on context, but stage a ⚠️ `ambiguity` block with the candidate options rather than committing.
- Nicknames or abbreviations — check the disambiguation file first; if still unresolved, stage ⚠️.
- Unknown people mentioned frequently — stage ⚠️ noting they may need a `gtd:create-person` entry (do not create it in prep).

#### Possessives after @tags

Workflowy treats `@Name's` (with apostrophe-s) as a **different tag** from `@Name`. To avoid creating duplicate tags, always insert a space before the possessive:

```text
✅ @Alex 's teachers called
❌ @Alex's teachers called
```

When scanning entries, do NOT "fix" `@Name 's` by removing the space — the space is intentional. If you encounter `@Name's` without a space, add one.

#### Verify existing @ mentions

When an entry already contains `@Name` mentions, verify they exist in metadata. If an `@Name` mention does not match any person in metadata, stage it as a ⚠️ flag for the user.

### Hobby tagging rules

#### Matching

- Match activity/game/hobby names against the `🎮 Hobbies Registry` metadata
- Both `🟢 Current` and `📦 Archived` hobbies are valid matches for historical entries
- Match the hobby's descriptive name, not just the tag (e.g., "Pickleball" matches `#pickleball`, "sourdough" matches `#sourdough`)

#### Inline replacement

Replace the hobby name inline where it appears — never append at the end:

```text
Before: Lost 3 games of pickleball in a row
After:  Lost 3 games of #pickleball in a row
```

When a hobby name appears multiple times in one entry, only tag the first occurrence.

#### Unknown hobbies

If an activity appears frequently but isn't in the registry, stage a ⚠️ noting it may need a `gtd:create-hobby` entry (do not create it in prep).

### Category tag rules

When a hobby match is found (e.g., "Program" → `#Program`), check the hobby's full registry name for additional `#tags`. If the registry entry name contains a category tag (e.g., `#Program - a 30-min low-impact workout series... #exercise`), append that category tag to the entry.

```text
Before: #Program Phase II, week 3, day 3, back 2.
After:  #Program Phase II, week 3, day 3, back 2. #exercise
```

Only append category tags that aren't already present in the entry text.

### Media notation rules

For entries that log watched TV or movies, standardize the notation and tag.

#### Detection

An entry describes watched screen media when **any** of these hold:

- It contains season/episode notation (`Season N Episode M`, `SxEy`, `NxM`, etc.)
- A watch verb (watched / watching / saw / finished / binged / rewatched) appears next to a show or movie title
- The line already starts with 📺 or 🎬

#### Normalize season/episode → `SxxEyy`

Convert to zero-padded, uppercase `S`/`E` (the Plex/Sonarr/scene standard, and what this repo's TV Time scanners already emit). Match and convert:

| Input                                          | Output   |
| ---------------------------------------------- | -------- |
| `Season 1 Episode 2`                           | `S01E02` |
| `S1E2` / `s1e2`                                | `S01E02` |
| `1x02`                                         | `S01E02` |
| `episode 2` (with a season already in context) | `S01E02` |

Ranges → write the full `SxxEyy` on **both** ends: `S03E01-S03E03` (not `S03E01-E03`). Two **non-contiguous** episodes → spell both out with "and": `S01E06 and S01E07`. Leave a bare `Season N` with **no** episode named as words — only the `SxxEyy` shorthand is normalized.

**If a season/episode number looks wrong, raise it with the user** (the apply phase asks interactively; in prep, stage a ⚠️) rather than silently changing it.

#### Look up the real season, episode, and title

For a watched-media entry, **look up the show/movie's actual season number, episode number, and episode title** (web search) rather than relying only on what the entry says — the entry is often vague ("the finale", "season two episode one") or has a wrong/misspelled title. Enrich the text to `SxxEyy "Title"` form (straight quotes), e.g. `finished the finale` → `finished the S01E06 finale "The Morrow"`. The **apply** walk performs the lookup interactively and confirms the full enriched before/after with the user (never truncated); prep stages the best-known form and marks anything it could not resolve confidently as ⚠️. Do this **consistently** for every media entry, not just ambiguous ones.

#### Append `#watched`

Add `#watched` once, at the end of the line, if not already present. `#watched` is medium-agnostic (TV, movies, documentaries, plays). Do **not** use `#watch` — that is reserved for want-to-watch / to-do items.

#### Leading emoji

- `📺` for TV (episode/season context)
- `🎬` for a movie

This overrides the generic tag→emoji default for `#watched` (which is `📺`). If the entry already starts with an emoji, leave it. For a mixed entry (e.g. exercise + some TV watching), do **not** force a 📺/🎬 prefix — keep the existing leading emoji.

A mixed exercise + `#watched` entry with **no** leading emoji leads with the activity, not the screen: stage the activity emoji first (🚶 walk, 🎒 weighted pack, 💪 workout — whichever the entry describes) and offer 📺/🎬 only as a later option. The TV was the backdrop; the activity is what the entry records.

#### Do not alter

Titles, dates, `<time>` elements, bracket dates, or `@people` tags.

#### Worked example

```text
Before: 📺 Watched half of Fallout Season 1 Episode 2 with @Bob in our AirBnB.
After:  📺 Watched half of Fallout S01E02 with @Bob in our Airbnb. #watched
```

(`Season 1 Episode 2 → S01E02`, `#watched` appended, `AirBnB → Airbnb` typo; `@Bob` untouched.)

### Typo fixing rules

#### What to fix

- Spelling errors (e.g., "gamess" → "games", "recieved" → "received")
- Missing or doubled words (e.g., "went went" → "went")
- Obvious punctuation errors (e.g., missing period, double spaces)
- **Non-breaking spaces are invisible and load-bearing.** Dictated entries routinely contain U+00A0 (`\xa0`) where a normal space looks like it should be — most often before a trailing space or around a word the recognizer paused on. Two rules follow, and skipping either one silently breaks the write:
    - **`before` and `--expect-name` carry the raw node text byte-for-byte**, U+00A0 included. Never normalize whitespace on the way in. A `before` whose NBSPs were flattened to ASCII spaces produces an `--expect-name` that can never match, so the CLI refuses every such write and the proposal fails at apply time for a reason the user cannot see. This is not hypothetical: it silently killed 4 of 47 proposals in one run.
    - **`after` normalizes U+00A0 to a normal space**, counted as a `✏️ typo` change. The character has no business in journal prose.
- **Whitespace: always strip leading and trailing whitespace** from any entry you compose an `after` for. A stray leading or trailing space is itself a fixable typo — an entry whose _only_ flaw is leading/trailing whitespace **still generates its own proposal**, even if it already begins with an emoji and needs no other change (this is the one whitespace-only exception to "already starts with emoji → skip"). The `--expect-name` guard still carries the exact original (spaces included) as `before`.
- **Decode HTML entities to their literal characters** in the visible text: `&quot;` → `"`, `&amp;` → `&`, `&#39;`/`&apos;` → `'`, `&lt;`/`&gt;` → `<`/`>`. Workflowy renders these entities, but the raw stored text should hold the literal character. An entry whose only flaw is an undecoded entity still generates its own proposal. Never introduce curly/smart quotes — always straight `"` and `'`.
- Capitalization at the start of the entry, after a leading emoji, and at the start of sentences
- Clear proper nouns and initialisms (e.g., "new york" → "New York", "pdf" → "PDF")

#### What NOT to fix

- Intentional informal style apart from basic sentence/proper-noun capitalization (e.g., casual abbreviations)
- Unclear proper nouns or unusual names — these may be correct
- Content changes — never alter meaning, only surface-level typos
- Workflowy formatting (HTML tags, `<time>` elements, bracket dates)
- Space before possessive `'s` after @tags — `@Name 's` is intentional (see People tagging rules)
- Ordinary mid-sentence verbs or phrasing (e.g., `@Alice and I drove` keeps `drove` lowercase)
- Household voice — a non-standard _grammatical_ construction that recurs across entries is how this family talks, not a typo. Before staging any grammar fix, count how often the exact phrase appears across the journal (`./bin/run.js node search --query "<phrase>"`). More than one hit means leave it alone and stage no `✏️` change. Exactly one hit that still reads deliberate goes to a `⚠️` ambiguity, never a silent rewrite. Recurring household terms belong in the gitignored `.llm/gtd/journal-vocabulary.md` so they resolve before this rule has to fire — never copy such a phrase into `plugins/`.

#### When uncertain

If you're unsure whether something is a typo or intentional, stage it as a ⚠️ proposal with an `ambiguity` block and let the user decide at apply time.

### Tag hygiene rules

For each `#tag` already written in an entry, classify it against the known-tag set (registries ∪ tags with count ≥ 10) and its frequency count:

- **Casing/typo variant** — the tag is unregistered but a near-miss of a known tag: a casing variant (`#Jira`→`#jira`, `#avalon`→`#Avalon` — prefer the _more frequent_ casing), a small edit-distance slip, or an obvious singular/plural/hyphen variant. Emit a `#️⃣` change that rewrites the tag inline to the canonical spelling (a normal proposal with `applyOps`, exactly like a typo fix). This is where the bulk of real cleanup lives — casing dups scattered across journal entries.
- **Unregistered but legit** — used on ≥ 3 nodes, no near-miss. Stage a **⚠️** noting it may need a registry entry (`gtd:create-hobby` for an activity, or a `🏷️ Context Tags` entry for a location/mode), naming the guessed registry. Do not register it in prep, and do not alter the entry text.
- **One-off junk** — count ≤ 1, resolves nowhere, not a plausible new tag (e.g. a sentence-fragment tag). Stage a **⚠️** proposing removal from the entry, with the text-with-tag-removed as the candidate `after`. Let the user decide — never silently strip a tag.

Only surface tags that clearly fall into one of these buckets; when frequency data is missing or a tag is ambiguous, leave it untouched. Never invent or add a tag that the entry does not already contain.

#### Sweep the tail of a casing variant in one proposal

Fixing a casing variant one entry per daily run never finishes — `#Milestone` sat at 4 remaining uses while single entries trickled through. When the frequency map shows a variant has **≤ 10 remaining uses repo-wide**, stage **one** proposal that fixes every remaining occurrence instead of one proposal per entry:

- Find every current node still carrying the variant. `LIKE` is case-insensitive in SQLite, so match case-sensitively with `GLOB`:

    ```bash
    ./bin/run.js node search --query "<tag>" --limit 50 --json
    ```

- `header` names the tag (e.g. `"#Milestone → #milestone (4 uses)"`), `before`/`after` list every affected entry in full, and `applyOps` holds **one** `node update … --expect-name` op per entry.
- A single stale entry only fails its own op; the rest of the sweep still applies.

Above 10 remaining uses, keep the per-entry behavior — a huge multi-entry proposal is unreviewable.

### Emoji rules

Every in-scope entry that does not already start with an emoji must produce one proposal, unless the decline ledger drops it (see Load the decline ledger). An emoji-less entry that needs no people/hobby/typo/media fix still gets an emoji proposal.

- Entry already starts with emoji → skip the emoji step (other change types may still apply; no emoji proposal needed).
- Entry has a hashtag with a preferred emoji in the tag→emoji metadata → use it. With multiple matching hashtags, use the emoji from the **first** hashtag in the text.
- Entry names a holiday or observance → look it up in the holiday/observance emoji table of `.llm/gtd/journal-vocabulary.md` and use that emoji. Holiday emoji are personal vocabulary: never hardcode a holiday name or its emoji in `plugins/`. A holiday missing from the table gets a ⚠️ proposal (below); record the user's pick in the table afterward.
- Entry names a religious or community event, class, ceremony, or place → look it up in the same emoji table of `.llm/gtd/journal-vocabulary.md`, not only holidays. The table holds community events and places too (a weekly class, a coming-of-age ceremony, a house of worship). A match uses that emoji; never hardcode these names or their emoji in `plugins/`.
- No tag-based emoji → stage a **⚠️ emoji proposal** whose `ambiguity` block carries **exactly 4 contextual emoji options**, each option a single emoji with a 1-3 word rationale (e.g. `🤦 mistake`, `⏰ alarm`, `🚗 commute`, `😴 overslept`). The apply walk adds an "Other" option automatically so the user can type a custom emoji.
- **Prefer the occasion over the means.** Lead the 4 options with the emoji for the occasion or destination the entry is about (the event, the class, the place, the thing fixed), not the means of getting there or doing it. A drive to a soccer game leads with ⚽, not 🚗; a birthday party leads with 🎂, not a generic 🎉; an audio tour at a museum leads with 🏛️, not 🎧; a dishwasher repair leads with the thing repaired (🍽️), not a generic 🧑‍🔧 or 🔧. Means emoji (car, headphones, generic party, generic tool) may appear only as later options.

## Stage the proposals

Write `.llm/gtd/review/proposals/refine-journal.json` exactly per the schema in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`. Create the directory first:

```bash
mkdir -p .llm/gtd/review/proposals
```

**Order recent before archive.** Emit every `scope: "recent"` proposal (current/prior live-month entries) first, then every `scope: "archive"` proposal. The apply walk relies on this ordering: it presents the recent block, then **asks** before touching the archive block. Recent entries are what the user actually expects a daily run to refine; the backwards archive backfill is opt-in per run.

Run every computed proposal through the decline ledger first (see Load the decline ledger) and count what it removes as `droppedDeclined`. Then, for each surviving entry that needs changes (including any entry that merely **lacks a leading emoji**), emit one proposal with:

- `nodeId` — the entry's **full UUID** (never a short id; short ids 404 on writes).
- `scope` — `"recent"` for a current/prior live-month entry, `"archive"` for an entry from the backwards archive month. Required on every proposal; the apply walk gates the archive block on it.
- `header` — the entry date (e.g. `"Feb 9"`).
- `before` / `after` — the **full** original and proposed text, never truncated.
- `changes[]` — one `{ type, icon, detail }` per change, using the indicators above.
- `hints[]` — optional; the Clef people hints for this entry (`{label, kind, score, source}`, copied from `ai suggest-labels`) that prep confirmed and used in a 👤 change. Omit hints it rejected and omit the field when there are none.
- `ambiguity` — present only on ⚠️ proposals: `{ prompt, options[] }` (e.g. `@FrankWilson` / `@EvanMiller` / `Skip tagging`).
- `applyOps[]` — the **exact** `./bin/run.js node update --id <full-uuid> --name '<final after text>' --expect-name '<full before text>'` command(s) the apply walk runs verbatim on Accept. The `--expect-name` guard is **mandatory** (see `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md` → Stale-write guard): it makes the CLI refuse the write if the entry changed between prep and apply, so a live edit is never silently clobbered. Pass the proposal's full `before` string as `--expect-name`. Entries with apostrophes use `'"'"'` escaping inside **both** single-quoted values. For a ⚠️ proposal where the final text depends on the user's choice, stage the op for the most-likely option (still with `--expect-name '<before>'`) or omit `applyOps` and let the apply command build it (it appends `--expect-name` too) — the apply command resolves the ambiguity before running.

### Emoji coverage self-check

Before writing the file, verify no emoji-less entry was silently dropped:

- Enumerate every in-scope entry (archive and recent live alike) that does **not** already start with an emoji, **excluding** entries whose emoji proposal the decline ledger dropped — those are counted in `droppedDeclined`, not here.
- Assert each such entry appears in `proposals[]` (as a normal emoji change or a ⚠️ emoji proposal). Any entry missing a proposal is a bug — stage it now (⚠️ with exactly 4 options) before writing the file.
- Record `emojiLessEntries` (entries enumerated) and `emojiProposalsStaged` (those that got an emoji proposal). They **must** be equal across the combined archive plus recent live scope.

Set top-level fields:

- `task`: `"refine-journal"` (inferred from the prep command and matches the filename).
- `generatedAt`: ISO-8601 timestamp with offset.
- `status`: `"ready"` if any proposals; `"empty"` if the combined archive plus recent live scope is already fully refined or every computed proposal was dropped by the decline ledger (idempotent re-run); `"error"` if prep failed.
- `presentation`: `"Refine calendar journal"`.
- `summary`: `{ archiveMonth, recentLiveMonths, entriesReviewed, archiveEntriesReviewed, recentLiveEntriesReviewed, proposalsStaged, droppedDeclined, emojiLessEntries, emojiProposalsStaged, peopleHints, peopleHintsUsed }` (`peopleHints` is the number of hints at or above the cut, `peopleHintsUsed` how many ended up in a 👤 change; both 0 when hints were skipped) plus a breakdown by change type (people/hobby/category/media/typo/emoji counts) for the final review summary. `emojiLessEntries` must equal `emojiProposalsStaged` (coverage invariant).

Do **not** mutate any node and do **not** advance Scanner-State. Return a one-line summary of what was staged (archive month, recent live months, entries reviewed with archive/recent split, proposals staged, dropped by the decline ledger, emoji coverage `emojiProposalsStaged/emojiLessEntries`, status) and stop.
