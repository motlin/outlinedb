import type {Context} from "hono";
import {createMiddleware} from "hono/factory";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {AppEnv} from "./context.js";

import {INTERNAL_API_NOT_CONFIGURED} from "./internal-api-error.js";

export {INTERNAL_API_NOT_CONFIGURED};

/**
 * Gate a route on Workflowy internal-API auth: answers 503 when neither
 * `WORKFLOWY_USERNAME`/`WORKFLOWY_PASSWORD` nor a saved session cookie exist.
 */
export const internalApiRequired = createMiddleware<AppEnv>(async (c, next) => {
	if (!c.get("ctx").internalAuth) {
		return c.json({error: INTERNAL_API_NOT_CONFIGURED}, 503);
	}
	return next();
});
