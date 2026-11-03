// Render the daily review's morning overview as a standalone HTML page, so it is opened in the
// browser instead of scrolling past in the console.
//
// Usage: render-overview.mts <overview.json> <overview.html>
// Writes the page and prints its path. Item text is plain text; Workflowy entities (&amp;) are
// decoded before escaping so they are not shown double-escaped.

import {writeFileSync} from "node:fs";
import {arrayField, errorMessage, expectArray, expectObject, readJsonFile, stringField} from "./json.mts";
import type {JsonObject} from "./json.mts";

const USAGE = "Usage: render-overview.mts <overview.json> <overview.html>";

export interface OverviewLink {
	label: string;
	href: string;
}

export interface OverviewItem {
	text: string;
	href?: string;
	note?: string;
	highlight?: boolean;
}

export interface OverviewGroup {
	heading?: string;
	items: OverviewItem[];
}

export interface OverviewSection {
	heading: string;
	link?: OverviewLink;
	groups: OverviewGroup[];
	notes?: string[];
}

export interface Overview {
	title: string;
	subtitle?: string;
	sections: OverviewSection[];
}

const ENTITIES: Record<string, string> = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'"};

function escape(text: string): string {
	return text
		.replaceAll(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => ENTITIES[entity] ?? entity)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function renderItem(item: OverviewItem): string {
	const text =
		item.href === undefined ? escape(item.text) : `<a href="${escape(item.href)}">${escape(item.text)}</a>`;
	const note = item.note === undefined ? "" : ` <span class="note">${escape(item.note)}</span>`;
	return `<li${item.highlight === true ? ' class="highlight"' : ""}>${text}${note}</li>`;
}

function renderGroup(group: OverviewGroup): string {
	const heading = group.heading === undefined ? "" : `<h3>${escape(group.heading)}</h3>`;
	const body =
		group.items.length === 0 ? '<p class="empty">None</p>' : `<ul>${group.items.map(renderItem).join("")}</ul>`;
	return `${heading}${body}`;
}

function renderSection(section: OverviewSection): string {
	const link =
		section.link === undefined
			? ""
			: ` <a class="section-link" href="${escape(section.link.href)}">${escape(section.link.label)}</a>`;
	return [
		`<section><h2>${escape(section.heading)}${link}</h2>`,
		...section.groups.map(renderGroup),
		...(section.notes ?? []).map((note) => `<p class="section-note">${escape(note)}</p>`),
		"</section>",
	].join("\n");
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1d1d1f; --muted: #6e6e73; --card: #fff; --line: #e5e5ea; --accent: #0a66c2; --hi: #fff4d6; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --fg: #f2f2f7; --muted: #a1a1a6; --card: #2c2c2e; --line: #3a3a3c; --accent: #64a8ff; --hi: #4a3b12; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { margin: 0; font-size: 1.6rem; }
.subtitle { margin: 4px 0 0; color: var(--muted); }
section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 18px; margin-top: 16px; }
h2 { font-size: 1.15rem; margin: 4px 0 8px; }
h3 { font-size: 0.95rem; color: var(--muted); margin: 10px 0 4px; }
ul { margin: 0; padding-left: 20px; }
li { margin: 2px 0; }
li.highlight { background: var(--hi); border-radius: 4px; }
a { color: var(--accent); }
.section-link { font-size: 0.85rem; font-weight: normal; margin-left: 8px; }
.note, .empty, .section-note { color: var(--muted); }
.empty { margin: 0; font-style: italic; }
.section-note { margin: 8px 0 0; }
`;

export function renderOverview(overview: Overview): string {
	const subtitle = overview.subtitle === undefined ? "" : `<p class="subtitle">${escape(overview.subtitle)}</p>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(overview.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${[`<header><h1>${escape(overview.title)}</h1>${subtitle}</header>`, ...overview.sections.map(renderSection)].join("\n")}
</main>
</body>
</html>
`;
}

function requiredString(object: JsonObject, key: string, what: string): string {
	const value = stringField(object, key);
	if (value === undefined) {
		throw new TypeError(`${what}.${key} must be a string`);
	}
	return value;
}

function parseItem(value: unknown, what: string): OverviewItem {
	const object = expectObject(value, what);
	return {
		text: requiredString(object, "text", what),
		href: stringField(object, "href"),
		note: stringField(object, "note"),
		highlight: object.highlight === true,
	};
}

function parseSection(value: unknown, what: string): OverviewSection {
	const object = expectObject(value, what);
	const link = object.link === undefined ? undefined : expectObject(object.link, `${what}.link`);
	return {
		heading: requiredString(object, "heading", what),
		link:
			link === undefined
				? undefined
				: {
						label: requiredString(link, "label", `${what}.link`),
						href: requiredString(link, "href", `${what}.link`),
					},
		groups: expectArray(object.groups, `${what}.groups`).map((group, index) => {
			const groupObject = expectObject(group, `${what}.groups[${index}]`);
			return {
				heading: stringField(groupObject, "heading"),
				items: expectArray(groupObject.items, `${what}.groups[${index}].items`).map((item, itemIndex) =>
					parseItem(item, `${what}.groups[${index}].items[${itemIndex}]`),
				),
			};
		}),
		notes: arrayField(object, "notes").map(String),
	};
}

export function parseOverview(value: unknown): Overview {
	const object = expectObject(value, "overview");
	return {
		title: requiredString(object, "title", "overview"),
		subtitle: stringField(object, "subtitle"),
		sections: expectArray(object.sections, "overview.sections").map((section, index) =>
			parseSection(section, `overview.sections[${index}]`),
		),
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [input, output, ...rest] = process.argv.slice(2);
	if (input === undefined || output === undefined || rest.length > 0) {
		process.stderr.write(`${USAGE}\n`);
		process.exit(2);
	}
	try {
		writeFileSync(output, renderOverview(parseOverview(readJsonFile(input))));
	} catch (error) {
		process.stderr.write(`${errorMessage(error)}\n`);
		process.exit(2);
	}
	process.stdout.write(`${output}\n`);
}
