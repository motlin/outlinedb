import {recordItemRelationships} from "../../src/cache/item-relationships.js";
import type {ItemRelationships} from "../../src/cache/item-relationships.js";
import {runUnitOfWork} from "../../src/cache/node-composite.js";
import type {AppDatabase} from "../../src/db/types.js";

/** Record the mirror and references-root rows in `relationships`, as one unit of work, leaving current rows alone. */
export function recordRelationships(database: AppDatabase, relationships: ItemRelationships): void
{
	runUnitOfWork(database, (unitOfWork) =>
	{
		recordItemRelationships(unitOfWork, relationships);
	});
}

/** Record that `mirrorId` is a live mirror of `originalId`. */
export function recordMirror(database: AppDatabase, originalId: string, mirrorId: string): void
{
	recordRelationships(
		database,
		{
			mirrors: [
				{
					originalId,
					mirrorId,
				},
			],
			referencesRoots: [],
			aiMetadata: [],
		},
	);
}
