import {readInternalAuth} from "@outlinedb/shared/node";
import {readNodeConfig} from "./config.js";
import {buildServerContext} from "./context.js";
import type {ServerContext} from "./context.js";
import {getDatabase} from "./db.js";
import {SqliteVecIndex} from "./embedding-index.js";
import {decisionPhotosDirectory, decisionsDirectory, fileDecisionStore} from "./decision-files.js";
import {LadderEventBus} from "./ladder-events.js";

/** Process-wide bus; the Node server has one ladder. */
const ladderEvents = new LadderEventBus();

/**
 * Build a {@link ServerContext} from the process database singleton and
 * environment (the Node host). Tests bypass this and construct a context directly.
 */
export function createServerContext(): ServerContext {
	const db = getDatabase();
	const config = readNodeConfig(process.env);
	return buildServerContext({
		db,
		config,
		ladderEvents,
		decisions: fileDecisionStore(decisionsDirectory(process.env), decisionPhotosDirectory(process.env)),
		// A standalone host has no workflowy.com behind it: a saved session must not sync or push into its outline.
		internalAuth: config.mode === "mirror" ? readInternalAuth() : undefined,
		embeddingIndex: (model) => new SqliteVecIndex(db, model),
	});
}
