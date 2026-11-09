import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {WEB_ROOT} from "./import-graph.js";

const CLIENT_ROOT = path.join(WEB_ROOT, "src/client");
const EXTRA_FILES = ["src/feature-catalog.ts", "src/server/http/openapi.ts"];

/** Mentions that name the upstream service itself: its hosts, its credential env vars, and code identifiers. */
const UPSTREAM_REFERENCES = [
	/[\w.-]*workflowy\.com\b/giu,
	/\bWORKFLOWY_[A-Z_]+/gu,
	/@outlinedb\/shared\/workflowy\b/gu,
	/\b[a-z]\w*Workflowy\w*/gu,
	/\bWorkflowy[A-Z]\w*/gu,
];

/** Remaining non-brand mentions, as "file: trimmed line". Storage keys and ids are renamed by later scrub tasks. */
const ALLOWED = [
	'src/client/coalescing-timers.ts: const PAGE_PROVIDER = Symbol.for("workflowy.coalescingTimeoutProvider");',
	'src/client/components/decisions-view.tsx: data-icon="workflowy"',
	'src/client/components/main-menu-model.ts: "workflowy.help",',
	'src/client/components/main-menu-model.ts: "workflowy.community",',
	'src/client/components/main-menu-model.ts: "workflowy.blog",',
	'src/client/components/main-menu-model.ts: "workflowy.help": {',
	'src/client/components/main-menu-model.ts: "workflowy.community": {label: "Community", onSelect: link(COMMUNITY_URL)},',
	'src/client/components/main-menu-model.ts: "workflowy.blog": {label: "Blog", onSelect: link(BLOG_URL)},',
	'src/client/hooks/use-starred.ts: export const LAST_VIEWED_STORAGE_KEY = "workflowy-star-last-viewed";',
	// Upstream's built-in "-2" system mention, rendered as upstream names it.
	'src/client/mention-pills.ts: return "Workflowy";',
	'src/client/scroll-restoration.ts: const STORAGE_KEY = "workflowy.scroll-positions";',
	'src/client/stores/outline.ts: const LEGACY_SHOW_COMPLETED_STORAGE_KEY = "workflowy-show-completed";',
	'src/client/theme-apply.ts: export const THEME_STORAGE_KEY = "workflowy-theme";',
];

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return sourceFiles(full);
		}
		const scanned = /\.(ts|tsx|html|webmanifest)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name);
		return scanned ? [full] : [];
	});
}

function withoutComments(source: string): string {
	return source
		.replaceAll(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replaceAll(/[^\n]/gu, ""))
		.replaceAll(/<!--[\s\S]*?-->/gu, (comment) => comment.replaceAll(/[^\n]/gu, ""))
		.replaceAll(/(^|\s)\/\/.*$/gmu, "$1");
}

function brandMentions(file: string): string[] {
	const relative = path.relative(WEB_ROOT, file);
	return withoutComments(fs.readFileSync(file, "utf8"))
		.split("\n")
		.filter((line) => /workflowy/iu.test(UPSTREAM_REFERENCES.reduce((rest, ref) => rest.replaceAll(ref, ""), line)))
		.map((line) => `${relative}: ${line.trim()}`);
}

describe("OutlineDB brand guard", () => {
	it("names the product OutlineDB in user-visible client text, keeping only upstream references", () => {
		// oxlint-disable-next-line unicorn/no-array-sort -- the test tsconfig lib has no toSorted
		const files = [...sourceFiles(CLIENT_ROOT), ...EXTRA_FILES.map((file) => path.join(WEB_ROOT, file))].sort();

		expect(files.flatMap((file) => brandMentions(file))).toStrictEqual(ALLOWED);
	});
});
