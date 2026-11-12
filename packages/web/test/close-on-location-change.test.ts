import {beforeEach, describe, expect, it, vi} from "vite-plus/test";

const hooks = vi.hoisted(() => (
{
	refs: [] as
	{
		current: unknown;
	}[],
	cursor: 0,
	locationKey: "opened",
}));

vi.mock("react", () => (
{
	useRef(initial: unknown)
	{
		const index = hooks.cursor++;
		hooks.refs[index] ??=
		{
			current: initial,
		};
		return hooks.refs[index];
	},
	useEffect(callback: () => unknown)
	{
		callback();
	},
}));
vi.mock("react-router-dom", () => (
{
	useLocation: () => (
	{
		key: hooks.locationKey,
		pathname: "/",
		search: "",
		hash: "",
	}),
}));

const closeHook = await import("../src/client/hooks/use-close-on-location-change.js");

/** Render the hook once at `locationKey`, the way a re-render of its host would, and count close calls. */
function renderAt(locationKey: string, close: () => void): void
{
	hooks.cursor = 0;
	hooks.locationKey = locationKey;
	closeHook.useCloseOnLocationChange(close);
}

describe("useCloseOnLocationChange", () =>
{
	beforeEach(() =>
	{
		hooks.refs = [];
	});

	it("leaves the flyout open while the location stays where it opened", () =>
	{
		const close = vi.fn<() => void>();
		renderAt("opened", close);
		renderAt("opened", close);
		expect(close.mock.calls).toStrictEqual([]);
	});

	it("closes the flyout once the location changes", () =>
	{
		const close = vi.fn<() => void>();
		renderAt("opened", close);
		renderAt("elsewhere", close);
		expect(close.mock.calls).toStrictEqual([[]]);
	});
});
