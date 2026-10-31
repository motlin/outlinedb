/**
 * Upstream's custom-tree discovery (`PA2`): the account's `Custom` node holds grammar nodes (`Hotkeys`, `Themes`)
 * that customize the app. Upstream finds the root by a salted id this app cannot recompute, so the root is the first
 * non-completed top-level node named `Custom`, unless an id was chosen explicitly.
 */

import {stripHtmlTags} from "@workflowy/shared/html";
import type {CacheService} from "@workflowy/shared/cache";

export interface CustomNode {
	name: string;
	completed: boolean;
	children: CustomNode[];
}

/** Post-order walk: a node named like a grammar is collected after its children; completed subtrees are skipped. */
export function collectCustomSections(
	root: CustomNode | null,
	grammars: ReadonlySet<string>,
): Record<string, CustomNode[]> {
	const sections: Record<string, CustomNode[]> = {};
	const walk = (node: CustomNode): void => {
		if (node.completed) {
			return;
		}
		for (const child of node.children) {
			walk(child);
		}
		if (grammars.has(node.name)) {
			(sections[node.name] ??= []).push(node);
		}
	};
	if (root !== null) {
		walk(root);
	}
	return sections;
}

interface TopLevel {
	id: string;
	name: string | null;
	completedAt: Date | null;
}

export function findCustomRoot(topLevel: readonly TopLevel[], preferredId?: string): string | null {
	if (preferredId !== undefined) {
		const preferred = topLevel.find(({id}) => id === preferredId);
		if (preferred?.completedAt === null) {
			return preferredId;
		}
	}
	const found = topLevel.find(
		({name, completedAt}) => completedAt === null && stripHtmlTags(name).trim() === "Custom",
	);
	return found?.id ?? null;
}

const MAX_DEPTH = 12;

/** The tree under `rootId`, `MAX_DEPTH` levels deep; each node read (completed ones too) is added to `readIds`. */
export function readCustomTree(
	cache: Pick<CacheService, "getChildren" | "getNode">,
	rootId: string,
	readIds = new Set<string>(),
): CustomNode | null {
	const toNode = (id: string, depth: number): CustomNode | null => {
		const node = cache.getNode(id);
		if (node === undefined) {
			return null;
		}
		readIds.add(id);
		const children =
			depth >= MAX_DEPTH
				? []
				: cache
						.getChildren(id)
						.map((child) => toNode(child.id, depth + 1))
						.filter((child): child is CustomNode => child !== null);
		return {name: node.name ?? "", completed: node.completedAt !== null, children};
	};
	return toNode(rootId, 0);
}
