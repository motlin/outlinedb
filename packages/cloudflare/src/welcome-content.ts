import {CacheService, INBOX_NAME} from "@outlinedb/shared/cache";
import type {AppDatabase} from "@outlinedb/shared/db";
import type {WorkflowyNode} from "@outlinedb/shared/types";

const WELCOME_NAME = "Welcome to OutlineDB";

/** The welcome item's children: the first steps a new user needs. */
const WELCOME_TIPS = [
	"Press Enter to add a bullet, Tab to indent it and Shift+Tab to outdent it",
	"Click a bullet to zoom into it; the breadcrumbs at the top take you back out",
	"Press Ctrl+K (Cmd+K on a Mac) to jump to any item by name, or type in the search box to filter",
	"Type #tags or @mentions anywhere in a bullet, then click one to see everything that has it",
	"Press Ctrl+Enter (Cmd+Enter on a Mac) to complete an item",
	"Drop quick thoughts into the Inbox and sort them later. Delete this welcome whenever you like",
] as const;

function item(name: string, priority: number, createdAt: number): WorkflowyNode {
	return {id: crypto.randomUUID(), name, priority, createdAt, modifiedAt: createdAt, completedAt: null};
}

/**
 * Give a standalone account its first content: an Inbox (found by name, like any account's) and a welcome item with
 * tips, as ordinary nodes. Only an account with no top-level items gets them, so a repeat never duplicates them and
 * never touches content the user already has. Never call it for a mirror, whose nodes come from upstream only.
 */
export function seedWelcomeContent(db: AppDatabase, now = Date.now()): void {
	const cache = new CacheService(db);
	if (cache.getChildren(null).length > 0) {
		return;
	}
	const createdAt = Math.floor(now / 1000);
	const welcome = item(WELCOME_NAME, 1, createdAt);
	cache.storeApiResponses([
		{nodes: [item(INBOX_NAME, 0, createdAt), welcome], parentId: null},
		{nodes: WELCOME_TIPS.map((tip, index) => item(tip, index, createdAt)), parentId: welcome.id},
	]);
}
