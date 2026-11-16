---
description: Group related tasks — cluster open tasks on both asap ladders by theme, match each cluster against on-ladder project nodes, rescue off-ladder projects that hold open tasks onto a low tier, tag every group anchor #project and propose tagging other project-shaped ladder nodes, nest each #project under the broader umbrella #project it belongs to (creating a missing intermediate #project), and walk every proposed move one question at a time. New groups land in the highest tier any member came from, with their children ordered by former tier; agenda/ladder duplicates are flagged. Use when the user wants to group, cluster, or consolidate related tasks, or run the group-tasks phase of the daily review.
---

# Group Related Tasks

The ladders fill up with siblings that are really one piece of work: three separate "@Alice onboarding" tasks in three tiers, a "renew passport" next to "book passport photo", a build-time task on the ladder and the same topic sitting in `📋 Meeting agendas`. Ranking them separately spreads one project across the ladder. This phase finds those clusters and pulls each under a single parent, one confirmed move at a time, and tags every parent that holds several tasks `#project` so projects on the ladder are findable by tag. Projects nest too: a narrow `#project` that is one part of a broader effort belongs under that umbrella `#project` (a "Logging migration" project under "Platform upgrades"), so the ladder reads as a tree of projects rather than a flat list.

Scope is **both** roots linked from `Metadata > ☑️ Next Actions` (id: `nextActionsId` from `.llm/gtd/config.json`, asking once and saving it when missing) — Work and Personal — discovered by link resolution, never hardcoded.

## Do not use the built-in task list

Track progress through `.llm/` files and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) for the per-group work here.

## Run after File Loose Tasks

In the daily review this phase runs right after File Loose Tasks, so every task it considers is already filed on a ladder or in a `⏰` bucket and nothing loose is left to miss. When invoked standalone, run `/gtd:review:daily:file-tasks` first.

## Read the private grouping vocabulary

Which themes the user groups, which clusters they have already declined, and which project nodes absorb which topics are personal, so they live in the gitignored `.llm/gtd/task-groups.md`, never in this plugin. Read it first:

```bash
cat .llm/gtd/task-groups.md 2>/dev/null || true
```

A missing file is a normal first run: propose from the task text alone and create the file when the walk records its first decision. It holds three sections:

- **Themes** — one bullet per theme the user has accepted, with the words that identify it and the node its tasks belong under, e.g. `- onboarding @Alice: "onboarding", "@Alice", "access request" → Onboarding (<shortId>), 📌 asap → 4th`. The anchor is always a node **on the ladder** (inside a tier). A theme whose anchor is an off-ladder project is not an anchor at all: propose a rescue for that project (see **Rescue off-ladder projects**) and leave the members where they are until it is on the ladder.
- **Umbrellas** — one bullet per `#project` (or theme) the user has nested under a broader `#project`, with the full chain of anchors, e.g. `- Logging migration #project (<shortId>): "logging", "logger" → Team projects (<shortId>) > Platform upgrades #project (<shortId>), Work 📌 asap → 1st`. A chain element without a shortId is an intermediate `#project` the user named that does not exist yet.
- **Declined** — one bullet per cluster, rescue, tag, or nesting the user said no to, with the member or project names, so the same proposal is never made twice, e.g. `- 2026-09-22: "Renew passport" + "Book passport photo" — keep separate` or `- 2026-09-22: rescue 🌐 Example project — leave off the ladder` or `- 2026-09-22: tag Garden cleanup (<shortId>) — not a project` or `- 2026-09-22: nest Garden cleanup (<shortId>) under 🏡 House #project — keep at top level`.

## Load the tasks

Resolve both roots and read each root's `⏰` bucket and `📌` ladder exactly as `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/file-tasks.md` does under **Discover the roots**. **Never read from a mirror**: the buckets are mirrored under `Personal > 🔄 Review > 🔄 Daily Review > Set goals for today`, and a mirror's ids are wrong for every write. Confirm `mirror.isMirror` is false on each bucket.

```bash
mkdir -p .llm/gtd/review/proposals
./bin/run.js node get --id <asap-bucket-uuid> --depth 2 --json \
  --fields name,id,shortId,children,completedAt > .llm/gtd/review/ladder-<work|personal>.json
./bin/run.js node get --id <due-bucket-uuid> --depth 1 --json \
  --fields name,id,shortId,children,completedAt > .llm/gtd/review/due-<work|personal>.json
```

Also read each root's `📋 Meeting agendas` children and the project nodes from `.llm/gtd/metadata/projects/work-projects.json` and `personal-projects.json` (their direct children are the projects in flight).

## Cluster by theme

Build clusters **per root** — never group a Work task with a Personal one. A cluster is two or more open tasks that the user would describe as one piece of work. Use the same normalize-and-match rules `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/meetings.md` Step 7 uses (lowercase; strip HTML, `#tags`, `@mentions`, punctuation), then cluster on:

- the same distinctive noun phrase ("passport", "build times", "Q3 roadmap"), even when the verbs differ,
- the same `@person` plus the same topic,
- a theme from the **Themes** section of the vocabulary file.

A shared generic `#tag` (`#code`, `#home`, `#read`) is **not** a theme — it is exactly what replaced category containers, and grouping on it rebuilds them. Skip any cluster listed under **Declined**.

For each cluster, pick the anchor:

- **Existing project node** — when a project that is already **on the ladder** matches the theme, or the vocabulary file maps the theme to an on-ladder node, the members move under that node. No new node is created, and the project stays where it sits.
- **Never an off-ladder project.** A project outside the ladder (a direct child of `📁 Projects (in flight)`, or anywhere else off the `📌` bucket) is out of sight of every ladder walk, so anchoring ladder tasks under it hides them. When the best match is an off-ladder project, do not propose a group under it: propose a **rescue** of the project instead, and anchor the cluster by the other rules or leave it for the next run, once the project is on the ladder.
- **Existing task** — when one member is already the natural parent (it names the whole piece of work and the others are steps of it), the others move under it.
- **New group** — otherwise, a new parent node named for the theme, filed in the **highest tier any member came from** on that root's ladder (a `3rd` + `5th` cluster lands in `3rd`). The group carries the rank of its most important member: filing it lower buries that member, and filing it higher promotes the rest without the user asking. Topic `#tags` shared by every member go on the group's name.

Every anchor ends up holding two or more tasks, which makes it a project, so it carries `#project`. A new group's name ends with `#project`; an existing project or task anchor whose name lacks it gets the tag appended when the group is applied. The anchor's `tagProject` field in the proposal is `true` when the tag must be added.

## Order children by former tier

Children of the anchor keep the rank they had: order them by the tier they were on (`1st` members first), then ladder order within a tier. Compute it, and the insertion for a new group, with `planGroup` — never by hand:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/asap-tiers.mts group .llm/gtd/review/ladder-<work|personal>.json <memberUuid>,<memberUuid>,... [tier]
```

`members` is the move order, each with `fromTier` (`null` when it is not on this ladder). `insertion` is the plan for filing a new group in the highest tier its members came from — or in `[tier]` when given — computed **after** the members have left their tiers: a member leaving a tier frees the slot the group takes. Filing the group never moves any other item, even into a full tier. Ignore `insertion` when the anchor already exists.

**Dated tasks never move.** The due walk (`/gtd:review:daily:due`) reads only the direct children of each `⏰` bucket, so a dated task moved under a group on the ladder silently drops out of it. A `⏰` task that matches a cluster is listed in the question as `Related (stays in ⏰): …` so the user sees the whole theme, but it is never a member. Every member is therefore on the ladder, and a `fromTier: null` in `planGroup` output means an id was mistyped — stop and fix the member list. The one exception is a past event's split (below), which empties the dated task rather than grouping under it.

## Split past events

An anchor task that is a dated event already in the past — its name carries a `<time>` date before today, or it names a one-off occasion whose date has gone by ("@Alice's party", "Spring recital") — usually holds two kinds of children: things tied to the event day itself (prep, the event, what happened there) and follow-ups still to do afterward (thank-you notes, returning borrowed gear, paying the caterer). Grouping more tasks under it keeps the finished part on the ladder. Default to proposing a **split** instead:

- **Journal part** — the event-day children move into the event date's day node in the root's `📅 Calendar` (or `🗃️ Archive`), resolved and created exactly as `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/cleanup-completed.md` does under **Apply: Journal**. When that day already holds an entry for the event (same distinctive noun phrase), they move under that entry instead. A completed child is un-completed before it moves, so the journal never holds a completed node.
- **Follow-ups part** — the still-open follow-ups stay together on the ladder under the anchor, renamed `<event> follow-ups` with the past `<time>` element dropped. An anchor on the ladder keeps its tier. An anchor in a `⏰` bucket leaves it, since an undated node there is loose: plan its landing with `planRescue` and the anchor's tier when the user names one, else the bottom tier.

Classify each child from its text and completion: a completed child, or one that names something done on or before the event date, is event-day; an open child that names work after the event is a follow-up. When a child fits neither cleanly, put it in the follow-ups part, since moving open work into the journal hides it. With no follow-ups, the split is the whole task into the journal, and the anchor is deleted once empty; with no event-day children, propose only the rename.

## Rescue off-ladder projects

Projects in flight live off the ladder, so their open tasks never get ranked against the rest and quietly stall. For each root, list every project from the projects metadata (and every off-ladder node a **Themes** anchor names) that is not inside a tier of that root's `📌` ladder and still holds at least one open task:

```bash
./bin/run.js node get --id <project-uuid> --depth 2 --json --fields name,id,shortId,children,completedAt
```

Skip any project listed under **Declined** as a rescue. Each survivor is a **rescue**: move the whole project node, with every task under it, onto a low tier of the ladder. Plan the landing — the bottom tier by default, or `[tier]` when the user names one — with `planRescue`:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/asap-tiers.mts rescue .llm/gtd/review/ladder-<work|personal>.json [tier]
```

The output has the same shape as a group's `insertion` (`targetTier`, `targetId`, `createTiers`). The bottom tier is the default because nothing says a forgotten project outranks what is already filed; the project climbs the ladder through the rebalance walk like any other item.

## Propose #project tags

Finding a group means finding a project, and the ladder holds others that were never tagged. For each root, list every node inside a tier of its `📌` ladder (a direct child of a tier, from `ladder-<work|personal>.json`) whose name has no `#project` tag and that has **3 or more open children**. Skip any node that is already an anchor in this run's group proposals (its tag comes with the group) and any listed under **Declined** as not a project. Read the children when the depth-2 ladder file does not show them:

```bash
./bin/run.js node get --id <node-uuid> --depth 1 --json --fields name,id,shortId,children,completedAt
```

Each survivor is a **tag** proposal. Tagging never moves the node or touches its children.

## Nest projects under umbrellas

A `#project` sitting directly in a tier competes with the broader project it is part of, so the umbrella's rank never covers it and the user cannot see the effort as one tree. For each root, collect:

- **Children** — every `#project` node that is a direct child of a tier, every new group anchor from this run's group proposals, and every node in this run's tag proposals.
- **Umbrellas** — every `#project` node anywhere inside that root's ladder, including ones nested under another node (`Team projects > Platform upgrades #project`). The depth-2 ladder file shows only the top level, so read each top-level node's subtree for nested `#project` nodes:

```bash
./bin/run.js node get --id <top-level-node-uuid> --depth 3 --json --fields name,id,shortId,children,completedAt
```

A child belongs under an umbrella when an **Umbrellas** bullet maps it there, or when the umbrella's name or its existing child projects describe a broader effort the child is one part of (the child's distinctive noun phrase is a kind of work the umbrella covers, not just a shared generic `#tag`). Never nest across roots, never nest a node under its own descendant, and skip any nesting listed under **Declined**. An umbrella off the ladder is not an umbrella: propose its rescue first and nest on a later run.

**Missing intermediate.** When the right parent is a project that does not exist yet between the child and its umbrella, propose creating it as an intermediate `#project` in the same proposal. That happens when an **Umbrellas** chain names an element with no shortId, or when two or more children nest under the same umbrella and share a theme narrower than the umbrella's own (both are logging migrations under a platform-upgrades umbrella): one intermediate `#project` named for that shared theme holds them both, and each child's nesting names it.

Each survivor is a **nest** proposal. Nesting moves the child node with everything under it; it never renames the child or touches its children. For a new group from this run, the nest replaces the group's tier placement: the group is created inside the umbrella (or intermediate) instead of at the bottom of a tier, so put the nest on the group proposal itself (`anchor.nestUnder`) rather than staging a separate nest.

## Flag agenda and ladder duplicates

While clustering, compare each root's `📋 Meeting agendas` children against its ladder and `⏰` bucket with the same matching rules. A topic that sits in both is a duplicate — the user will either raise it or do it, and keeping both means one of them never gets closed. Flag each pair as its own question with these options: **Keep both** (the agenda item is a real discussion topic and the task is separate work), **Drop the agenda item**, **Drop the task**, **Skip**. Never delete either side unasked.

## Stage proposals

Write `.llm/gtd/review/proposals/group-tasks.json` following `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`. Make **no** Workflowy writes while staging.

```json
{
	"task": "group-tasks",
	"generatedAt": "<ISO-8601 with offset>",
	"status": "ready",
	"presentation": "Group related tasks",
	"summary": {"clusters": 2, "splits": 1, "rescues": 1, "tags": 1, "nests": 1, "duplicates": 1},
	"proposals": [
		{
			"kind": "group",
			"rootKey": "work",
			"theme": "Onboarding @Alice",
			"anchor": {"type": "new", "name": "Onboarding @Alice #project", "tier": 2, "tierId": "<tier-2-uuid>", "tagProject": false},
			"insertion": {"targetTier": 2, "targetId": "<tier-2-uuid>", "createTiers": []},
			"members": [
				{"nodeId": "<uuid>", "name": "Set up 1:1 with @Alice", "fromTier": 2},
				{"nodeId": "<uuid>", "name": "Request repo access for @Alice", "fromTier": 3}
			],
			"relatedDated": [{"nodeId": "<uuid>", "name": "Share the onboarding doc with @Alice", "due": "2026-09-25"}],
			"reason": "all three name @Alice and onboarding"
		},
		{
			"kind": "split",
			"rootKey": "personal",
			"event": {"nodeId": "<uuid>", "name": "@Alice's party", "date": "2026-09-19", "where": "📌 asap → 2nd"},
			"journal": {"dayNodeId": "<uuid-or-null>", "entryId": "<uuid-or-null>", "children": [{"nodeId": "<uuid>", "name": "Pick up the cake", "completed": true}]},
			"followUps": {"name": "@Alice's party follow-ups", "children": [{"nodeId": "<uuid>", "name": "Write thank-you notes"}], "insertion": null},
			"reason": "event date 2026-09-19 has passed; 1 open follow-up"
		},
		{
			"kind": "rescue",
			"rootKey": "personal",
			"project": {"nodeId": "<uuid>", "name": "🌐 Example project", "openTasks": 3},
			"insertion": {"targetTier": 5, "targetId": "<tier-5-uuid>", "createTiers": []},
			"reason": "off the ladder with 3 open tasks"
		},
		{
			"kind": "tag",
			"rootKey": "personal",
			"node": {"nodeId": "<uuid>", "name": "Garden cleanup", "where": "📌 asap → 3rd", "openChildren": 4},
			"reason": "4 open child tasks, no #project tag"
		},
		{
			"kind": "nest",
			"rootKey": "work",
			"node": {"nodeId": "<uuid>", "name": "Replace old logger calls #project", "where": "📌 asap → 4th"},
			"umbrella": {"nodeId": "<uuid>", "name": "Platform upgrades #project", "path": "📌 asap → 1st → Team projects → Platform upgrades #project"},
			"intermediate": {"name": "Logging migration #project"},
			"reason": "Umbrellas maps logger work under Platform upgrades via Logging migration, which does not exist yet"
		},
		{
			"kind": "duplicate",
			"rootKey": "work",
			"agenda": {"nodeId": "<uuid>", "name": "Build times with @Bob"},
			"task": {"nodeId": "<uuid>", "name": "Write up the build-times report #write", "where": "📌 asap → 3rd"},
			"reason": "same distinctive noun phrase: \"build times\""
		}
	]
}
```

`anchor.type` is `new`, `project`, or `task`; `project` and `task` anchors carry `nodeId` instead of `tier` / `tierId`, and `tagProject: true` when their name lacks `#project`; a `new` anchor's name already ends with `#project`, so its `tagProject` is `false`. A `new` anchor that nests carries `nestUnder` with the same `umbrella` and `intermediate` fields as a nest proposal; its `insertion` stays staged for the **Group in a tier instead** fallback. A nest's `intermediate` is `null` when the child moves straight under the umbrella. A split's `journal.dayNodeId` is `null` when the day node must be created, and `followUps.insertion` is the `planRescue` output for a `⏰` anchor, `null` otherwise. `status` is `empty` when nothing clusters, splits, needs rescuing, tagging, or nesting, or duplicates, and `error` if prep failed.

## Walk and apply

Every move is **its own question** — never bundle two clusters, or a cluster and a rescue or duplicate, into one `AskUserQuestion` question. Up to 4 questions per call is fine. Go straight into the first proposal: no meta-question about how to scope the walk, and no comment on the count.

Show every anchor, landing spot, and move target as its full path from the root with the target title, never elided (`${CLAUDE_PLUGIN_ROOT}/skills/destination-paths.md`). For a **group** proposal, show the theme, the anchor and where it lands, and each member with its current tier. Tier occupancy may appear as a plain fact; a full tier is still a valid destination, so never say something will be bumped and never ask a follow-up to confirm it:

```markdown
Group 1/2 (Work): Onboarding @Alice → new node in 📌 asap → 2nd (4/4)

- Set up 1:1 with @Alice (2nd)
- Request repo access for @Alice (3rd)

Related (stays in ⏰): Share the onboarding doc with @Alice (Fri)
```

Options: **Group** (as proposed), **Group under a different anchor** (the user names it), **Drop a member** (the user names it; re-plan with the remaining members), **Keep separate**. For a new group, also offer **Group in a different tier** (the user names it; re-plan with `planGroup` and that `[tier]`) — the default is the members' highest tier. A new group with `nestUnder` shows its landing as the umbrella's full path (plus `→ <intermediate> (new)` when one is created) and offers **Group in a tier instead** in place of **Group in a different tier**, which drops the nesting and files the group by its staged `insertion`.

On **Group**, dispatch the ops as one background Bash job per the **Background Dispatch, Verify, and Drain** protocol in `${CLAUDE_PLUGIN_ROOT}/skills/review-date-updates.md`, chained with `&&` so a failed step stops the chain:

- For a new group: create any `createTiers`, then `node create --parent-id <insertion.targetId> --name '<group name> #project' --position bottom` and read the new node's full UUID from its output. With `nestUnder`, skip the tiers: create the intermediate first when there is one (`node create --parent-id <umbrellaUuid> --name '<intermediate name>' --position bottom`), then the group under the intermediate or umbrella.
- For an existing anchor with `tagProject: true`: `node update --id <anchorUuid> --name '<anchor name> #project'`, appending the tag to the anchor's current name exactly as read.
- Move each member in `members` order: `node move --node-id <memberUuid> --parent-id <anchorUuid> -p bottom`. Moving in that order is what leaves the children sorted by former tier. A member's own children travel with it.
- Do not rename or re-tag any member; only the anchor gains `#project`.

On **Keep separate**, append the cluster to the **Declined** section of `.llm/gtd/task-groups.md` so it is not proposed again. On **Group**, append or update the theme under **Themes** with its identifying words and the anchor's shortId, so the next run recognizes it; a nested group also gets an **Umbrellas** bullet with its chain. On **Group in a tier instead**, append the declined nesting to **Declined**. Append — never rewrite the file wholesale.

For a **split** proposal, show the event, its date, and both parts with their full destinations:

```markdown
Split (Personal): @Alice's party (Sat, Sep 19) — the event has passed

Journal → 📅 Calendar → Sat, Sep 19, 2026:
- Pick up the cake (done)

Stays as "@Alice's party follow-ups" in 📌 asap → 2nd:
- Write thank-you notes
```

Options: **Split** (as proposed), **Move a child to the other part** (the user names it; re-ask with the change), **Group instead** (fall back to the ordinary group proposal for this anchor), **Keep as is**. On **Split**, dispatch as one chained background job: create the day node if missing, `node uncomplete` each completed journal child, `node move --node-id <childUuid> --parent-id <dayNodeId-or-entryId> -p bottom` for each journal child in order, then `node update --id <anchorUuid> --name '<event> follow-ups'` and, for a `⏰` anchor, any `createTiers` and `node move --node-id <anchorUuid> --parent-id <insertion.targetId> -p bottom`. With no follow-ups, `node delete --id <anchorUuid>` last, only after every child has moved. On **Keep as is**, append the split to **Declined**.

For a **rescue** proposal, show the project, its open-task count, and where it lands:

```markdown
Rescue (Personal): 🌐 Example project (3 open tasks) → 📌 asap → 5th (bottom)
```

Options: **Rescue** (as proposed), **Rescue in a different tier** (the user names it; re-plan with `planRescue` and that `[tier]`), **Leave off the ladder**. On **Rescue**, dispatch like a new group — any `createTiers`, then `node move --node-id <projectUuid> --parent-id <insertion.targetId> -p bottom`. The project's tasks travel with it; do not rename or re-tag it. On **Leave off the ladder**, append the rescue to **Declined**. A **Themes** bullet that named the project as its anchor stays valid once the project is on the ladder; update its location note.

For a **tag** proposal, show the node, where it sits, and its open children:

```markdown
Tag #project (Personal): Garden cleanup in 📌 asap → 3rd (4 open tasks)

- Rake the leaves
- Prune the hedge
- …
```

Options: **Tag #project**, **Not a project**. On **Tag #project**, dispatch `node update --id <nodeUuid> --name '<node name> #project'` as a background job, appending the tag to the current name exactly as read. On **Not a project**, append it to **Declined** (`- <date>: tag <name> (<shortId>) — not a project`) so it is not proposed again.

For a **nest** proposal, show the child, where it sits now, and its full landing path, marking an intermediate that will be created:

```markdown
Nest (Work): Replace old logger calls #project (📌 asap → 4th)
→ 📌 asap → 1st → Team projects → Platform upgrades #project → Logging migration #project (new)
```

Options: **Nest** (as proposed), **Nest under a different project** (the user names it; re-ask with that umbrella, keeping or dropping the intermediate as they say), **Skip the intermediate** (when one is proposed; nest straight under the umbrella), **Keep at top level**. On **Nest**, dispatch as one chained background job: `node create --parent-id <umbrellaUuid> --name '<intermediate name>' --position bottom` when an intermediate is created (read its full UUID from the output), then `node move --node-id <childUuid> --parent-id <intermediate-or-umbrella-uuid> -p bottom`. When several nest proposals share one new intermediate, create it on the first accepted one and move the later children under it. Append or update the child's **Umbrellas** bullet with its identifying words and the chain's shortIds, so later groups and projects on that theme nest without being rediscovered. On **Keep at top level**, append the nesting to **Declined**.

For a **duplicate** proposal, apply the chosen side's delete with `node delete --id <uuid>`, or nothing on **Keep both** / **Skip**.

## Finish

Drain every background job and surface failures by group name. Print one line — e.g. `✓ 2 groups (1 new in 2nd, 1 under an existing project), 5 tasks moved, 1 past event split (2 to the journal, 1 follow-up kept), 1 project rescued to 5th, 2 nodes tagged #project, 1 project nested under Platform upgrades (1 intermediate created), 1 agenda duplicate dropped, 1 kept separate` — or say nothing when `status` was `empty`. Leave over-cap tiers alone; the user fixes them in `/gtd:review:daily:rebalance`.
