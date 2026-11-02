// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {setZoomViewLoader, zoomWhenViewReady} from "../src/client/zoom-gate.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";
const CAROL = "1b2c3d4e-0b7d-4e5a-8c3f-cccccccccccc";

interface Load
{
	target: string | null;
	resolve: () => void;
}

let loads: Load[] = [];
let uninstall: (() => void) | undefined;

/** A loader holding every target but `cached` until the test resolves its load. */
function installLoader(cached: ReadonlySet<string | null> = new Set()): void
{
	uninstall = setZoomViewLoader(
		{
			cached: (target) => cached.has(target),
			load: async (target) =>
				new Promise<void>((resolve) =>
				{
					loads.push(
						{
							target,
							resolve,
						},
					);
				}),
		},
	);
}

/** Resolve every pending load and let the gate's continuations run. */
async function finishLoads(): Promise<void>
{
	for (const load of loads.splice(0))
	{
		load.resolve();
	}
	await new Promise((resolve) =>
	{
		setTimeout(resolve, 0);
	});
}

/** Zoom the store through the gate, recording each landing. */
function gatedZoom(target: string | null, landed: (string | null)[]): void
{
	zoomWhenViewReady(target, () =>
	{
		landed.push(target);
		useOutlineStore.getState().zoom(target);
	});
}

beforeEach(() =>
{
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	loads = [];
});

afterEach(() =>
{
	uninstall?.();
	uninstall = undefined;
});

describe("zoomWhenViewReady", () =>
{
	it("lands at once with no loader registered", () =>
	{
		const landed: (string | null)[] = [];
		gatedZoom(ALICE, landed);
		expect(
			{
				landed,
				zoomed: useOutlineStore.getState().zoomedNodeId,
			},
		).toStrictEqual(
			{
				landed: [ALICE],
				zoomed: ALICE,
			},
		);
	});

	it("lands at once when the view is cached", () =>
	{
		installLoader(new Set([ALICE]));
		const landed: (string | null)[] = [];
		gatedZoom(ALICE, landed);
		expect(
			{
				landed,
				loads: loads.length,
			},
		).toStrictEqual(
			{
				landed: [ALICE],
				loads: 0,
			},
		);
	});

	it("holds the zoom on the shown view until an uncached view loads, then lands once", async () =>
	{
		installLoader();
		const changes: (string | null)[] = [];
		const unsubscribe = useOutlineStore.subscribe((state, previous) =>
		{
			if (state.zoomedNodeId !== previous.zoomedNodeId)
			{
				changes.push(state.zoomedNodeId);
			}
		});
		const landed: (string | null)[] = [];
		gatedZoom(ALICE, landed);
		const held =
		{
			landed: [...landed],
			changes: [...changes],
			loading: loads.map((load) => load.target),
		};
		await finishLoads();
		unsubscribe();
		expect(
			{
				held,
				landed,
				changes,
			},
		).toStrictEqual(
			{
				held:
				{
					landed: [],
					changes: [],
					loading: [ALICE],
				},
				landed: [ALICE],
				changes: [ALICE],
			},
		);
	});

	it("starts one load for a target asked again while it loads", async () =>
	{
		installLoader();
		const landed: (string | null)[] = [];
		gatedZoom(ALICE, landed);
		gatedZoom(ALICE, landed);
		const loading = loads.map((load) => load.target);
		await finishLoads();
		expect(
			{
				loading,
				landed,
			},
		).toStrictEqual(
			{
				loading: [ALICE],
				landed: [ALICE],
			},
		);
	});

	it("drops a held zoom a later one replaced", async () =>
	{
		installLoader();
		const landed: (string | null)[] = [];
		gatedZoom(ALICE, landed);
		gatedZoom(BOB, landed);
		await finishLoads();
		expect(
			{
				landed,
				zoomed: useOutlineStore.getState().zoomedNodeId,
			},
		).toStrictEqual(
			{
				landed: [BOB],
				zoomed: BOB,
			},
		);
	});

	it("drops a held zoom when a zoom back to the shown view cancels it", async () =>
	{
		installLoader();
		useOutlineStore.getState().zoom(CAROL);
		const landed: (string | null)[] = [];
		gatedZoom(ALICE, landed);
		gatedZoom(CAROL, landed);
		await finishLoads();
		expect(
			{
				landed,
				zoomed: useOutlineStore.getState().zoomedNodeId,
			},
		).toStrictEqual(
			{
				landed: [CAROL],
				zoomed: CAROL,
			},
		);
	});

	it("drops a held zoom when the outline zoomed elsewhere meanwhile", async () =>
	{
		installLoader();
		const landed: (string | null)[] = [];
		gatedZoom(ALICE, landed);
		useOutlineStore.getState().zoom(BOB);
		await finishLoads();
		expect(
			{
				landed,
				zoomed: useOutlineStore.getState().zoomedNodeId,
			},
		).toStrictEqual(
			{
				landed: [],
				zoomed: BOB,
			},
		);
	});

	it("lands a target asked again after the outline zoomed elsewhere while it loaded", async () =>
	{
		installLoader();
		const landed: (string | null)[] = [];
		gatedZoom(ALICE, landed);
		useOutlineStore.getState().zoom(BOB);
		gatedZoom(ALICE, landed);
		await finishLoads();
		expect(
			{
				landed,
				zoomed: useOutlineStore.getState().zoomedNodeId,
			},
		).toStrictEqual(
			{
				landed: [ALICE],
				zoomed: ALICE,
			},
		);
	});

	it("still lands when the load fails", async () =>
	{
		uninstall = setZoomViewLoader(
			{
				cached: () => false,
				load: async () => Promise.reject(new Error("offline")),
			},
		);
		const landed: (string | null)[] = [];
		gatedZoom(ALICE, landed);
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 0);
		});
		expect(landed).toStrictEqual([ALICE]);
	});
});
