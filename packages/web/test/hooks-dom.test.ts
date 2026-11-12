// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, beforeEach, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {act, createElement, Profiler, useEffect} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {useMutationRunner} from "../src/client/hooks/use-mutation-runner.js";
import type {NodeChangesResponse, NodeResponse} from "../src/node-types.js";
import {nodeKeys} from "../src/client/node-cache.js";
import {syncNodeChanges} from "../src/client/hooks/use-nodes.js";
import {useOutlineLiveSync} from "../src/client/hooks/use-outline-live-sync.js";
import {useFeatureStoreSync} from "../src/client/hooks/use-feature-store-sync.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("use mutation runner", () =>
{
	let root: Root | undefined;

	beforeAll(() =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() =>
	{
		act(() =>
		{
			root?.unmount();
		});
		root = undefined;
		document.body.innerHTML = "";
	});

	async function pause(): Promise<void>
	{
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 10);
		});
	}

	type Runner = ReturnType<typeof useMutationRunner<string, string, unknown>>;

	/** Mounts a component holding a runner over `mutationFn`; returns the runner and its render count. */
	function mountRunner(mutationFn: (variables: string) => Promise<string>, events: string[])
	{
		const client = new QueryClient();
		const state:
		{
			runner: Runner | null;
			renders: number;
		} =
		{
			runner: null,
			renders: 0,
		};
		function Holder()
		{
			const runner = useMutationRunner<string, string, unknown>(
				{
					mutationFn,
					onSuccess: (data) =>
					{
						events.push(`options success ${data}`);
					},
				},
			);
			useEffect(() =>
			{
				state.runner = runner;
			});
			return null;
		}
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client,
					},
					createElement(
						Profiler,
						{
							id: "holder",
							onRender: () =>
							{
								state.renders++;
							},
						},
						createElement(Holder),
					),
				),
			);
		});
		return {
			state,
			client,
		};
	}

	describe("useMutationRunner", () =>
	{
		it("runs the mutation and its per-call callbacks without re-rendering its holder", async () =>
		{
			const events: string[] = [];
			const {state, client} = mountRunner(async (variables) => Promise.resolve(`saved ${variables}`), events);
			const first = state.runner;
			await act(async () =>
			{
				state.runner?.mutate(
					"a",
					{
						onSuccess: (data) =>
						{
							events.push(`call success ${data}`);
						},
						onSettled: () =>
						{
							events.push("call settled");
						},
					},
				);
				await pause();
			});
			expect(
				{
					renders: state.renders,
					stable: state.runner === first,
					events,
					mutations: client
						.getMutationCache()
						.getAll()
						.map((mutation) => mutation.state.status),
				},
			).toStrictEqual(
				{
					renders: 1,
					stable: true,
					events: ["options success saved a", "call success saved a", "call settled"],
					mutations: ["success"],
				},
			);
		});

		it("rejects mutateAsync and runs onError when the mutation fails, still without a re-render", async () =>
		{
			const events: string[] = [];
			const {state} = mountRunner(async () => Promise.reject(new Error("boom")), events);
			let rejected: unknown = null;
			await act(async () =>
			{
				state.runner?.mutate(
					"x",
					{
						onError: (error) =>
						{
							events.push(`call error ${error.message}`);
						},
					},
				);
				await pause();
				await state.runner?.mutateAsync("y").catch((error: unknown) =>
				{
					rejected = error instanceof Error ? error.message : error;
				});
				await pause();
			});
			expect(
				{
					renders: state.renders,
					rejected,
					events,
				},
			).toStrictEqual(
				{
					renders: 1,
					rejected: "boom",
					events: ["call error boom"],
				},
			);
		});
	});
});

describe("use outline live sync", () =>
{
	/** A WebSocket the test opens, drops and feeds frames to by hand. */
	class FakeSocket
	{
		static readonly instances: FakeSocket[] = [];
		readyState = 0;
		readonly url: string;
		readonly #listeners = new Map<string, ((event: {data?: string}) => void)[]>();

		constructor(url: string)
		{
			this.url = url;
			FakeSocket.instances.push(this);
		}

		addEventListener(name: string, callback: (event: {data?: string}) => void): void
		{
			this.#listeners.set(name, [...(this.#listeners.get(name) ?? []), callback]);
		}

		close(): void
		{
			this.readyState = 3;
		}

		emit(name: "open" | "close" | "message", data?: string): void
		{
			this.readyState = name === "open" ? 1 : name === "close" ? 3 : this.readyState;
			for (const callback of this.#listeners.get(name) ?? [])
			{
				callback(
					{
						data,
					},
				);
			}
		}

		frame(latest: string): void
		{
			this.emit(
				"message",
				JSON.stringify(
					{
						type: "tree.changed",
						latest,
					},
				),
			);
		}
	}

	function row(id: string, parentId: string | null): NodeResponse
	{
		return {
			id,
			parent_id: parentId,
			name: id,
			note: null,
			priority: 100,
			data:
			{
				layoutMode: null,
			},
			createdAt: 0,
			modifiedAt: 0,
			completedAt: null,
			hasChildren: false,
			hasUncompletedChildren: false,
			isMirror: false,
		};
	}

	/** Each test's marks run past the last test's, since the change feed's mark is module state. */
	let mark = 0;
	const nextMark = () => String(++mark).padStart(6, "0");

	let root: Root | undefined;
	let client: InstanceType<typeof QueryClient>;
	let changesSince: (string | null)[];
	let answer: () => NodeChangesResponse;
	let enabledFeatures: Record<string, true>;
	let featureReads: number;

	beforeAll(async () =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		// Seed the shared change feed so later syncs read `?since=` instead of refetching everything.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Promise.resolve(
					Response.json(
						{
							latest: nextMark(),
							reset: false,
							changedIds: [],
							deletedIds: [],
							children: [],
						},
					),
				),
			),
		);
		await syncNodeChanges(new QueryClient());
	});

	beforeEach(() =>
	{
		vi.useFakeTimers();
		FakeSocket.instances.length = 0;
		changesSince = [];
		answer = () => (
		{
			latest: nextMark(),
			reset: false,
			changedIds: [],
			deletedIds: [],
			children: [],
		});
		enabledFeatures = {};
		featureReads = 0;
		useOutlineStore.setState(
			{
				fullWidthPage: false,
				alwaysVisibleControls: false,
			},
		);
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) =>
			{
				const url = new URL(input, "http://example.com");
				if (url.pathname === "/api/v1/features")
				{
					featureReads += 1;
					return Promise.resolve(
						Response.json(
							{
								visible: [],
								enabled: enabledFeatures,
								available: true,
							},
						),
					);
				}
				if (url.pathname !== "/api/v1/nodes/changes")
				{
					throw new Error(`Unexpected fetch ${input}`);
				}
				changesSince.push(url.searchParams.get("since"));
				return Promise.resolve(Response.json(answer()));
			}),
		);
		client = new QueryClient();
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client,
					},
					createElement(Harness),
				),
			);
		});
	});

	afterEach(() =>
	{
		act(() =>
		{
			root?.unmount();
		});
		root = undefined;
		document.body.innerHTML = "";
		vi.useRealTimers();
	});

	function Harness(): null
	{
		useOutlineLiveSync();
		useFeatureStoreSync();
		return null;
	}

	/** Let queued promises (the sync and its fetch) run. */
	async function settle(): Promise<void>
	{
		await act(async () =>
		{
			await vi.advanceTimersByTimeAsync(0);
		});
	}

	const socket = () => FakeSocket.instances.at(-1)!;
	const listIds = (parentId: string) =>
		client.getQueryData<NodeResponse[]>(nodeKeys.children(parentId))?.map((node) => node.id);

	describe("useOutlineLiveSync", () =>
	{
		it("opens the events socket and patches both parents of a remote move on a frame", async () =>
		{
			client.setQueryData(nodeKeys.children("P1"), [row("X", "P1"), row("Y", "P1")]);
			client.setQueryData(nodeKeys.children("P2"), []);
			answer = () => (
			{
				latest: nextMark(),
				reset: false,
				changedIds: ["X"],
				deletedIds: [],
				children: [
					{
						parentId: "P1",
						nodes: [row("Y", "P1")],
					},
					{
						parentId: "P2",
						nodes: [row("X", "P2")],
					},
				],
			});
			socket().emit("open");
			socket().frame("ignored");
			await settle();

			expect(
				{
					url: socket().url,
					fetches: changesSince.length,
					p1: listIds("P1"),
					p2: listIds("P2"),
				},
			).toStrictEqual(
				{
					url: `ws://${globalThis.location.host}/api/v1/nodes/events`,
					fetches: 1,
					p1: ["Y"],
					p2: ["X"],
				},
			);
		});

		it("coalesces two frames in the same tick into one changes read", async () =>
		{
			socket().emit("open");
			socket().frame("a");
			socket().frame("b");
			await settle();
			expect(changesSince).toHaveLength(1);
		});

		it("reads once more for frames that arrive while a read is in flight", async () =>
		{
			let release!: () => void;
			const gate = new Promise<void>((resolve) =>
			{
				release = resolve;
			});
			const fetchMock = vi.mocked(fetch);
			const fallback = fetchMock.getMockImplementation()!;
			fetchMock.mockImplementationOnce(async (input) =>
			{
				await gate;
				return fallback(input);
			});
			socket().emit("open");
			socket().frame("a");
			await settle();
			socket().frame("b");
			socket().frame("c");
			release();
			await settle();
			await settle();
			expect(changesSince).toHaveLength(2);
		});

		it("skips a frame its last read already covers, such as the echo of the tab's own write, and reads a newer one", async () =>
		{
			socket().emit("open");
			// The tab's own write settles with a read, moving the mark past the watermark its echo frame carries.
			const echo = "000000";
			await act(async () => syncNodeChanges(client));
			socket().frame(echo);
			await settle();
			const afterEcho = changesSince.length;
			socket().frame("999999");
			await settle();
			expect(
				{
					afterEcho,
					reads: changesSince.length,
				},
			).toStrictEqual(
				{
					afterEcho: 1,
					reads: 2,
				},
			);
		});

		it("skips an echo frame that arrives while the tab's own settle read is in flight", async () =>
		{
			let release!: () => void;
			const gate = new Promise<void>((resolve) =>
			{
				release = resolve;
			});
			const fetchMock = vi.mocked(fetch);
			const fallback = fetchMock.getMockImplementation()!;
			fetchMock.mockImplementationOnce(async (input) =>
			{
				await gate;
				return fallback(input);
			});
			socket().emit("open");
			let settled!: Promise<void>;
			act(() =>
			{
				settled = syncNodeChanges(client);
			});
			socket().frame("000000");
			await settle();
			release();
			await act(async () => settled);
			await settle();
			expect(changesSince).toHaveLength(1);
		});

		it("does not read on the first open, then reads once after a drop and reconnect", async () =>
		{
			const first = socket();
			first.emit("open");
			await settle();
			expect(changesSince).toHaveLength(0);

			vi.spyOn(Math, "random").mockReturnValue(0);
			first.emit("close");
			await settle();
			expect(FakeSocket.instances).toHaveLength(1);
			await act(async () =>
			{
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(FakeSocket.instances).toHaveLength(2);
			socket().emit("open");
			await settle();
			expect(changesSince).toHaveLength(1);
		});

		it("catches up when the tab becomes visible while the socket is down", async () =>
		{
			socket().emit("open");
			socket().emit("close");
			vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
			document.dispatchEvent(new Event("visibilitychange"));
			await settle();
			expect(changesSince).toHaveLength(1);
		});

		it("re-fetches the account's feature flags on an account.changed frame, so full width turns on without a reload", async () =>
		{
			await settle();
			const before =
			{
				reads: featureReads,
				fullWidthPage: useOutlineStore.getState().fullWidthPage,
			};
			enabledFeatures =
			{
				full_width_page: true,
			};
			socket().emit("open");
			socket().emit(
				"message",
				JSON.stringify(
					{
						type: "account.changed",
						version: "bbbbbbbbbbbbbbbb",
					},
				),
			);
			await settle();
			await settle();
			expect(
				{
					before,
					reads: featureReads,
					changesReads: changesSince.length,
					fullWidthPage: useOutlineStore.getState().fullWidthPage,
				},
			).toStrictEqual(
				{
					before:
					{
						reads: 1,
						fullWidthPage: false,
					},
					reads: 2,
					changesReads: 0,
					fullWidthPage: true,
				},
			);
		});

		it("closes the socket and stops reconnecting on unmount", async () =>
		{
			const first = socket();
			first.emit("open");
			act(() =>
			{
				root?.unmount();
			});
			root = undefined;
			first.emit("close");
			await act(async () =>
			{
				await vi.advanceTimersByTimeAsync(200_000);
			});
			expect(
				{
					readyState: first.readyState,
					sockets: FakeSocket.instances.length,
				},
			).toStrictEqual(
				{
					readyState: 3,
					sockets: 1,
				},
			);
		});
		it("sends the user to login when the socket upgrade fails while signed out", async () =>
		{
			const assigned: string[] = [];
			vi.spyOn(globalThis.location, "assign").mockImplementation((url: string | URL) =>
			{
				assigned.push(String(url));
			});
			const fetchMock = vi.mocked(fetch);
			const fallback = fetchMock.getMockImplementation()!;
			const probes: string[] = [];
			fetchMock.mockImplementation(async (input) =>
			{
				if (input === "/health")
				{
					probes.push(input);
					return Response.json(
						{
							error: "unauthenticated",
						},
						{
							status: 401,
						},
					);
				}
				return fallback(input);
			});

			socket().emit("open");
			socket().emit("close");
			await settle();
			const afterDrop = probes.length;
			await act(async () =>
			{
				await vi.advanceTimersByTimeAsync(10_000);
			});
			socket().emit("close");
			await settle();

			expect(
				{
					afterDrop,
					probes,
					assigned,
				},
			).toStrictEqual(
				{
					afterDrop: 0,
					probes: ["/health"],
					assigned: [
						`/login?next=${encodeURIComponent(`${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`)}`,
					],
				},
			);
			vi.restoreAllMocks();
		});
	});
});
