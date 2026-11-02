import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";

function stripPaths(markup: string): string
{
	return markup.replaceAll(/ d="[^"]*"/gu, ' d=""');
}

const CHECK_ICON =
	'<div class="h-full flex items-center"><svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="circle-check" class="svg-inline--fa fa-circle-check fa-lg text-success" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d=""></path></svg></div>';
function icon(name: string, color: string): string
{
	return `<div class="h-full flex items-center"><svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="${name}" class="svg-inline--fa fa-${name} fa-lg ${color}" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d=""></path></svg></div>`;
}
const CLOSE =
	'<div class="h-full flex items-center"><span class="p-s cursor-pointer text-tertiary"><svg aria-hidden="true" focusable="false" data-prefix="fal" data-icon="xmark" class="svg-inline--fa fa-xmark fa-1x " role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path fill="currentColor" d=""></path></svg></span></div>';
const OPEN =
	'<div class="flex justify-center fixed left-0 right-0 leading-xs" style="z-index:500;bottom:calc(72px + var(--safe-area-inset-bottom))"><div class="flex flex-row max-w-[90vw] gap-ml px-m shadow-sm bg-primary border border-solid border-primary rounded-s">';

function stubGlobals(): void
{
	vi.stubGlobal(
		"localStorage",
		{
			getItem: () => null,
			setItem: () =>
			{
			},
			removeItem: () =>
			{
			},
		},
	);
	vi.stubGlobal("innerWidth", 1272);
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
}

async function loadStore()
{
	vi.resetModules();
	stubGlobals();
	const {useOutlineStore} = await import("../src/client/stores/outline.js");
	return useOutlineStore;
}

async function loadAppMessage()
{
	stubGlobals();
	const {AppMessage} = await import("../src/client/components/app-message.js");
	return AppMessage;
}

describe("AppMessage markup", () =>
{
	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	it("renders upstream's success toast", async () =>
	{
		const AppMessage = await loadAppMessage();
		expect(
			stripPaths(
				renderToStaticMarkup(
					createElement(
						AppMessage,
						{
							text: "Link copied.",
						},
					),
				),
			),
		).toBe(
			`${OPEN}${CHECK_ICON}<div class="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">Link copied.</div>${CLOSE}</div></div>`,
		);
	});

	it("renders a failure toast with the red circle-exclamation icon", async () =>
	{
		const AppMessage = await loadAppMessage();
		const markup = stripPaths(
			renderToStaticMarkup(
				createElement(
					AppMessage,
					{
						text: "Can't move to 'X'",
						type: "failure",
					},
				),
			),
		);
		expect(markup).toBe(
			`${OPEN}${icon("circle-exclamation", "text-danger")}<div class="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">Can&#x27;t move to &#x27;X&#x27;</div>${CLOSE}</div></div>`,
		);
	});

	it("renders a warning toast with the amber triangle-exclamation icon", async () =>
	{
		const AppMessage = await loadAppMessage();
		const markup = stripPaths(
			renderToStaticMarkup(
				createElement(
					AppMessage,
					{
						text: "Careful",
						type: "warning",
					},
				),
			),
		);
		expect(markup).toBe(
			`${OPEN}${icon("triangle-exclamation", "text-warning")}<div class="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">Careful</div>${CLOSE}</div></div>`,
		);
	});

	it("raises the toast above an open dialog with zIndex 1100", async () =>
	{
		const AppMessage = await loadAppMessage();
		expect(
			stripPaths(
				renderToStaticMarkup(
					createElement(
						AppMessage,
						{
							text: "x",
							zIndex: 1100,
						},
					),
				),
			),
		).toBe(
			`${OPEN.replace("z-index:500", "z-index:1100")}${CHECK_ICON}<div class="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">x</div>${CLOSE}</div></div>`,
		);
	});

	it("renders action buttons between the text and the close button", async () =>
	{
		const AppMessage = await loadAppMessage();
		expect(
			stripPaths(
				renderToStaticMarkup(
					createElement(
						AppMessage,
						{
							text: "Moved to",
							actions: [
								{
									label: "View",
									shortcut: "shift+return",
									run: () =>
									{
									},
								},
								{
									label: "Undo",
									run: () =>
									{
									},
								},
							],
						},
					),
				),
			),
		).toBe(
			`${OPEN}${CHECK_ICON}<div class="flex-1 min-w-0 py-m truncate first-letter:capitalize text-secondary font-light">Moved to</div>` +
				'<div class="flex items-center text-primary content-end font-medium desktop:hover:underline cursor-pointer" style="height:100%"><div class="flex items-baseline"><span class="">View</span><span class="mobile:hidden text-s text-tertiary font-normal ml-xs">(shift+return)</span></div></div>' +
				'<div class="flex items-center text-primary content-end font-medium desktop:hover:underline cursor-pointer" style="height:100%"><div class="flex items-baseline"><span class="">Undo</span></div></div>' +
				`${CLOSE}</div></div>`,
		);
	});
});

describe("showAppMessage", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers();
	});

	afterEach(() =>
	{
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("shows the message and clears it after the timeout", async () =>
	{
		const store = await loadStore();
		store.getState().showAppMessage(
			"x",
			{
				timeout: 1000,
			},
		);
		expect(store.getState().appMessage).toStrictEqual(
			{
				text: "x",
				type: "success",
				actions: [],
			},
		);
		vi.advanceTimersByTime(999);
		expect(store.getState().appMessage).toStrictEqual(
			{
				text: "x",
				type: "success",
				actions: [],
			},
		);
		vi.advanceTimersByTime(1);
		expect(store.getState().appMessage).toBeNull();
	});

	it("replaces the current message and drops its pending timeout", async () =>
	{
		const store = await loadStore();
		const undo =
		{
			label: "Undo",
			run: () =>
			{
			},
		};
		store.getState().showAppMessage(
			"first",
			{
				timeout: 1000,
			},
		);
		vi.advanceTimersByTime(500);
		store.getState().showAppMessage(
			"Sorted A-Z",
			{
				timeout: 5000,
				actions: [undo],
			},
		);
		vi.advanceTimersByTime(4999);
		expect(store.getState().appMessage).toStrictEqual(
			{
				text: "Sorted A-Z",
				type: "success",
				actions: [undo],
			},
		);
		vi.advanceTimersByTime(1);
		expect(store.getState().appMessage).toBeNull();
	});

	it("hides after 300000ms by default", async () =>
	{
		const store = await loadStore();
		store.getState().showAppMessage("default");
		vi.advanceTimersByTime(299_999);
		expect(store.getState().appMessage).toStrictEqual(
			{
				text: "default",
				type: "success",
				actions: [],
			},
		);
		vi.advanceTimersByTime(1);
		expect(store.getState().appMessage).toBeNull();
	});

	it("never auto-hides with timeout 0, but hides when asked", async () =>
	{
		const store = await loadStore();
		store.getState().showAppMessage(
			"sticky",
			{
				timeout: 0,
			},
		);
		vi.advanceTimersByTime(600_000);
		expect(store.getState().appMessage).toStrictEqual(
			{
				text: "sticky",
				type: "success",
				actions: [],
			},
		);
		store.getState().hideAppMessage();
		expect(store.getState().appMessage).toBeNull();
	});

	it("records the message type, defaulting to success", async () =>
	{
		const store = await loadStore();
		store.getState().showAppMessage(
			"x",
			{
				type: "warning",
				timeout: 1000,
			},
		);
		expect(store.getState().appMessage?.type).toBe("warning");
		store.getState().showAppMessage(
			"y",
			{
				timeout: 1000,
			},
		);
		expect(store.getState().appMessage?.type).toBe("success");
	});
});

describe("hide on navigation", () =>
{
	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	it("hides the message when the location changes", async () =>
	{
		const store = await loadStore();
		store.getState().dispatchNav(
			{
				type: "navigate",
				loc:
				{
					id: "a",
					query: null,
				},
			},
		);
		store.getState().showAppMessage("Moved to 'b'");
		store.getState().dispatchNav(
			{
				type: "navigate",
				loc:
				{
					id: "b",
					query: null,
				},
			},
		);
		expect(store.getState().appMessage).toBeNull();
	});

	it("keeps the message when the location is unchanged", async () =>
	{
		const store = await loadStore();
		store.getState().dispatchNav(
			{
				type: "navigate",
				loc:
				{
					id: "a",
					query: null,
				},
			},
		);
		store.getState().showAppMessage("Link copied.");
		store.getState().dispatchNav(
			{
				type: "popstate",
				loc:
				{
					id: "a",
					query: null,
				},
			},
		);
		expect(store.getState().appMessage).toStrictEqual(
			{
				text: "Link copied.",
				type: "success",
				actions: [],
			},
		);
	});
});

describe("dismissOn", () =>
{
	let target: EventTarget;

	async function loadStoreWithWindow()
	{
		const store = await loadStore();
		target = new EventTarget();
		vi.stubGlobal("addEventListener", target.addEventListener.bind(target));
		vi.stubGlobal("removeEventListener", target.removeEventListener.bind(target));
		return store;
	}

	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	it("hides the message on one of its dismissOn window events", async () =>
	{
		const store = await loadStoreWithWindow();
		store.getState().showAppMessage(
			"Mirror(s) copied.",
			{
				dismissOn: ["copy", "paste"],
			},
		);
		target.dispatchEvent(new Event("paste"));
		expect(store.getState().appMessage).toBeNull();
	});

	it("ignores events outside dismissOn", async () =>
	{
		const store = await loadStoreWithWindow();
		store.getState().showAppMessage(
			"Mirror(s) copied.",
			{
				dismissOn: ["copy"],
			},
		);
		target.dispatchEvent(new Event("paste"));
		expect(store.getState().appMessage).toStrictEqual(
			{
				text: "Mirror(s) copied.",
				type: "success",
				actions: [],
			},
		);
	});

	it("drops the previous message's dismissOn listeners when replaced", async () =>
	{
		const store = await loadStoreWithWindow();
		store.getState().showAppMessage(
			"Mirror(s) copied.",
			{
				dismissOn: ["copy"],
			},
		);
		store.getState().showAppMessage("Link copied.");
		target.dispatchEvent(new Event("copy"));
		expect(store.getState().appMessage).toStrictEqual(
			{
				text: "Link copied.",
				type: "success",
				actions: [],
			},
		);
	});
});

describe("appMessageZIndex", () =>
{
	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	it("is 500 normally and 1100 (modal 600 + message 500) while a dialog is open", async () =>
	{
		const store = await loadStore();
		const {appMessageZIndex} = await import("../src/client/components/app-message.js");
		const closed = appMessageZIndex();
		store.setState(
			{
				exportDialogOpen: true,
			},
		);
		expect(
			{
				closed,
				open: appMessageZIndex(),
			},
		).toStrictEqual(
			{
				closed: 500,
				open: 1100,
			},
		);
	});
});
