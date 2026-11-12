import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {ReactElement, ReactNode} from "react";
import {z} from "zod";
import type {Ladders} from "../src/client/ladder-state.js";
import type {LadderItem} from "../src/server/ladder-model.js";
import {LadderView} from "../src/client/components/ladder-view.js";

vi.mock("../src/client/components/ladder-tree.js", () => (
{
	LadderTree: () => null,
}));

function isUpdater(value: unknown): value is (previous: unknown) => unknown
{
	return typeof value === "function";
}

const hooks = vi.hoisted(() => (
{
	values: [] as unknown[],
	cursor: 0,
	effects: [] as (() => unknown)[],
}));
vi.mock("react", () => (
{
	useState(initial: unknown)
	{
		const index = hooks.cursor++;
		if (!(index in hooks.values))
		{
			hooks.values[index] = initial;
		}
		return [
			hooks.values[index],
			(value: unknown) =>
			{
				hooks.values[index] = isUpdater(value) ? value(hooks.values[index]) : value;
			},
		];
	},
	useRef(initial: unknown)
	{
		const index = hooks.cursor++;
		if (!(index in hooks.values))
		{
			hooks.values[index] =
			{
				current: initial,
			};
		}
		return hooks.values[index];
	},
	useEffect(callback: () => unknown)
	{
		hooks.effects.push(callback);
	},
	useMemo: (callback: () => unknown) => callback(),
	useCallback: (callback: unknown) => callback,
}));

interface ElementProps
{
	children?: ReactNode;
	[key: string]: unknown;
}

function isElement(node: unknown): node is ReactElement<ElementProps>
{
	return typeof node === "object" && node !== null && "props" in node && typeof node.props === "object";
}

function elements(node: ReactNode): ReactElement<ElementProps>[]
{
	if (Array.isArray(node))
	{
		return node.flatMap(elements);
	}
	if (!isElement(node))
	{
		return [];
	}
	return [node, ...elements(node.props.children)];
}

/** Call the callback prop `key`, failing the test when the element has none. */
function invoke(props: ElementProps, key: string, ...args: unknown[]): unknown
{
	const callback = props[key];
	if (typeof callback !== "function")
	{
		throw new TypeError(`${key} is not a callback prop`);
	}
	return Reflect.apply(callback, undefined, args);
}

/** Render a function component element one level down, the way React would. */
function renderComponent(element: ReactElement<ElementProps>): ReactNode
{
	if (typeof element.type !== "function")
	{
		throw new TypeError("not a function component");
	}
	const rendered: unknown = Reflect.apply(element.type, undefined, [element.props]);
	return isElement(rendered) ? rendered : null;
}

const RequestBodySchema = z.object(
	{
		node_id: z.string(),
		to_tier: z.string().nullish(),
	},
);
const TierItemsSchema = z.object(
	{
		personal: z.object(
			{
				tiers: z.array(
					z.object(
						{
							items: z.array(z.unknown()),
						},
					),
				),
			},
		),
	},
);

/** The items of each personal tier, as the page currently holds them. */
const personalTierItems = () => TierItemsSchema.parse(hooks.values[0]).personal.tiers.map((tier) => tier.items);

function render()
{
	hooks.cursor = 0;
	return elements(LadderView());
}

function tierProps()
{
	const props = render().find((element) => element.props.tier !== undefined)?.props;
	if (!props)
	{
		throw new Error("no tier is rendered");
	}
	const callback =
		(key: string) =>
		(...args: unknown[]): void =>
		{
			invoke(props, key, ...args);
		};
	return {
		onSelect: callback("onSelect"),
		selected: props.selected,
		onGripCancel: callback("onGripCancel"),
		onGripDown: callback("onGripDown"),
		onGripMove: callback("onGripMove"),
		onGripUp: callback("onGripUp"),
		onStep: callback("onStep"),
		onComplete: callback("onComplete"),
		rowErrors: props.rowErrors,
		pending: props.pending,
	};
}

const item = (id: string): LadderItem => (
{
	id,
	name: id,
	children: [],
	descendantCount: 0,
});
const ladders = (): Ladders => (
{
	personal:
	{
		root: "personal",
		bucketId: "personal-bucket",
		tiers: [
			{
				tier: 1,
				id: "first",
				label: "1st",
				capacity: 2,
				state: "exact",
				items: [item("alice"), item("bob")],
			},
			{
				tier: 2,
				id: "second",
				label: "2nd",
				capacity: 4,
				state: "room",
				items: [],
			},
		],
	},
});
interface FakeResponse
{
	ok: boolean;
	json: () => Promise<unknown>;
}
const request = vi.fn<
	(
		path: string,
		options:
		{
			body: string;
		},
	) => Promise<FakeResponse>
>();
const settle = async () =>
	new Promise((resolve) =>
	{
		setImmediate(resolve);
	});

/** Mount the page and answer its initial ladder read, the way the browser would. */
async function load(value: unknown)
{
	hooks.values = [];
	hooks.effects = [];
	request.mockResolvedValueOnce(
		{
			ok: true,
			json: async () =>
				Promise.resolve(
					{
						ladders: value,
					},
				),
		},
	);
	render();
	hooks.effects[0]();
	await settle();
	request.mockClear();
}

beforeEach(async () =>
{
	request.mockReset().mockImplementation(
		async (
			path: string,
			options:
			{
				body: string;
			},
		) =>
		{
			const body = RequestBodySchema.parse(JSON.parse(options.body));
			return Promise.resolve(
				{
					ok: true,
					json: async () =>
						Promise.resolve(
							{
								event:
								{
									nodeId: body.node_id,
									verb: path.endsWith("complete") ? "complete" : "move",
									name: body.node_id,
									fromTier: "1st",
									toTier: body.to_tier ?? null,
									at: "2000-01-01T00:00:00.000Z",
								},
							},
						),
				},
			);
		},
	);
	vi.stubGlobal("fetch", request);
	await load(ladders());
});

describe("local ladder actions", () =>
{
	it("saves a reverse-selected group in display order into an empty tier", async () =>
	{
		tierProps().onSelect("bob", false);
		tierProps().onSelect("alice", true);
		tierProps().onStep("alice", "2nd");
		await settle();
		expect(request.mock.calls).toStrictEqual([
			[
				"/api/v1/ladder/move",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							root: "personal",
							node_id: "alice",
							to_tier: "2nd",
						},
					),
				},
			],
			[
				"/api/v1/ladder/move",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							root: "personal",
							node_id: "bob",
							to_tier: "2nd",
						},
					),
				},
			],
		]);
	});

	it("stops a group at the failed move without dispatching the rest", async () =>
	{
		request.mockResolvedValue(
			{
				ok: false,
				json: async () =>
					Promise.resolve(
						{
							error: "Test write rejected",
						},
					),
			},
		);
		tierProps().onSelect("alice", false);
		tierProps().onSelect("bob", true);
		tierProps().onStep("alice", "2nd");
		await settle();
		expect(request.mock.calls).toStrictEqual([
			[
				"/api/v1/ladder/move",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							root: "personal",
							node_id: "alice",
							to_tier: "2nd",
						},
					),
				},
			],
		]);
	});

	it("completes only the clicked row even when other rows are selected", async () =>
	{
		tierProps().onSelect("alice", false);
		tierProps().onSelect("bob", true);
		tierProps().onComplete("bob");
		await settle();
		expect(request.mock.calls).toStrictEqual([
			[
				"/api/v1/ladder/complete",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							root: "personal",
							node_id: "bob",
						},
					),
				},
			],
		]);
	});

	it("reconciles an optimistic move with the returned event", async () =>
	{
		let respond!: (value: FakeResponse) => void;
		request.mockReturnValue(
			new Promise((resolve) =>
			{
				respond = resolve;
			}),
		);
		tierProps().onStep("alice", "2nd");
		expect(personalTierItems()).toStrictEqual([[item("bob")], [item("alice")]]);
		respond(
			{
				ok: true,
				json: async () =>
					Promise.resolve(
						{
							event:
							{
								nodeId: "alice",
								verb: "move",
								name: "alice",
								fromTier: "2nd",
								toTier: "1st",
								at: "2000-01-01T00:00:00.000Z",
							},
						},
					),
			},
		);
		await settle();
		expect(personalTierItems()).toStrictEqual([[item("bob"), item("alice")], []]);
	});

	it("restores a failed Done row without undoing another socket write and clears its error on retry", async () =>
	{
		let respond!: (value: FakeResponse) => void;
		request.mockReturnValueOnce(
			new Promise((resolve) =>
			{
				respond = resolve;
			}),
		);
		const listeners: Record<string, (message: {data: string}) => void> = {};
		vi.stubGlobal(
			"location",
			{
				protocol: "http:",
				host: "example.com",
			},
		);
		vi.stubGlobal(
			"WebSocket",
			class
			{
				addEventListener(name: string, callback: (message: {data: string}) => void)
				{
					listeners[name] = callback;
				}
			},
		);
		const actions = tierProps();
		hooks.effects[1]();
		actions.onComplete("alice");
		listeners.message(
			{
				data: JSON.stringify(
					{
						nodeId: "bob",
						verb: "move",
						name: "bob",
						fromTier: "1st",
						toTier: "2nd",
						at: "2000-01-01T00:00:00.000Z",
					},
				),
			},
		);
		respond(
			{
				ok: false,
				json: async () =>
					Promise.resolve(
						{
							error: "Test write rejected",
						},
					),
			},
		);
		await settle();
		expect(personalTierItems()).toStrictEqual([[item("alice")], [item("bob")]]);
		expect(tierProps().rowErrors).toStrictEqual(
			{
				alice: "Test write rejected",
			},
		);
		tierProps().onComplete("alice");
		await settle();
		expect(tierProps().rowErrors).toStrictEqual({});
		expect(personalTierItems()).toStrictEqual([[], [item("bob")]]);
	});

	it("keeps a socket-confirmed completion when its HTTP response is lost", async () =>
	{
		let reject!: (reason: Error) => void;
		request.mockReturnValueOnce(
			new Promise((_resolve, rejectRequest) =>
			{
				reject = rejectRequest;
			}),
		);
		const listeners: Record<string, (message: {data: string}) => void> = {};
		vi.stubGlobal(
			"location",
			{
				protocol: "http:",
				host: "example.com",
			},
		);
		vi.stubGlobal(
			"WebSocket",
			class
			{
				addEventListener(name: string, callback: (message: {data: string}) => void)
				{
					listeners[name] = callback;
				}
			},
		);
		const actions = tierProps();
		hooks.effects[1]();
		actions.onComplete("alice");
		listeners.message(
			{
				data: JSON.stringify(
					{
						nodeId: "alice",
						verb: "complete",
						name: "alice",
						fromTier: "1st",
						toTier: null,
						at: "2000-01-01T00:00:00.000Z",
					},
				),
			},
		);
		reject(new Error("Test response lost"));
		await settle();
		expect(personalTierItems()).toStrictEqual([[item("bob")], []]);
		expect(tierProps().rowErrors).toStrictEqual({});
	});

	it("re-reads the ladder when the connection drops mid-move instead of guessing", async () =>
	{
		const landed = ladders();
		landed.personal.tiers = [
			{
				...landed.personal.tiers[0],
				state: "room",
				items: [item("bob")],
			},
			{
				...landed.personal.tiers[1],
				items: [item("alice")],
			},
		];
		request.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(
			{
				ok: true,
				json: async () =>
					Promise.resolve(
						{
							ladders: landed,
						},
					),
			},
		);
		tierProps().onStep("alice", "2nd");
		await settle();
		expect(
			{
				calls: request.mock.calls.map(([path]) => path),
				ladders: hooks.values[0],
				errors: tierProps().rowErrors,
				pending: tierProps().pending,
			},
		).toStrictEqual(
			{
				calls: ["/api/v1/ladder/move", "/api/v1/ladder"],
				ladders: landed,
				errors: {},
				pending: new Set(),
			},
		);
	});

	it("creates the next ordinal under the displayed bucket and refreshes the page", async () =>
	{
		request
			.mockResolvedValueOnce(
				{
					ok: true,
					json: async () => Promise.resolve({}),
				},
			)
			.mockResolvedValueOnce(
				{
					ok: true,
					json: async () =>
						Promise.resolve(
							{
								ladders: ladders(),
							},
						),
				},
			);
		const button = render().find((element) => element.props.children === "Add bottom tier");
		if (!button)
		{
			throw new Error("Add bottom tier button is missing");
		}
		invoke(button.props, "onClick");
		await settle();
		expect(request.mock.calls).toStrictEqual([
			[
				"/api/v1/nodes",
				{
					method: "POST",
					headers:
					{
						"content-type": "application/json",
					},
					body: JSON.stringify(
						{
							parent_id: "personal-bucket",
							name: "3rd",
							position: 0,
						},
					),
				},
			],
			["/api/v1/ladder"],
		]);
	});
});

describe("a row whose write is in flight", () =>
{
	function rowButtons(nodeId: string)
	{
		const rows = render()
			.filter((element) => element.props.tier !== undefined)
			.flatMap((tier) => elements(renderComponent(tier)));
		const row = rows.find((element) => element.props["data-node-id"] === nodeId);
		if (!row)
		{
			throw new Error(`no row ${nodeId}`);
		}
		return elements(row.props.children)
			.filter((element) => element.type === "button" && element.props.className !== "ladder-tree-button")
			.map((button) => (
			{
				label: button.props["aria-label"] ?? button.props.children,
				disabled: button.props.disabled,
			}));
	}

	beforeEach(async () =>
	{
		await load(
			{
				personal:
				{
					...ladders().personal,
					tiers: [
						{
							tier: 1,
							id: "first",
							label: "1st",
							capacity: 2,
							state: "exact",
							items: [item("alice"), item("bob")],
						},
						{
							tier: 2,
							id: "second",
							label: "2nd",
							capacity: 4,
							state: "room",
							items: [item("carol")],
						},
					],
				},
			},
		);
		request.mockReturnValue(new Promise(() => {}));
	});

	it("disables only its own buttons while the other rows stay usable", () =>
	{
		tierProps().onStep("alice", "2nd");
		expect(
			{
				bob: rowButtons("bob"),
				carol: rowButtons("carol"),
			},
		).toStrictEqual(
			{
				bob: [
					{
						label: "Move to the tier above",
						disabled: true,
					},
					{
						label: "Move to 2nd",
						disabled: false,
					},
					{
						label: "Done",
						disabled: false,
					},
				],
				carol: [
					{
						label: "Move to 1st",
						disabled: false,
					},
					{
						label: "Move to the tier below",
						disabled: true,
					},
					{
						label: "Done",
						disabled: false,
					},
				],
			},
		);
	});

	it("still dispatches a move for another row", () =>
	{
		tierProps().onStep("alice", "2nd");
		tierProps().onStep("bob", "2nd");
		expect(request.mock.calls.map(([, options]): unknown => JSON.parse(options.body))).toStrictEqual([
			{
				root: "personal",
				node_id: "alice",
				to_tier: "2nd",
			},
			{
				root: "personal",
				node_id: "bob",
				to_tier: "2nd",
			},
		]);
	});

	it("ignores a second move of the same row until the first lands", () =>
	{
		tierProps().onStep("alice", "2nd");
		tierProps().onStep("alice", "1st");
		expect(request.mock.calls.map(([, options]): unknown => JSON.parse(options.body))).toStrictEqual([
			{
				root: "personal",
				node_id: "alice",
				to_tier: "2nd",
			},
		]);
	});
});

describe("row selection and pointer cancellation", () =>
{
	it("replaces selection on click and toggles with a modifier", () =>
	{
		tierProps().onSelect("alice", false);
		tierProps().onSelect("bob", false);
		expect(tierProps().selected).toStrictEqual(new Set(["bob"]));
		tierProps().onSelect("alice", false, true);
		expect(tierProps().selected).toStrictEqual(new Set(["bob", "alice"]));
		tierProps().onSelect("bob", false, true);
		expect(tierProps().selected).toStrictEqual(new Set(["alice"]));
	});

	it("keeps the anchor when extending and shrinking a range", () =>
	{
		tierProps().onSelect("alice", false);
		tierProps().onSelect("bob", true);
		expect(tierProps().selected).toStrictEqual(new Set(["alice", "bob"]));
		tierProps().onSelect("alice", true);
		expect(tierProps().selected).toStrictEqual(new Set(["alice"]));
	});

	it("never saves a cancelled drag", () =>
	{
		const row =
		{
			dataset:
			{
				nodeId: "bob",
			},
			getBoundingClientRect: () => (
			{
				top: 100,
				height: 40,
			}),
		};
		const zone =
		{
			dataset:
			{
				tier: "1st",
			},
			classList:
			{
				contains: () => true,
			},
			querySelectorAll: () => [row],
		};
		class FakeElement
		{
			closest(): null
			{
				return null;
			}
		}
		vi.stubGlobal("Element", FakeElement);
		vi.stubGlobal(
			"document",
			{
				elementFromPoint: () => (
				{
					closest: () => zone,
				}),
			},
		);
		const event =
		{
			button: 0,
			isPrimary: true,
			pointerType: "mouse",
			pointerId: 1,
			clientX: 100,
			clientY: 100,
			target: new FakeElement(),
			currentTarget:
			{
				setPointerCapture: vi.fn<(pointerId: number) => void>(),
			},
		};
		tierProps().onGripDown(
			event,
			{
				id: "alice",
				name: "Alice",
			},
		);
		tierProps().onGripMove(
			{
				...event,
				clientY: 140,
			},
			"Alice",
		);
		tierProps().onGripCancel();
		tierProps().onGripUp(event);
		expect(request.mock.calls).toStrictEqual([]);
	});

	it("reloads authoritative order after a partially applied move fails", async () =>
	{
		request
			.mockResolvedValueOnce(
				{
					ok: false,
					json: async () =>
						Promise.resolve(
							{
								error: "Test suffix failed",
								reconcile: true,
							},
						),
				},
			)
			.mockResolvedValueOnce(
				{
					ok: true,
					json: async () =>
						Promise.resolve(
							{
								ladders: ladders(),
							},
						),
				},
			);
		tierProps().onStep("alice", "2nd");
		await settle();
		expect(
			{
				ladders: hooks.values[0],
				errors: tierProps().rowErrors,
			},
		).toStrictEqual(
			{
				ladders: ladders(),
				errors:
				{
					alice: "Test suffix failed",
				},
			},
		);
	});
});

it("saves selected rows before the same anchor in display order", async () =>
{
	tierProps().onSelect("alice", false);
	tierProps().onSelect("bob", true);
	tierProps().onStep("bob", "2nd", "charlie");
	await settle();
	expect(request.mock.calls.map(([, options]): unknown => JSON.parse(options.body))).toStrictEqual([
		{
			root: "personal",
			node_id: "alice",
			to_tier: "2nd",
			before_id: "charlie",
		},
		{
			root: "personal",
			node_id: "bob",
			to_tier: "2nd",
			before_id: "charlie",
		},
	]);
});

describe("subtree preview", () =>
{
	const parent: LadderItem =
	{
		id: "alice",
		name: "alice",
		hasChildren: true,
		descendantCount: 3,
		children: [
			{
				id: "c1",
				name: "first child",
				children: [],
				descendantCount: 0,
			},
			{
				id: "c2",
				name: "second child",
				hasChildren: true,
				descendantCount: 1,
				children: [
					{
						id: "g1",
						name: "grandchild",
						children: [],
						descendantCount: 0,
					},
				],
			},
		],
	};
	const button =
	{
		getBoundingClientRect: () => (
		{
			left: 40,
			right: 90,
			top: 100,
			bottom: 120,
		}),
	};

	beforeEach(async () =>
	{
		const withParent = ladders();
		withParent.personal.tiers[0].items = [parent, item("bob")];
		await load(withParent);
	});

	function rows()
	{
		return render()
			.filter((element) => element.props.tier !== undefined)
			.flatMap((tier) => elements(renderComponent(tier)))
			.filter((element) => typeof element.props["data-node-id"] === "string");
	}

	function treeButton()
	{
		const found = rows()
			.flatMap((row) => elements(row.props.children))
			.find((element) => element.props.className === "ladder-tree-button");
		if (!found)
		{
			throw new Error("no Tree button");
		}
		const handler = (key: string) => (event: unknown) =>
		{
			invoke(found.props, key, event);
		};
		return {
			onMouseEnter: handler("onMouseEnter"),
			onMouseLeave: handler("onMouseLeave"),
			onFocus: handler("onFocus"),
			onBlur: handler("onBlur"),
			onKeyDown: handler("onKeyDown"),
		};
	}

	const preview = () => render().filter((element) => element.props.className === "ladder-preview");

	/** The preview's items as nested [name, children] pairs, so the test sees the tree's shape. */
	function shape(list: ReactElement<ElementProps>): unknown[]
	{
		return elements(list.props.children)
			.filter((element) => element.type === "li")
			.filter(
				(li, index, all) => !all.some((other) => other !== li && elements(other.props.children).includes(li)),
			)
			.map((li) =>
			{
				const children = elements(li.props.children);
				const name = children.find((element) => element.props.className === "ladder-preview-name");
				const nested = children.find((element) => element.type === "ul");
				return [name?.props.children, nested ? shape(nested) : []];
			});
	}

	it("keeps the child lines out of the row, so hovering a row never reflows it", () =>
	{
		const rowParts = rows().flatMap((row) => elements(row.props.children));
		expect(
			{
				rowHoverHandlers: rows().map((row) => [row.props.onMouseEnter, row.props.onPointerEnter]),
				inlineLists: rowParts.filter((element) => element.type === "ul" || element.type === "li").length,
				badge: rowParts.find((element) => element.props.className === "ladder-child-count")?.props[
					"aria-label"
				],
				preview: preview().length,
			},
		).toStrictEqual(
			{
				rowHoverHandlers: [
					[undefined, undefined],
					[undefined, undefined],
				],
				inlineLists: 0,
				badge: "3 open items below",
				preview: 0,
			},
		);
	});

	it("opens a layered preview outside the row when the Tree button is hovered", () =>
	{
		treeButton().onMouseEnter(
			{
				currentTarget: button,
			},
		);
		const [layer] = preview();
		const rowParts = rows().flatMap((row) => elements(row.props.children));
		expect(
			{
				inRow: rowParts.some((element) => element.props.className === "ladder-preview"),
				style: layer.props.style,
				role: layer.props.role,
			},
		).toStrictEqual(
			{
				inRow: false,
				style:
				{
					left: 40,
					top: 124,
				},
				role: "tooltip",
			},
		);
	});

	it("shows the subtree with its real nesting", () =>
	{
		treeButton().onFocus(
			{
				currentTarget: button,
			},
		);
		const list = elements(preview()[0].props.children).find((element) => element.type === "ul");
		if (!list)
		{
			throw new Error("no preview list");
		}
		expect(shape(list)).toStrictEqual([
			["first child", []],
			["second child", [["grandchild", []]]],
		]);
	});

	it("closes on leave, blur, and Escape", () =>
	{
		const closed = (close: () => void) =>
		{
			treeButton().onMouseEnter(
				{
					currentTarget: button,
				},
			);
			close();
			return preview().length;
		};
		expect([
			closed(() =>
			{
				treeButton().onMouseLeave({});
			}),
			closed(() =>
			{
				treeButton().onBlur({});
			}),
			closed(() =>
			{
				treeButton().onKeyDown(
					{
						key: "Escape",
					},
				);
			}),
		]).toStrictEqual([0, 0, 0]);
	});
});
