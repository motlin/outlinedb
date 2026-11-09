---
name: gtd-content-scheduling
description: Track blog posts and content through the content pipeline - Ideas, Drafts, Scheduled, Published. Use during daily review to show content pipeline status.
---

# GTD Content Scheduling

This skill tracks blog posts and content through a pipeline of states. Integrate into daily review to surface upcoming deadlines and content status.

## Content Pipeline States

Content moves through these states in Workflowy:

- **Ideas** - Raw content ideas captured for later
- **Drafts** - Content currently being written
- **Scheduled** - Content ready and scheduled for publication
- **Published** - Content that has been published (archive)

## Expected Workflowy Structure

The content pipeline should be structured under a Content node:

```
Personal
  └── 📝 Content
      ├── 💡 Ideas
      │   └── Content idea 1
      │   └── Content idea 2
      ├── 📄 Drafts
      │   └── Draft post title (target: 2025-01-15)
      │   └── Another draft
      ├── 📅 Scheduled
      │   └── Ready post (publish: 2025-01-10)
      └── ✅ Published
          └── Published post (2024-12-01)
```

## Metadata Configuration

Add content paths to `Metadata` node. Create a "📝 Content" child under Metadata with links:

```
Metadata
  └── 📝 Content
      └── [[link]] → Personal > 📝 Content
```

The link points to the content root node containing Ideas/Drafts/Scheduled/Published children.

## Querying Content Status

### List All Content Pipeline Items

```bash
# Get the Content root path from your configuration, then:
./bin/run.js utils path-to-id --path "📝 Content,💡 Ideas" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
./bin/run.js utils path-to-id --path "📝 Content,📄 Drafts" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
./bin/run.js utils path-to-id --path "📝 Content,📅 Scheduled" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
./bin/run.js utils path-to-id --path "📝 Content,✅ Published" --data-source cache | xargs -I{} ./bin/run.js node list --parent-id {}
```

### Extracting Date Information

Content items may include date information in their names:

- **Target dates** for drafts: `Draft title (target: YYYY-MM-DD)`
- **Publish dates** for scheduled: `Post title (publish: YYYY-MM-DD)`
- **Published dates** for archive: `Post title (YYYY-MM-DD)`

Parse dates using regex:

```
\(target:\s*(\d{4}-\d{2}-\d{2})\)
\(publish:\s*(\d{4}-\d{2}-\d{2})\)
\((\d{4}-\d{2}-\d{2})\)
```

## Daily Review Integration

During daily review, show content pipeline status:

### Calculating Days Until Due

For scheduled content with publish dates:

- Parse the publish date from the node name
- Calculate days until publication: `publish_date - today`
- Flag items due within 7 days

For drafts with target dates:

- Parse the target date from the node name
- Calculate days until target: `target_date - today`
- Flag overdue items (negative days)

### Format for Daily Review

```
CONTENT PIPELINE

Next post due in 3 days:
  Status: scheduled
  "Blog Post Title" (publish: 2025-01-10)

Drafts (2):
  "Draft in progress" (target: 2025-01-08) - 1 day overdue!
  "Another draft" (target: 2025-01-20) - 13 days remaining

Ideas backlog: 5 items

Weekly goal: 1 post per week
Last published: "Previous Post" (2025-01-03) - 4 days ago
```

### Key Metrics

- **Days until next scheduled post** - Alert if within 3 days or overdue
- **Drafts in progress** - Show count and any overdue targets
- **Time since last publish** - Alert if approaching weekly cadence
- **Ideas backlog** - Just show count for awareness

## Creating Content Items

### Add a New Idea

```bash
./bin/run.js node create --parent-path "📝 Content,💡 Ideas" --name "New content idea"
```

### Promote Idea to Draft

```bash
TODAY=$(date +%Y-%m-%d)
TARGET=$(date -v+7d +%Y-%m-%d)
./bin/run.js node create --parent-path "📝 Content,📄 Drafts" --name "Draft title (target: $TARGET)"
# Then delete from Ideas
```

### Schedule a Draft

```bash
./bin/run.js node move --node-path "📝 Content,📄 Drafts,Draft title" --parent-path "📝 Content,📅 Scheduled"
# Update the name to include publish date
```

### Mark as Published

```bash
TODAY=$(date +%Y-%m-%d)
./bin/run.js node move --node-path "📝 Content,📅 Scheduled,Post title" --parent-path "📝 Content,✅ Published"
# Update name to: "Post title ($TODAY)"
```

## Workflow Commands

### Quick Capture Content Idea

From inbox processing or daily review:

```bash
./bin/run.js node create --parent-path "📝 Content,💡 Ideas" --name "$IDEA_TEXT #content"
```

The `#content` tag helps identify content-related items in inbox.

### Content Weekly Review

During weekly review, check:

- Did we publish 1 post this week?
- Are there drafts that have stalled (target date > 2 weeks overdue)?
- Are there enough ideas in the pipeline (goal: 5+ ideas)?
- Is there scheduled content for next week?

## Graceful Fallback

If Content paths are not configured:

- Skip the content section silently in daily review
- Or show: "(Content tracking not configured - create Personal > 📝 Content with 💡 Ideas/📄 Drafts/📅 Scheduled/✅ Published children)"

Do NOT fail the daily review if content tracking is unavailable. It's an optional enhancement.
