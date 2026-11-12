import {beforeEach, describe, expect, it, vi} from "vite-plus/test";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
	},
);
vi.stubGlobal("matchMedia", () => (
{
	matches: false,
	addEventListener: () =>
	{
	},
}));
vi.stubGlobal(
	"document",
	{
		documentElement:
		{
			dataset: {},
		},
		body:
		{
			classList:
			{
				toggle: () => true,
				contains: () => false,
			},
		},
	},
);
vi.stubGlobal("addEventListener", () => {});

const {crumbZoomOutRows, whenZoomLands} = await import("../src/client/crumb-zoom.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

const ALICE = "4823cefa-5fc0-478c-88ac-aaaaaaaaaaaa";
const BOB = "9a1f6c2e-0b7d-4e5a-8c3f-bbbbbbbbbbbb";
const CAROL = "1b2c3d4e-0b7d-4e5a-8c3f-cccccccccccc";
const DAVE = "5e6f7a8b-0b7d-4e5a-8c3f-dddddddddddd";

describe("crumbZoomOutRows", () =>
{
	it("lists the rows below a clicked ancestor down to the zoomed node, deepest first", () =>
	{
		expect(crumbZoomOutRows([ALICE, BOB, CAROL, DAVE], ALICE)).toStrictEqual([DAVE, CAROL, BOB]);
	});

	it("lists nothing for a crumb off the trail or the zoomed node itself", () =>
	{
		expect([crumbZoomOutRows([ALICE, BOB], CAROL), crumbZoomOutRows([ALICE, BOB], BOB)]).toStrictEqual([[], []]);
	});
});

describe("whenZoomLands", () =>
{
	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				zoomedNodeId: DAVE,
			},
		);
	});

	it("resolves true once the outline zooms to the target, calling onLand in the zoom itself", async () =>
	{
		const zoomedAtLand: (string | null)[] = [];
		const landed = whenZoomLands(ALICE, () =>
		{
			zoomedAtLand.push(useOutlineStore.getState().zoomedNodeId);
		});
		useOutlineStore.getState().zoom(ALICE);
		await expect(landed).resolves.toBe(true);
		expect(zoomedAtLand).toStrictEqual([ALICE]);
	});

	it("resolves true at once when the outline already shows the target", async () =>
	{
		useOutlineStore.setState(
			{
				zoomedNodeId: ALICE,
			},
		);
		await expect(whenZoomLands(ALICE, () => {})).resolves.toBe(true);
	});

	it("resolves false when the outline zooms elsewhere first", async () =>
	{
		const onLand = vi.fn<() => void>();
		const landed = whenZoomLands(ALICE, onLand);
		useOutlineStore.getState().zoom(BOB);
		useOutlineStore.getState().zoom(ALICE);
		await expect(landed).resolves.toBe(false);
		expect(onLand.mock.calls).toStrictEqual([]);
	});
});
