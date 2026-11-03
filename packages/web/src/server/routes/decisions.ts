/**
 * Decision pages: read a staged document with its answers, save one item's
 * answer, and mark the page submitted. See {@link DecisionStore} for where the
 * files live.
 */

import {Hono} from "hono";
import type {Context} from "hono";
import type {AppEnv, ServerContext} from "../context.js";
import {
	DECISION_SLUG,
	DecisionAnswerInputSchema,
	DecisionFileError,
	decisionImageType,
	mergeDecisionPage,
	parseDecisionAnswers,
	parseDecisionDocument,
	serializeDecisionAnswers,
} from "../decisions.js";
import type {DecisionAnswers, DecisionDocument, DecisionStore} from "../decisions.js";

export interface DecisionsRouterOptions {
	now?: () => Date;
}

/** A request the route refuses with a status and message instead of a 500. */
class DecisionRequestError extends Error {
	constructor(
		readonly status: 400 | 404 | 503,
		message: string,
	) {
		super(message);
	}
}

/** The decision pages on their own app, with the context middleware they read; the Node host mounts it beside the Worker's HTTP layer. */
export function createDecisionsApp(ctx: ServerContext): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("/*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/api/v1/decisions", createDecisionsRouter());
	return app;
}

export function createDecisionsRouter(options: DecisionsRouterOptions = {}): Hono<AppEnv> {
	const now = options.now ?? (() => new Date());
	const router = new Hono<AppEnv>();
	// Each slug's answers are read-modify-written; chaining the writes keeps two quick saves from dropping one.
	const pending = new Map<string, Promise<unknown>>();

	async function serialized<T>(slug: string, work: () => Promise<T>): Promise<T> {
		const previous = pending.get(slug) ?? Promise.resolve();
		const next = previous.then(work, work);
		pending.set(slug, next);
		try {
			return await next;
		} finally {
			if (pending.get(slug) === next) {
				pending.delete(slug);
			}
		}
	}

	// Registered before `/:slug` so "images" is never read as a slug.
	router.get("/images/*", async (c) => {
		const store = c.get("ctx").decisions;
		const src = imageSource(new URL(c.req.url).pathname);
		const type = src === null ? null : decisionImageType(src);
		const bytes = store === undefined || src === null || type === null ? null : await store.readImage(src);
		if (bytes === null || type === null) {
			return c.json({error: "No such image"}, 404);
		}
		return c.body(bytes, 200, {"content-type": type, "cache-control": "private, max-age=3600"});
	});

	router.get("/:slug", async (c) =>
		respond(c, async () => {
			const {store, slug} = target(c);
			const document = await readDocument(store, slug);
			const answers = parseDecisionAnswers(slug, await store.readAnswers(slug));
			return mergeDecisionPage(document, answers);
		}),
	);

	router.put("/:slug/:itemId", async (c) =>
		respond(c, async () => {
			const {store, slug} = target(c);
			const itemId = c.req.param("itemId");
			const input = DecisionAnswerInputSchema.safeParse(await readBody(c.req.raw));
			if (!input.success) {
				throw new DecisionRequestError(400, "Body must be {choice: string | null, note: string}");
			}
			const item = (await readDocument(store, slug)).groups
				.flatMap((group) => group.items)
				.find((candidate) => candidate.id === itemId);
			if (item === undefined) {
				throw new DecisionRequestError(404, `No item "${itemId}" on decision page ${slug}`);
			}
			const {choice, note} = input.data;
			if (choice !== null && !item.options.some((option) => option.value === choice)) {
				throw new DecisionRequestError(400, `Choice "${choice}" is not an option for item "${itemId}"`);
			}
			const answer = {choice, note, answeredAt: now().toISOString()};
			await serialized(slug, async () =>
				updateAnswers(store, slug, (saved) => ({...saved, answers: {...saved.answers, [itemId]: answer}})),
			);
			return {answer};
		}),
	);

	router.post("/:slug/submit", async (c) =>
		respond(c, async () => {
			const {store, slug} = target(c);
			await readDocument(store, slug);
			const submittedAt = now().toISOString();
			await serialized(slug, async () => updateAnswers(store, slug, (saved) => ({...saved, submittedAt})));
			return {submittedAt};
		}),
	);

	return router;
}

/** The decoded `src` after `/images/` in a request path, or null when it does not decode. */
function imageSource(pathname: string): string | null {
	const marker = "/images/";
	const start = pathname.indexOf(marker);
	try {
		return start === -1 ? null : decodeURIComponent(pathname.slice(start + marker.length));
	} catch {
		return null;
	}
}

function target(c: Context<AppEnv>): {store: DecisionStore; slug: string} {
	const store = c.get("ctx").decisions;
	if (store === undefined) {
		throw new DecisionRequestError(503, "Decision pages are not available on this host");
	}
	const slug = c.req.param("slug") ?? "";
	if (!DECISION_SLUG.test(slug)) {
		throw new DecisionRequestError(400, "Decision slug must match [a-z0-9-]+");
	}
	return {store, slug};
}

async function readDocument(store: DecisionStore, slug: string): Promise<DecisionDocument> {
	const text = await store.readDocument(slug);
	if (text === null) {
		throw new DecisionRequestError(404, `No decision page staged as ${slug}`);
	}
	return parseDecisionDocument(slug, text);
}

async function updateAnswers(
	store: DecisionStore,
	slug: string,
	change: (saved: DecisionAnswers) => DecisionAnswers,
): Promise<void> {
	const saved = parseDecisionAnswers(slug, await store.readAnswers(slug));
	await store.writeAnswers(slug, serializeDecisionAnswers(change(saved)));
}

async function readBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}

/** Run a handler, turning refused requests and unusable files into JSON errors. */
async function respond(c: Context<AppEnv>, handler: () => Promise<object>): Promise<Response> {
	try {
		return c.json(await handler());
	} catch (error) {
		if (error instanceof DecisionRequestError) {
			return c.json({error: error.message}, error.status);
		}
		if (error instanceof DecisionFileError) {
			return c.json({error: error.message}, 500);
		}
		throw error;
	}
}
