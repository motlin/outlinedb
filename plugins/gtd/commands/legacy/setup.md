---
description: Deprecated legacy GTD setup wizard — first-run configuration of Workflowy paths, people, projects, hobbies, and contexts from your data sources. Run once during initial setup; reach for this only when explicitly invoked.
---

# GTD Setup Wizard

> Legacy command. First-run setup only; use when explicitly invoked.

Walks through the complete setup for GTD automation with OutlineDB CLI, including discovery of people, projects, and contexts from your data sources.

## Overview

This command guides users through:

- Prerequisites check (OutlineDB CLI, iMCP, GitHub CLI)
- GTD path configuration in Workflowy
- **Data source discovery** - contacts, recent Workflowy activity
- **People interview** - identify key relationships
- **Projects discovery** - find and register active projects
- **Hobbies discovery** - find and register hobbies/obsessions
- **Content pipeline setup** - blog/content tracking (optional)
- **Context configuration** - set up location/mode tags
- Verification of all integrations

## Prerequisites

### OutlineDB CLI

```bash
./bin/run.js --version
```

### iMCP Setup

```bash
ls /Applications/iMCP.app 2>/dev/null && echo "Installed" || echo "Not installed"
```

If not installed, offer:

- "Yes, install via Homebrew" → `brew install --cask mattt/tap/iMCP`
- "No, skip macOS integrations"

If installed, verify MCP connection:

```bash
claude mcp list 2>&1 | grep -q "imcp" && echo "Configured" || echo "Not configured"
```

#### Verify iMCP Features

After confirming iMCP is installed, test each integration:

**Calendar access:**

```text
mcp__imcp__calendars_list
```

If this returns calendar names, calendar integration is working.

**Reminders access:**

```text
mcp__imcp__reminders_lists
```

If this returns reminder list names, reminders integration is working.

**Messages access:**

```text
mcp__imcp__messages_fetch with:
  limit: 1
```

If this returns a message, iMessage integration is working.

**Note on Messages:** The iMessage integration is READ-ONLY. The `messages_fetch` tool cannot mark messages as read or modify them in any way. This is intentional for safety.

Present results:

```text
iMCP Integration Status:
  Calendar: ✓ (5 calendars found)
  Reminders: ✓ (3 lists found)
  Messages: ✓ (read-only access confirmed)
```

If any integration fails, note which permission may need to be granted in System Settings > Privacy & Security.

### GitHub CLI

```bash
which gh && gh auth status 2>&1 | grep -q "Logged in" && echo "Ready" || echo "Not ready"
```

## Data Source Discovery

### Discover from Contacts

If iMCP is available, gather context about the user:

**Get user's own contact info:** Use `mcp__imcp__contacts_me` to get:

- User's name
- Phone numbers (home, work, mobile)
- Email addresses
- Relationships listed
- Work organization

This helps understand the user's context (personal name, employer, etc.)

**Search for close relationships:** Use `mcp__imcp__contacts_search` to find contacts with relationship labels:

- Search for contacts with notes containing "family", "spouse", "child", etc.
- Look for emergency contacts
- Find frequent contacts from recent messages

### Discover from Workflowy

Use the `read-metadata` skill to discover existing GTD configuration, including:

- People (organized by group: Work, Family, Friends)
- 📁 Projects registry (registered project tags with metadata)
- Hobbies Registry (current and archived hobbies)

**Semantic search for recent activity:**

Use `search --query` with descriptive queries to find relevant content in the user's Workflowy. Let the user guide what to search for based on their context. Example searches:

- Recent projects or initiatives
- People mentioned in notes
- Topics being worked on

### Discover from Calendar

If iMCP calendar is available:

```bash
# Use mcp__imcp__events_fetch to get upcoming events
```

Look for:

- Recurring meeting participants (potential key people)
- Meeting locations (potential contexts)
- Project-related calendar entries

### Present Discovery Summary

Before the interview, show what was discovered:

```text
📊 DISCOVERY SUMMARY
════════════════════════════════════════

From Contacts:
  Your name: [Name from contacts_me]
  Organization: [Company name if found]
  Relationships found: [List family/close contacts]

From Workflowy Metadata:
  People: @Alice (Family), @Bob (Work), @Charlie (Friends)
  Projects: #kitchen-reno, #quarterly-report
  Hobbies: #sourdough, #pickleball

From Calendar:
  Frequent meeting participants: Dan, Emily, Frank
  Common locations: Main Office, Conference Room A

════════════════════════════════════════
```

## People Interview

### Confirm Discovered People

Present discovered people and ask:

- "I found these people mentioned. Which are important for GTD tracking?"
- Show checkboxes for each discovered person
- Allow user to add more

### Immediate Family

Use AskUserQuestion to ask about family members:

**Question: "Who are your immediate family members?"** Ask for each:

- Name
- Relationship (spouse, child, parent, sibling)
- Tag format confirmation (e.g., "@Alice" or "@Alice-wife")

Create entries in Metadata > 👥 People > 👨‍👩‍👧‍👦 Family:

```bash
./bin/run.js node create --parent-path "Metadata,👥 People,👨‍👩‍👧‍👦 Family" --name "@Alice"
./bin/run.js node create --parent-path "Metadata,👥 People,👨‍👩‍👧‍👦 Family,@Alice" --name "Relationship: spouse"
./bin/run.js node create --parent-path "Metadata,👥 People,👨‍👩‍👧‍👦 Family,@Alice" --name "Full name: Alice Smith"
```

### Work Relationships

#### Question: "Who do you work with regularly?"

Categories to ask about:

- Direct manager/boss
- Direct reports (if any)
- Key stakeholders/collaborators
- Clients (if applicable)

For each work person:

```bash
./bin/run.js node create --parent-path "Metadata,👥 People,👔 Work" --name "@BobSmith"
./bin/run.js node create --parent-path "Metadata,👥 People,👔 Work,@BobSmith" --name "Relationship: manager"
./bin/run.js node create --parent-path "Metadata,👥 People,👔 Work,@BobSmith" --name "Full name: Bob Smith"
```

### Regular Contacts

#### Question: "Anyone else you interact with regularly for GTD purposes?"

Examples to prompt:

- Doctors, dentists, therapists
- Financial advisors, accountants
- Contractors, service providers
- Close friends (→ 🤝 Friends group)

## Projects Discovery

### Active Projects

#### Question: "What are your current active projects?"

Present any discovered projects from Workflowy and ask:

- Which are still active?
- What's the short tag for each? (e.g., `#kitchen-reno`)
- Which context (Personal or Work)?

### Register Projects

For each confirmed project, create a link node in the 📁 Projects registry with metadata children:

```bash
# Create link node (using short_id from the project node)
./bin/run.js node create --parent-path "Metadata,📁 Projects,Personal 📁 Projects" \
  --name '<a href="https://workflowy.com/#/SHORT_ID">Project Name #project-tag</a>'

# Add metadata children
./bin/run.js node create --parent-path "Metadata,📁 Projects,Personal 📁 Projects,Project Name #project-tag" \
  --name "Status: active"
./bin/run.js node create --parent-path "Metadata,📁 Projects,Personal 📁 Projects,Project Name #project-tag" \
  --name "Default contexts: #home #call"
./bin/run.js node create --parent-path "Metadata,📁 Projects,Personal 📁 Projects,Project Name #project-tag" \
  --name "People: @relevant-people"
```

## Hobbies Discovery

### Discover Hobbies from Workflowy

Use the `read-metadata` skill to check the Hobbies Registry (under `Metadata > Hobbies Registry`). This will show:

- Current hobbies (active)
- Archived hobbies (inactive)

If hobbies are not yet registered, use `search --query` with hobby-related terms based on user context to discover interests.

### Analyze Activity

For each discovered hobby, check last modified timestamps to determine:

- **Active**: Modified within last 3 months
- **Inactive**: Not modified in 3+ months

Note the activity period for each hobby.

### Hobbies Interview

#### Question: "What are your current hobbies and interests?"

Present discovered hobbies and ask:

- Which are still active?
- Any hobbies to add that weren't discovered?
- Who do you share each hobby with? (e.g., family members, friends)
- When did each hobby start?

### Create Hobbies Registry

Create the Hobbies Registry in Metadata if it doesn't exist:

```bash
./bin/run.js node create --parent-path "Metadata" --name "🎮 Hobbies Registry"
./bin/run.js node create --parent-path "Metadata,🎮 Hobbies Registry" --name "🟢 Current"
./bin/run.js node create --parent-path "Metadata,🎮 Hobbies Registry" --name "📦 Archived"
```

For each active hobby (under 🟢 Current, sorted by start date):

```bash
./bin/run.js node create --parent-path "Metadata,🎮 Hobbies Registry,🟢 Current" --name "#hobby-tag"
./bin/run.js node create --parent-path "Metadata,🎮 Hobbies Registry,🟢 Current,#hobby-tag" --name "Description of the hobby"
./bin/run.js node create --parent-path "Metadata,🎮 Hobbies Registry,🟢 Current,#hobby-tag" --name "Start: 2021"
./bin/run.js node create --parent-path "Metadata,🎮 Hobbies Registry,🟢 Current,#hobby-tag" --name "Play with: @PersonName"
```

For inactive hobbies (under 📦 Archived, sorted by start date):

```bash
./bin/run.js node create --parent-path "Metadata,🎮 Hobbies Registry,📦 Archived" --name "#hobby-tag"
./bin/run.js node create --parent-path "Metadata,🎮 Hobbies Registry,📦 Archived,#hobby-tag" --name "Description of the hobby"
./bin/run.js node create --parent-path "Metadata,🎮 Hobbies Registry,📦 Archived,#hobby-tag" --name "Start: 2019"
./bin/run.js node create --parent-path "Metadata,🎮 Hobbies Registry,📦 Archived,#hobby-tag" --name "End: Mar 2020"
```

**Note**: Don't add colors to hashtags via the API — colors can only be applied through the Workflowy UI.

## Content Pipeline Setup (Optional)

Set up content/blog tracking for writers who want to maintain a publishing cadence.

### Check for Existing Content Structure

```bash
./bin/run.js utils path-to-id --path "📝 Content" 2>/dev/null | xargs -I{} ./bin/run.js node list --parent-id {} || echo "Not found"
./bin/run.js utils path-to-id --path "📝 Blog" 2>/dev/null | xargs -I{} ./bin/run.js node list --parent-id {} || echo "Not found"
./bin/run.js utils path-to-id --path "📝 Writing" 2>/dev/null | xargs -I{} ./bin/run.js node list --parent-id {} || echo "Not found"
```

### Content Interview

#### Question: "Do you write blog posts or create content regularly?"

Options:

- "Yes, I want to track content" → Continue setup
- "No, skip content tracking" → Skip this section

If yes, ask:

- **Publishing goal:** "How often do you want to publish?" (e.g., weekly, bi-weekly, monthly)
- **Content location:** "Where should the content pipeline live?" (e.g., Personal > Content, Personal > Blog)

### Create Content Structure

If content structure does not exist, create it:

```bash
./bin/run.js node create --parent-path "Personal" --name "Content"
./bin/run.js node create --parent-path "📝 Content" --name "Ideas"
./bin/run.js node create --parent-path "📝 Content" --name "Drafts"
./bin/run.js node create --parent-path "📝 Content" --name "Scheduled"
./bin/run.js node create --parent-path "📝 Content" --name "Published"
```

### Add to Metadata

Create a Content entry in Metadata with a link to the content root:

```bash
./bin/run.js node create --parent-path "Metadata" --name "Content"
./bin/run.js node create --parent-path "Metadata,Content" --name "[[link to Personal > Content]]"
./bin/run.js node create --parent-path "Metadata,Content" --name "Goal: 1 post per week"
```

**Note:** The `[[link]]` syntax creates a Workflowy internal link. The user may need to manually create this link in the Workflowy UI by typing `[[` and selecting the target node.

### Content Date Formats

Explain the date format conventions to the user:

- **Ideas:** No date needed, just the topic
- **Drafts:** `Draft title (target: YYYY-MM-DD)` - when you aim to finish
- **Scheduled:** `Post title (publish: YYYY-MM-DD)` - publication date
- **Published:** `Post title (YYYY-MM-DD)` - date published

### Seed Initial Ideas (Optional)

#### Question: "Do you have any content ideas to add now?"

For each idea provided:

```bash
./bin/run.js node create --parent-path "📝 Content,Ideas" --name "Content idea title"
```

## Context Configuration

### Location Contexts

#### Question: "What are your main work locations?"

Common options:

- Home office (`#home`)
- Corporate office (`#office`)
- Specific locations (`#downtown`, `#client-site`)
- Mobile/anywhere (`#anywhere`)

### Mode Contexts

#### Question: "How do you typically work?"

Confirm which mode tags are relevant:

- `#phone` or `#call` - Can make calls
- `#email` - Can send emails
- `#read` - Has reading material
- `#errands` - Out doing errands

### Time Contexts (Optional)

#### Question: "Do you have specific time-based contexts?"

Examples:

- `#morning` - Best for deep work
- `#afternoon` - Good for meetings
- `#evening` - Personal time
- `#weekend` - Weekend-only tasks

### Store Context Configuration

Create a context reference in Metadata:

```bash
./bin/run.js node create --parent-path "Metadata" --name "🏷️ Context Tags"
./bin/run.js node create --parent-path "Metadata,🏷️ Context Tags" --name "Locations: #home, #office, #errands, #anywhere"
./bin/run.js node create --parent-path "Metadata,🏷️ Context Tags" --name "Modes: #call, #email, #read"
./bin/run.js node create --parent-path "Metadata,🏷️ Context Tags" --name "Energy: #deep-work, #low-energy"
```

## Verification

### Run Verification Checks

```bash
# Check OutlineDB CLI
./bin/run.js node list 2>/dev/null && echo "✓ OutlineDB CLI"

# Check Metadata structure
./bin/run.js utils path-to-id --path "Metadata,👥 People" | xargs -I{} ./bin/run.js node list --parent-id {} && echo "✓ People configured"
./bin/run.js utils path-to-id --path "Metadata,📁 Projects" | xargs -I{} ./bin/run.js node list --parent-id {} && echo "✓ Projects configured"
./bin/run.js utils path-to-id --path "Metadata,🎮 Hobbies Registry" | xargs -I{} ./bin/run.js node list --parent-id {} && echo "✓ Hobbies configured"
./bin/run.js utils path-to-id --path "Metadata,Content" 2>/dev/null | xargs -I{} ./bin/run.js node list --parent-id {} && echo "✓ Content configured" || echo "- Content not configured (optional)"

# Check iMCP
claude mcp list 2>&1 | grep -q "imcp.*Connected" && echo "✓ iMCP connected"

# Check gh
gh auth status 2>&1 | grep -q "Logged in" && echo "✓ GitHub CLI"
```

### Display Setup Summary

```text
GTD SETUP COMPLETE
════════════════════════════════════════

Infrastructure:
  OutlineDB CLI:     ✓ Working
  GTD Paths:         ✓ Configured
  iMCP:              ✓ Connected
    - Calendar:      ✓ Working
    - Reminders:     ✓ Working
    - Messages:      ✓ Working (read-only)
  GitHub CLI:        ✓ Authenticated

People Configured:
  Family: @Alice (spouse), @Bob (child)
  Work: @DanSmith (manager), @EmilyBrown (colleague)
  Friends: @CharlieDavis

Projects Registered:
  #kitchen-reno (Personal)
  #quarterly-report (Work)
  #vacation-planning (Personal)

Hobbies Registered:
  Current: #sourdough, #pickleball, #mechanical-keyboards
  Archived: #disc-golf, #vinyl-collecting

Content Pipeline:
  Location: Personal > Content
  Goal: 1 post per week
  Ideas: 5 | Drafts: 2 | Scheduled: 1

🏷️ Context Tags:
  Locations: #home, #office, #errands, #anywhere
  Modes: #call, #email, #read

════════════════════════════════════════

Ready to use:
  /gtd          - Smart orchestrator
  /gtd:review:daily             - Morning review
  /gtd:legacy:reviews:weekly   - Weekly review
  /gtd:inbox    - Process inbox
  /gtd:legacy:focus    - Get suggestions
  /gtd:capture  - Quick capture
```

## Notes

- This setup can be re-run to add more people/projects/hobbies later
- People and projects are stored in Workflowy Metadata for portability
- Context tags are flexible - add more as needed
- Use `gtd-tagging` skill for tag format reference
- Colors must be applied through the Workflowy UI, not the API
