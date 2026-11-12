import {applyLocalExpansionDelta, CacheService, INBOX_NAME, runUnitOfWork} from "@outlinedb/shared/cache";
import type {AppDatabase} from "@outlinedb/shared/db";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {upstreamExpansionKey} from "@outlinedb/shared/workflowy";

/** A seeded bullet: its text, its children, and whether it starts expanded (every other bullet starts collapsed). */
interface WelcomeItem
{
	name: string;
	children?: readonly WelcomeItem[];
	expanded?: true;
}

const leaves = (...names: string[]): WelcomeItem[] =>
	names.map((name) => (
	{
		name,
	}));

/**
 * The welcome a standalone account starts with: a hands-on tutorial where each line is something to try on that same
 * bullet, then tips grouped by topic. Only the welcome itself starts expanded, so just its top level shows.
 */
const WELCOME: WelcomeItem =
{
	name: "Welcome to OutlineDB",
	expanded: true,
	children: [
		{
			name: "👀 Start here: click this bullet",
			children: [
				{
					name: "Every bullet can hold more bullets, as deep as you like",
					children: [
						{
							name: "Click the dot at the left of this line to open it on its own page",
							children: [
								{
									name: "Keep going, this one opens too",
									children: leaves("The breadcrumbs at the top take you back out"),
								},
							],
						},
					],
				},
				{
					name: "Click the arrow beside a bullet to show or hide what is inside it",
					children: leaves("Try hiding the first bullet on this page"),
				},
				{
					name: "Drag a bullet by its dot to move it",
					children: leaves("Move me below the next bullet", "Drop it under this one"),
				},
				{
					name: "Press Enter at the end of a bullet to start a new one",
				},
				{
					name: "Press Tab to indent a bullet and Shift+Tab to outdent it",
				},
				{
					name: "Hover over a bullet's dot to open its menu and see what else it can do",
				},
				{
					name: "That's the basics. Click Home at the top to go back and find more tips",
				},
			],
		},
		{
			name: "🚀 More tips",
			children: [
				{
					name: "🏷️ Tags and completing",
					children: [
						{
							name: "Type a #tag anywhere, like #example, then click it to see everything tagged with it",
						},
						{
							name: "Use @mentions the same way for people",
						},
						{
							name: "Press Ctrl+Enter (Cmd+Enter on a Mac) to complete a bullet",
							children: leaves("Try completing this one, then press it again to bring it back"),
						},
						{
							name: "Press Shift+Enter to add a note below a bullet's text",
						},
					],
				},
				{
					name: "⌨️ Keyboard",
					children: [
						{
							name: "Ctrl+Down shows a bullet's children and Ctrl+Up hides them (Cmd on a Mac)",
						},
						{
							name: "Alt+Shift+Up and Down move a bullet (Cmd+Shift on a Mac)",
							children: leaves("Move me around"),
						},
						{
							name: "Ctrl+Z undoes your last change (Cmd+Z on a Mac)",
						},
					],
				},
				{
					name: "🧭 Search and jumping",
					children: leaves(
						"Press Ctrl+K (Cmd+K on a Mac) to jump to any bullet by name",
						"Type in the search box to filter the whole outline",
						"Press Ctrl+Shift+8 (Cmd+Shift+8 on a Mac) to star the page you are on and keep it in the sidebar",
					),
				},
				{
					name: "🪄 Boards",
					children: [
						{
							name: "Turn a bullet into a board from its menu, and its children become columns",
						},
						{
							name: "Try it on this bullet",
							children: leaves("To do", "Doing", "Done"),
						},
					],
				},
				{
					name: "🔗 Links",
					children: leaves(
						"Type [[ and pick a bullet to link to it",
						"Paste a web address and it becomes a link",
					),
				},
			],
		},
		{
			name: "Put quick thoughts in the Inbox and sort them later. Delete this welcome whenever you like",
		},
	],
};

const TOP_LEVEL: readonly WelcomeItem[] = [
	{
		name: INBOX_NAME,
	},
	WELCOME,
];

interface Batch
{
	nodes: WorkflowyNode[];
	parentId: string | null;
}

/** Give `items` ids under `parentId`, adding one batch per parent to `batches` and each expanded id to `expanded`. */
function flatten(
	items: readonly WelcomeItem[],
	parentId: string | null,
	createdAt: number,
	batches: Batch[],
	expanded: string[],
): void
{
	const placed = items.map((item, priority) =>
	{
		const id = crypto.randomUUID();
		if (item.expanded)
		{
			expanded.push(id);
		}
		const node: WorkflowyNode =
		{
			id,
			name: item.name,
			priority,
			createdAt,
			modifiedAt: createdAt,
			completedAt: null,
		};
		return {
			item,
			node,
		};
	});
	batches.push(
		{
			nodes: placed.map(({node}) => node),
			parentId,
		},
	);
	for (const {item, node} of placed)
	{
		if (item.children)
		{
			flatten(item.children, node.id, createdAt, batches, expanded);
		}
	}
}

/**
 * Give a standalone account its first content: an Inbox (found by name, like any account's) and the welcome
 * tutorial, as ordinary nodes, with only the welcome expanded. Only an account with no top-level items gets them, so a
 * repeat never duplicates them and never touches content the user already has. Never call it for a mirror, whose
 * nodes come from upstream only.
 */
export function seedWelcomeContent(db: AppDatabase, now = Date.now()): void
{
	const cache = new CacheService(db);
	if (cache.getChildren(null).length > 0)
	{
		return;
	}
	const batches: Batch[] = [];
	const expanded: string[] = [];
	flatten(TOP_LEVEL, null, Math.floor(now / 1000), batches, expanded);
	cache.storeApiResponses(batches);
	runUnitOfWork(db, (unitOfWork) =>
	{
		applyLocalExpansionDelta(
			unitOfWork,
			Object.fromEntries(expanded.map((id) => [upstreamExpansionKey(id), true])),
		);
	});
}
