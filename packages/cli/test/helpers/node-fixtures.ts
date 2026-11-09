import type {NewNodeContent, NewNodeMetadata} from "@outlinedb/shared/db";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {FAR_FUTURE_DATE, formatTemporalTimestamp} from "@outlinedb/shared/temporal";
import crypto from "node:crypto";

export interface TestNode {
	id: string;
	shortId: string | null;
	name: string | null;
	note: string | null;
	parentId: string | null;
	priority: number | null;
	createdAt: Date | null;
	modifiedAt: Date | null;
	completedAt: Date | null;
	layoutMode: string | null;
	systemFrom: string;
	systemTo: string;
}

function generateTestId(): string {
	return crypto.randomUUID();
}

export function getShortId(id: string): string {
	return id.replaceAll("-", "").slice(-12);
}

export function createTestNode(overrides: Partial<TestNode> = {}): TestNode {
	// Date.now(), not new Date(): the strictly increasing test clock then keeps a command's first unit of work out of the seed's millisecond.
	const now = new Date(Date.now());
	const id = overrides.id ?? generateTestId();
	const systemFrom = overrides.systemFrom ?? formatTemporalTimestamp(now);

	return {
		id,
		shortId: getShortId(id),
		name: "Test Node",
		note: null,
		parentId: null,
		priority: 0,
		createdAt: now,
		modifiedAt: now,
		completedAt: null,
		layoutMode: "bullets",
		systemFrom,
		systemTo: FAR_FUTURE_DATE,
		...overrides,
	};
}

export function createApiNode(overrides: Partial<WorkflowyNode> = {}): WorkflowyNode {
	const now = Date.now();
	return {
		id: generateTestId(),
		name: "Test Node",
		note: null,
		parent_id: null,
		priority: 0,
		completed: false,
		createdAt: now,
		modifiedAt: now,
		completedAt: null,
		data: {layoutMode: "bullets"},
		...overrides,
	};
}

export function createNodeFromContent(
	content: Partial<{
		id: string;
		name: string | null;
		note: string | null;
		parentId: string | null;
		systemFrom: string;
		systemTo: string;
	}>,
): TestNode {
	return {
		id: content.id ?? "",
		name: content.name ?? null,
		note: content.note ?? null,
		parentId: content.parentId ?? null,
		systemFrom: content.systemFrom ?? "",
		systemTo: content.systemTo ?? "",
		shortId: null,
		priority: null,
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		layoutMode: null,
	};
}

export function splitNodeIntoContentAndMetadata(node: TestNode): {content: NewNodeContent; metadata: NewNodeMetadata} {
	const {id, name, note, parentId, systemFrom, systemTo} = node;
	const {shortId, priority, createdAt, modifiedAt, completedAt, layoutMode} = node;

	return {
		content: {
			id,
			name,
			note,
			parentId,
			systemFrom,
			systemTo,
		},
		metadata: {
			nodeId: id,
			shortId,
			priority,
			createdAt,
			modifiedAt,
			completedAt,
			layoutMode,
			systemFrom,
			systemTo,
		},
	};
}
