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
	return buildServerContext({
		db,
		config: readNodeConfig(process.env),
		ladderEvents,
		decisions: fileDecisionStore(decisionsDirectory(process.env), decisionPhotosDirectory(process.env)),
		internalAuth: readInternalAuth(),
		embeddingIndex: (model) => new SqliteVecIndex(db, model),
	});
}
