---
description: Workflowy HTML formatting - URLs (short ID format), links, dates, colors, text styling. Use when creating nodes with links, URLs, or dates. Short ID = last 12 hex chars of UUID for workflowy.com/#/ URLs.
---

# Workflowy HTML Formatting

Workflowy stores rich text as HTML elements in node names. This skill covers all supported HTML formatting.

## Links

Internal links use HTML anchor tags:

```html
<a href="https://workflowy.com/#/SHORT_ID">Display Text</a>
```

**Example:**

```html
📎 Related: <a href="https://workflowy.com/#/abc123def456">Write ideas to descope</a>
```

**Short ID format:** Last 12 hex characters of the full UUID (without dashes).

| Full UUID                              | Short ID       |
| -------------------------------------- | -------------- |
| `61111c3a-e939-d4dc-1a8c-6bf42551caa3` | `6bf42551caa3` |

**Creating links via CLI:**

> Run `./bin/run.js node create --help` to verify available flags before constructing commands.

```bash
./bin/run.js node create --parent-id <PARENT> \
  --name '📎 See <a href="https://workflowy.com/#/abc123def456">related item</a>' \

```

## Dates

Workflowy supports bracket syntax for dates, which the **web UI** converts to native date elements (it does **not** convert on API/CLI write — see the CLI note below):

**Date Format:**

```text
[YYYY-MM-DD]
```

**DateTime Format:**

```text
[YYYY-MM-DD HH:MM]
```

**Examples:**

```text
[2025-12-25]                    -> Thu, Dec 25, 2025
[2025-12-18 18:00]              -> Thu, Dec 18, 2025 at 6:00 PM
due [2025-01-15]                -> due Wed, Jan 15, 2025
```

**Important:** Use ISO 8601 format with zero-padded values: `[2025-01-05]` not `[2025-1-5]`.

**Creating date nodes via CLI:**

The CLI/API stores names **verbatim** — a bracket date written via `node create`/`node update` stays the literal text `[2025-12-25]` and does **not** become a clickable date element until the user runs the Workflowy web UI "Update" migration. (Verified: a CLI-written `[2026-06-12]` reads back as plain text, not a `<time>` element.)

So there are two paths:

- **Deferred conversion (journal ingestion):** write the bracket text via CLI, then later convert+reorganize everything with the web UI "Update" button. Fine when the date doesn't need to render immediately.
- **Immediate date element (most CLI writes — calendar day nodes, due dates, review date advancement):** write the explicit `<time>` element directly. **Compute its weekday label with the `date` command — never type the weekday by hand** (the model regularly picks the wrong weekday):

```bash
ISO=2025-12-25
TIME_EL=$(printf '<time startYear="%s" startMonth="%s" startDay="%s">%s</time>' \
  "$(date -j -f %Y-%m-%d "$ISO" +%Y)" \
  "$(date -j -f %Y-%m-%d "$ISO" +%-m)" \
  "$(date -j -f %Y-%m-%d "$ISO" +%-d)" \
  "$(date -j -f %Y-%m-%d "$ISO" '+%a, %b %-d, %Y')")
./bin/run.js node create --parent-id <PARENT> --name "$TIME_EL"
```

`startMonth`/`startDay` are not zero-padded. See `calendar-dates` and `review-date-updates` for the full date-node workflow.

## Text Formatting

### Bold

```html
<b>bold text</b>
```

### Italic

```html
<i>italic text</i>
```

### Underline

```html
<u>underlined text</u>
```

### Combined

```html
<b><i>bold and italic</i></b>
```

## Colors

Colors use `<span>` with CSS classes:

```html
<span class="colored c-COLOR">colored text</span>
```

**Available colors (9):**

| Class      | Color    |
| ---------- | -------- |
| `c-blue`   | Blue     |
| `c-green`  | Green    |
| `c-sky`    | Sky blue |
| `c-orange` | Orange   |
| `c-red`    | Red      |
| `c-teal`   | Teal     |
| `c-purple` | Purple   |
| `c-gray`   | Gray     |
| `c-yellow` | Yellow   |

**Example:**

```html
<span class="colored c-red">Important!</span> Review this by Friday
```

**Creating colored nodes via CLI:**

```bash
./bin/run.js node create --parent-id <PARENT> \
  --name '<span class="colored c-green">Done</span> - Task completed' \

```

## Parsing HTML in SQLite

**Find nodes with links:**

```sql
SELECT id, name FROM node_content
WHERE name LIKE '%<a href="https://workflowy.com%'
AND system_to = 9007199254740991;
```

**Find nodes with dates:**

```sql
SELECT id, name FROM node_content
WHERE name LIKE '%<time %'
AND system_to = 9007199254740991;
```

**Find nodes with specific color:**

```sql
SELECT id, name FROM node_content
WHERE name LIKE '%c-red%'
AND system_to = 9007199254740991;
```

## Regex Patterns (TypeScript)

```typescript
// Extract links
const linkRegex = /<a href="https:\/\/workflowy\.com\/#\/([a-f0-9]+)">([^<]+)<\/a>/g;

// Extract dates
const dateRegex = /<time[^>]*startYear="(\d+)"[^>]*startMonth="(\d+)"[^>]*startDay="(\d+)"[^>]*>([^<]+)<\/time>/g;

// Extract colors
const colorRegex = /<span class="colored (c-\w+)">([^<]+)<\/span>/g;
```

## Link vs Mirror

- **Link**: HTML anchor that navigates to another node. Content NOT synced.
- **Mirror**: Live reference that syncs content. Stored in `mirrors` table, not as HTML. Create one with `./bin/run.js node mirror --node-id <origin> --parent-id <parent>` and remove one with `./bin/run.js node mirror --node-id <mirror> --delete`.

## Best Practices

- **Always use proper HTML format** - Don't append raw URLs; use `<a href="...">text</a>`
- **Display text should be meaningful** - Don't repeat the URL as display text
- **Dates should match display** - The text inside `<time>` should match the attributes
- **Colors for visual hierarchy** - Use colors consistently (e.g., green=done, red=urgent)
