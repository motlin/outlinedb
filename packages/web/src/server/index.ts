import {serve} from "@hono/node-server";
import {createNodeWebSocket} from "@hono/node-ws";
import {Hono} from "hono";
import {createHttpApp} from "./http/app.js";
import {inProcessStore} from "./store.js";
import {httpLoggingEnabled, loggingFetch} from "./http-logger.js";
import {createServerContext} from "./node-context.js";
import {ladderSocketHandlers} from "./ladder-socket.js";
import {accountVersion, expansionVersion, readAccountRows, readExpansion} from "@outlinedb/shared/cache";
import {TreeEventBus, accountChangePublisher, expansionChangePublisher, withTreeChangePublish} from "./node-events.js";
import {nodeEventsSocketHandlers} from "./node-events-socket.js";
import {createDecisionsApp} from "./routes/decisions.js";
import {resolvePort} from "./port.js";
import {warmTreeSnapshot} from "./tree-snapshot.js";
import {nodeSignalSocket, startUpstreamSignal} from "./upstream-signal.js";

process.title = "outlinedb-web-server";

if (httpLoggingEnabled(process.env))
{
	globalThis.fetch = loggingFetch(globalThis.fetch, (line) =>
	{
		console.log(line);
	});
}

// Composition root: build the server context once and expose it to every router.
const serverContext = createServerContext();
/** Announces each committed tree write, local or caught up from upstream, to open outline tabs. */
const treeEvents = new TreeEventBus();
/**
 * Announces the expanded keys' new version after a tree write (an import reseeds them) and after each debounced
 * expansion push, so open tabs poll the expansion feed only when it moved.
 */
const checkExpansion = expansionChangePublisher(treeEvents, () =>
{
	const keys = readExpansion(serverContext.db);
	return keys === undefined ? undefined : expansionVersion(keys);
});
/** Announces the account tables' new version after a tree write (an import or catch-up rewrites them), so open tabs re-read their flags. */
const checkAccount = accountChangePublisher(treeEvents, () => accountVersion(readAccountRows(serverContext.db)));
treeEvents.subscribe((event) =>
{
	if (event.type === "tree.changed")
	{
		checkExpansion();
		checkAccount();
	}
});
serverContext.expansionWritten = checkExpansion;
const store = inProcessStore(
	serverContext,
	undefined,
	{
		keepSnapshotWarm: serverContext.config.features.treeSnapshot,
		treeEvents,
	},
);
const httpApp = createHttpApp(
	{
		resolveStore: () => store,
		corsOrigin: "http://localhost:5173",
	},
);
httpApp.route("/", createDecisionsApp(serverContext));

/** The served app: sockets first, so `/api/v1/nodes/events` is not taken by the HTTP routes' `GET /api/v1/nodes/:id`. */
const app = new Hono();
const nodeWebSocket = createNodeWebSocket(
	{
		app,
	},
);

/**
 * Every ladder write, streamed as one frame per write. Monitor's `ws:` source
 * turns each frame into a notification, so a Claude session watching this URL
 * is woken by an edit instead of having to poll for one.
 */
app.get(
	"/api/v1/ladder/events",
	nodeWebSocket.upgradeWebSocket(() => ladderSocketHandlers(serverContext.ladderEvents)),
);

/** One `{"type":"tree.changed","latest":...}` frame per committed tree write; an open tab answers with one changes read. */
app.get(
	"/api/v1/nodes/events",
	nodeWebSocket.upgradeWebSocket(() => nodeEventsSocketHandlers(treeEvents)),
);
app.route("/", httpApp);

const port = resolvePort(process.env);

// Logged from the listening callback, so a port clash reports EADDRINUSE
// instead of a "Server running" line that was never true.
const server = serve(
	{
		fetch: app.fetch,
		hostname: "127.0.0.1",
		port,
	},
	(info) =>
	{
		console.log(`Server running at http://127.0.0.1:${info.port}`);
		// After listening, so the first search/switcher request finds the whole-tree snapshot already built.
		setImmediate(() =>
		{
			warmTreeSnapshot(serverContext.db);
		});
	},
);
nodeWebSocket.injectWebSocket(server);

/**
 * Edits made on workflowy.com reach the cache within about a second: upstream's
 * signal socket nudges, and each nudge runs one coalesced catch-up poll.
 */
const internalAuth = serverContext.internalAuth;
const internalAdapter = serverContext.internalAdapter?.();
if (internalAuth && internalAdapter)
{
	startUpstreamSignal(
		{
			connect: async () =>
			{
				const clientId = await internalAdapter.clientId();
				const cookie = internalAuth.sessionStore.read();
				if (cookie === undefined)
				{
					throw new Error("no saved Workflowy session cookie");
				}
				return {
					clientId,
					cookie,
				};
			},
			openSocket: nodeSignalSocket,
			catchUp: async () =>
				withTreeChangePublish(serverContext.db, treeEvents, async () => internalAdapter.catchUp()),
		},
	);
}
