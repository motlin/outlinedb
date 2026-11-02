import type {Hono} from "hono";
import {createHttpApp} from "../src/server/http/app.js";
import {inProcessStore} from "../src/server/store.js";
import type {ServerContext} from "../src/server/context.js";

/** The migrated HTTP layer over an in-process store, the way the Node host serves it. */
export function httpAppFor(ctx: ServerContext): Hono
{
	return createHttpApp(
		{
			resolveStore: () => inProcessStore(ctx),
		},
	);
}
