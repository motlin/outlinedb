import {QueryClient, QueryClientProvider, QueryObserver} from "@tanstack/react-query";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {NodeResponse} from "../src/node-types.js";
import {createEditDebouncer} from "../src/client/edit-debouncer.js";
import {nodeKeys, readChildren} from "../src/client/node-cache.js";
import {applyOps, holdUndoSlot, runInUndoBatch, settleUndoNow} from "../src/client/undo-batch.js";
import {holdUndoReplay, previewUndoOps} from "../src/client/undo-cache.js";
import {undoHistory} from "../src/client/undo-history.js";
import type {UndoOp, ViewState} from "../src/client/undo-history.js";
import {queueUndo} from "../src/client/undo-view-state.js";
import type {UndoRunner} from "../src/client/undo-view-state.js";

const outlineState =
{
	zoomedNodeId: null,
	editingId: null,
	editingCaretOffset: null,
	editingNoteId: null,
	itemSelection:
	{
		entries: [],
		pivotId: null,
		retractableIds: [],
		counter: 0,
	},
	addErrorNotification: () => "id",
	startEditing()
	{
	},
	markCreatedForSearch()
	{
	},
};

vi.mock("../src/client/hooks/use-saving.js", () => (
{
	trackReplay: async <T>(promise: Promise<T>) => promise,
}));
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: Object.assign(
		(selector?: (state: typeof outlineState) => unknown) => (selector ? selector(outlineState) : outlineState),
		{
			getState: () => outlineState,
		},
	),
}));

const {fetchChildren, undoAdapter, useCreateNode, useUpdateNode} = await import("../src/client/hooks/use-nodes.js");

const view: ViewState =
{
	zoomedNodeId: null,
	editing: null,
	selectedIds: [],
};

function node(id: string, name: string): NodeResponse
{
	return {
		id,
		parent_id: "p",
		name,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		hasChildren: false,
		hasUncompletedChildren: false,
		isMirror: false,
	};
}

describe("an undo step whose ops are known before the server answers", () =>
{
	beforeEach(() =>
	{
		undoHistory.clear();
	});

	it("pops at once, without waiting for the reply", () =>
	{
		const edit: UndoOp =
		{
			kind: "edit",
			nodeId: "n",
			field: "name",
			before: "",
			after: "hi",
		};
		const slot = holdUndoSlot([edit]);
		expect(settleUndoNow()).toBeUndefined();
		expect(undoHistory.popUndo()?.ops).toStrictEqual([
			{
				...edit,
				before: "hi",
				after: "",
			},
		]);
		slot.settle([edit]);
		expect(undoHistory.canUndo).toBe(false);
		expect(undoHistory.canRedo).toBe(true);
	});

	it("is rewritten when the late reply names another id", () =>
	{
		const create: UndoOp =
		{
			kind: "create",
			nodeId: "client",
			parentId: "p",
			index: 3,
		};
		const slot = holdUndoSlot([create]);
		expect(settleUndoNow()).toBeUndefined();
		slot.settle([
			{
				...create,
				nodeId: "server",
			},
		]);
		expect(undoHistory.popUndo()?.ops).toStrictEqual([
			{
				kind: "delete",
				nodeId: "server",
				parentId: "p",
				index: 3,
			},
		]);
	});

	it("is dropped when the mutation fails after the early push", () =>
	{
		const slot = holdUndoSlot([
			{
				kind: "complete",
				nodeId: "n",
			},
		]);
		expect(settleUndoNow()).toBeUndefined();
		expect(undoHistory.canUndo).toBe(true);
		slot.settle([]);
		expect(undoHistory.canUndo).toBe(false);
	});

	it("still waits for a slot whose ops come only with the reply", async () =>
	{
		const slot = holdUndoSlot();
		const waiting = settleUndoNow();
		expect(waiting).toBeInstanceOf(Promise);
		slot.settle([
			{
				kind: "complete",
				nodeId: "n",
			},
		]);
		await waiting;
		expect(undoHistory.canUndo).toBe(true);
	});
});

/** A server holding parent p's children, answering every request `latency` ms after it arrives. */
interface FakeServer
{
	children: NodeResponse[];
	requests: string[];
}

function stubServer(server: FakeServer, latency: number): void
{
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
	{
		const method = init?.method ?? "GET";
		const body = (typeof init?.body === "string" ? JSON.parse(init.body) : {}) as Record<string, unknown>;
		let reply: unknown = {};
		if (url === "/api/v1/nodes" && method === "POST")
		{
			const created = node(String(body.id), String(body.name));
			server.children.splice(Number(body.index), 0, created);
			server.requests.push(`create ${created.id}`);
			reply =
			{
				node: created,
			};
		}
		else if (url === "/api/v1/nodes/children")
		{
			reply =
			{
				children:
				{
					p: server.children.map((row) => (
					{
						...row,
					})),
				},
			};
		}
		else if (method === "DELETE")
		{
			const id = url.split("/").at(-1) ?? "";
			server.children = server.children.filter((row) => row.id !== id);
			server.requests.push(`delete ${id}`);
		}
		else if (method === "POST")
		{
			const id = url.split("/").at(-1) ?? "";
			const name = String(body.name);
			server.children = server.children.map((row) =>
				row.id === id
					?
						{
							...row,
							name,
						}
					: row,
			);
			server.requests.push(`update ${id} ${JSON.stringify(name)}`);
			reply =
			{
				node: node(id, name),
				effects:
				{
					backlinkTargets: [],
					dates: false,
				},
			};
		}
		await new Promise((resolve) =>
		{
			setTimeout(resolve, latency);
		});
		return Response.json(reply);
	});
}

function captureHooks(queryClient: QueryClient)
{
	const captured:
	{
		create: ReturnType<typeof useCreateNode>;
		update: ReturnType<typeof useUpdateNode>;
	}[] = [];
	function Probe()
	{
		captured.push(
			{
				create: useCreateNode(),
				update: useUpdateNode(),
			},
		);
		return null;
	}
	renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client: queryClient,
			},
			createElement(Probe),
		),
	);
	const hooks = captured.at(0);
	if (hooks === undefined)
	{
		throw new Error("hooks not captured");
	}
	return hooks;
}

const nameOf = (queryClient: QueryClient, id: string) => readChildren(queryClient, "p")?.find((row) => row.id === id);

/** Enter at the end of p's list, type "hello", then wait `delay` ms: the outline and its undo runner. */
async function enterAndType(latency: number, delay: number)
{
	vi.useFakeTimers();
	undoHistory.clear();
	const server: FakeServer =
	{
		children: [node("a", "alpha"), node("b", "beta"), node("c", "gamma")],
		requests: [],
	};
	stubServer(server, latency);
	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				queries:
				{
					staleTime: Number.POSITIVE_INFINITY,
				},
				mutations:
				{
					retry: false,
				},
			},
		},
	);
	queryClient.setQueryData(
		nodeKeys.children("p"),
		server.children.map((row) => (
		{
			...row,
		})),
	);
	// The outline observes p's children, so the create's refetch really runs.
	const observer = new QueryObserver(
		queryClient,
		{
			queryKey: nodeKeys.children("p"),
			queryFn: async () => fetchChildren("p"),
		},
	);
	const unsubscribe = observer.subscribe(() => {});
	const hooks = captureHooks(queryClient);

	// Every row state once watching starts, to catch a late answer landing over a preview.
	const watch =
	{
		on: false,
		shown: [] as (string | null | undefined)[],
	};
	const stopWatching = queryClient.getQueryCache().subscribe(() =>
	{
		if (watch.on)
		{
			watch.shown.push(nameOf(queryClient, "n")?.name);
		}
	});

	void runInUndoBatch(
		() => view,
		() =>
		{
			hooks.create.mutate(
				{
					id: "n",
					parent_id: "p",
					index: 3,
					name: "",
				},
			);
		},
	);
	const saver = createEditDebouncer(
		{
			delay: 500,
			save: ({after}) =>
			{
				hooks.update.mutate(
					{
						nodeId: "n",
						name: after,
					},
				);
			},
		},
	);
	saver.reset("");
	for (const typed of ["h", "he", "hel", "hell", "hello"])
	{
		saver.change(typed);
	}
	await vi.advanceTimersByTimeAsync(delay);

	const previews: UndoOp[][] = [];
	const runner: UndoRunner =
	{
		flush: () =>
		{
			saver.flush();
		},
		settled: settleUndoNow,
		pop: (direction) => (direction === "undo" ? undoHistory.popUndo() : undoHistory.popRedo()),
		blur()
		{
		},
		hold: (ops) => holdUndoReplay(queryClient, ops),
		preview(ops)
		{
			previews.push([...ops]);
			previewUndoOps(queryClient, ops);
		},
		apply: async (ops) => applyOps(ops, undoAdapter),
		reconcile: async () => queryClient.invalidateQueries(),
		current: () => view,
		editorFocused: () => false,
		select()
		{
		},
		textLength: () => 0,
		zoomTo()
		{
		},
		focus()
		{
		},
	};
	const drain = async () => vi.advanceTimersByTimeAsync(latency * 10 + 1000);
	const dispose = () =>
	{
		stopWatching();
		unsubscribe();
	};
	return {
		server,
		queryClient,
		runner,
		previews,
		watch,
		drain,
		dispose,
	};
}

const undoTyping: UndoOp =
{
	kind: "edit",
	nodeId: "n",
	field: "name",
	before: "hello",
	after: "",
};
const undoCreate: UndoOp =
{
	kind: "delete",
	nodeId: "n",
	parentId: "p",
	index: 3,
};
const serverRequests = ["create n", 'update n "hello"', 'update n ""', "delete n"];

const timings = [0, 100, 300, 600, 1500].flatMap((delay) => [
	{
		delay,
		latency: 20,
	},
	{
		delay,
		latency: 3000,
	},
]);

describe("⌘Z after Enter and typing applies at once in every timing", () =>
{
	afterEach(() =>
	{
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it.each(timings)("⌘Z $delay ms after the last keystroke, server latency $latency ms", async ({delay, latency}) =>
	{
		const {server, queryClient, runner, previews, watch, drain, dispose} = await enterAndType(latency, delay);

		// First ⌘Z: the typing is undone before the press returns.
		const firstUndo = queueUndo("undo", runner);
		expect(previews).toStrictEqual([[undoTyping]]);
		expect(nameOf(queryClient, "n")?.name).toBe("");
		watch.on = true;
		await drain();
		await firstUndo;
		expect(watch.shown.filter((name) => name !== "")).toStrictEqual([]);
		expect(server.children.map((row) => row.name)).toStrictEqual(["alpha", "beta", "gamma", ""]);

		// Second ⌘Z: the new row goes away at once and stays gone.
		watch.shown.length = 0;
		const secondUndo = queueUndo("undo", runner);
		expect(previews).toStrictEqual([[undoTyping], [undoCreate]]);
		expect(nameOf(queryClient, "n")).toBeUndefined();
		await drain();
		await secondUndo;
		expect(watch.shown.filter((name) => name !== undefined)).toStrictEqual([]);
		expect(server.children.map((row) => row.name)).toStrictEqual(["alpha", "beta", "gamma"]);
		expect(server.requests).toStrictEqual(serverRequests);
		dispose();
	});

	it.each(timings)(
		"⌘Z ⌘Z $delay ms after the last keystroke, server latency $latency ms",
		async ({delay, latency}) =>
		{
			const {server, queryClient, runner, previews, watch, drain, dispose} = await enterAndType(latency, delay);

			// Both presses land before any reply: each undoes its step at once.
			const firstUndo = queueUndo("undo", runner);
			const secondUndo = queueUndo("undo", runner);
			expect(previews).toStrictEqual([[undoTyping], [undoCreate]]);
			expect(nameOf(queryClient, "n")).toBeUndefined();
			watch.on = true;
			await drain();
			await Promise.all([firstUndo, secondUndo]);
			expect(watch.shown.filter((name) => name !== undefined)).toStrictEqual([]);
			expect(server.children.map((row) => row.name)).toStrictEqual(["alpha", "beta", "gamma"]);
			expect(server.requests).toStrictEqual(serverRequests);
			dispose();
		},
	);
});
