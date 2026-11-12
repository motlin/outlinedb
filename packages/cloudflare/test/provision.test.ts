import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {cookiesFrom, drainEmails, linkIn, origin, post, signUp, startAuthHarness, turnstile} from "./auth-harness";
import type {AuthHarness} from "./auth-harness";
import {authDb, countStoreCalls} from "./harness";
import {storeClient} from "../src/store-client";
import type {UserStore} from "../src/user-store";

const bindings =
{
	BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
	SIGNUP_MODE: "invite",
	SIGNUP_INVITES:
		"owner@example.com, sam@example.com, uma@example.com, rita@example.com, lou@example.com, tia@example.com",
	TURNSTILE_SECRET_KEY: turnstile.passSecret,
	TURNSTILE_SITE_KEY: turnstile.siteKey,
	OUTLINEDB_ENV_OWNERS: "Owner@example.com",
};
const password = "correct horse battery staple";

/** A copy in this realm: objects from Miniflare's RPC carry another realm's prototypes, which strict equality rejects. */
function plain(value: unknown): unknown
{
	// oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone keeps the other realm's prototypes
	return JSON.parse(JSON.stringify(value));
}

async function stubNamed(h: AuthHarness, name: string): Promise<DurableObjectStub<UserStore>>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace<UserStore>;
	return ns.get(ns.idFromName(name));
}

/** How many `provision` RPCs the Durable Object named `name` has received. */
async function provisions(h: AuthHarness, name: string): Promise<number>
{
	const response = await (await stubNamed(h, name)).fetch("http://localhost/__provisions");
	const body:
	{
		provisions: number;
	} = await response.json();
	return body.provisions;
}

/** Sign up an invited email from its own client IP and return its user id and verification link, unopened. */
async function signUpUnverified(
	h: AuthHarness,
	email: string,
): Promise<
{
	userId: string;
	link: string;
}>
{
	const signup = await post(
		h,
		"/sign-up/email",
		{
			email,
			password,
			name: email,
		},
		{
			"cf-connecting-ip": `198.51.100.${email.length}`,
		},
	);
	expect(signup.status).toBe(200);
	const [verification] = await drainEmails(h);
	if (!verification)
	{
		throw new Error(`No verification email for ${email}`);
	}
	const row = await (await authDb(h.mf)).prepare('SELECT id FROM "user" WHERE email = ?').bind(email).first<
	{
		id: string;
	}>();
	if (!row)
	{
		throw new Error(`No user row for ${email}`);
	}
	return {
		userId: row.id,
		link: linkIn(verification),
	};
}

async function provisionedAt(h: AuthHarness, userId: string): Promise<string | null>
{
	const row = await (await authDb(h.mf)).prepare('SELECT provisioned_at FROM "user" WHERE id = ?').bind(userId).first<
	{
		provisioned_at: string | null;
	}>();
	return row?.provisioned_at ?? null;
}

async function verify(h: AuthHarness, link: string): Promise<string>
{
	const verified = await h.mf.dispatchFetch(
		`${origin}${link}`,
		{
			redirect: "manual",
		},
	);
	return cookiesFrom(verified);
}

describe("a verified email provisions its user's Durable Object exactly once", () =>
{
	let h: AuthHarness;

	beforeAll(async () =>
	{
		h = await startAuthHarness(
			bindings,
			{
				className: "ProbeStore",
			},
		);
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("never provisions an unverified user", async () =>
	{
		const uma = await signUpUnverified(h, "uma@example.com");
		await expect(Promise.all([provisions(h, uma.userId), provisionedAt(h, uma.userId)])).resolves.toStrictEqual([
			0,
			null,
		]);
	});

	it("provisions on verification, an owner email in mirror mode and any other standalone, and keeps it across a restart", async () =>
	{
		const owner = await signUpUnverified(h, "owner@example.com");
		const sam = await signUpUnverified(h, "sam@example.com");
		await verify(h, owner.link);
		await verify(h, sam.link);

		const flags = await Promise.all([provisionedAt(h, owner.userId), provisionedAt(h, sam.userId)]);
		expect(flags.map((flag) => flag !== null)).toStrictEqual([true, true]);
		await expect(Promise.all([provisions(h, owner.userId), provisions(h, sam.userId)])).resolves.toStrictEqual([
			1, 1,
		]);

		const restarted = await startAuthHarness(
			bindings,
			{
				className: "ProbeStore",
				persistDir: h.persistDir,
			},
		);
		await h.dispose(true);
		h = restarted;
		const statuses = await Promise.all(
			[owner, sam].map(async ({userId}) =>
			{
				const status = await (await stubNamed(h, userId)).adminStatus();
				return plain(
					{
						storeName: status.storeName,
						mode: status.mode,
						profile: status.profile,
					},
				);
			}),
		);
		expect(statuses).toStrictEqual([
			{
				storeName: owner.userId,
				mode: "mirror",
				profile:
				{
					userId: owner.userId,
					email: "owner@example.com",
					mode: "mirror",
				},
			},
			{
				storeName: sam.userId,
				mode: "standalone",
				profile:
				{
					userId: sam.userId,
					email: "sam@example.com",
					mode: "standalone",
				},
			},
		]);
	});

	it("does not re-provision when the verification link is replayed", async () =>
	{
		const rita = await signUpUnverified(h, "rita@example.com");
		await verify(h, rita.link);
		const first = await provisionedAt(h, rita.userId);
		await verify(h, rita.link);
		await expect(Promise.all([provisions(h, rita.userId), provisionedAt(h, rita.userId)])).resolves.toStrictEqual([
			1,
			first,
		]);
	});

	it("provisions lazily on the first request when the D1 flag is unset, with one extra RPC only that once", async () =>
	{
		const lou = await signUpUnverified(h, "lou@example.com");
		const cookie = (await verify(h, lou.link))
			.split("; ")
			.filter((pair) => pair.startsWith("better-auth.session_token="))
			.join("; ");
		await (
			await authDb(h.mf)
		)
			.prepare('UPDATE "user" SET provisioned_at = NULL WHERE id = ?')
			.bind(lou.userId)
			.run();

		const request = async () =>
			h.mf.dispatchFetch(
				`${origin}/api/v1/nodes`,
				{
					headers:
					{
						cookie,
					},
				},
			);
		const calls = [await countStoreCalls(h.mf, lou.userId, request)];
		const afterFirst = [await provisions(h, lou.userId), (await provisionedAt(h, lou.userId)) !== null];
		calls.push(await countStoreCalls(h.mf, lou.userId, request));

		expect(
			{
				calls,
				afterFirst,
				afterSecond: await provisions(h, lou.userId),
			},
		).toStrictEqual(
			{
				calls: [1, 1],
				afterFirst: [2, true],
				afterSecond: 2,
			},
		);
	});
});

describe("a new standalone account types end to end through the Worker", () =>
{
	let h: AuthHarness;

	beforeAll(async () =>
	{
		h = await startAuthHarness(
			bindings,
			{
				className: "ProbeStore",
			},
		);
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	interface Row
	{
		id: string;
		name: string;
		completedAt: number | null;
	}

	it("creates, renames, indents, expands, completes and deletes, and the outline view reads it all back", async () =>
	{
		const {cookie} = await signUp(h, "tia@example.com");
		const call = async (method: string, path: string, body?: unknown): Promise<unknown> =>
		{
			const response = await h.mf.dispatchFetch(
				`${origin}/api/v1${path}`,
				{
					method,
					headers:
					{
						cookie,
						"content-type": "application/json",
					},
					...(body === undefined
						? {}
						:
							{
								body: JSON.stringify(body),
							}),
				},
			);
			const text = await response.text();
			if (!response.ok)
			{
				throw new Error(`${method} ${path}: ${response.status} ${text}`);
			}
			return text === "" ? null : JSON.parse(text);
		};
		const children = async (parentId?: string): Promise<Row[]> =>
		{
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- GET /nodes answers {nodes: NodeResponse[]}
			const {nodes} = (await call("GET", parentId === undefined ? "/nodes" : `/nodes?parent_id=${parentId}`)) as
			{
				nodes: Row[];
			};
			return nodes;
		};
		const byName = (rows: Row[], name: string): Row =>
		{
			const row = rows.find((candidate) => candidate.name === name);
			if (row === undefined)
			{
				throw new Error(`No ${name} in ${JSON.stringify(rows)}`);
			}
			return row;
		};

		const top = await children();
		const inbox = byName(top, "Inbox");
		const welcome = byName(top, "Welcome to OutlineDB");
		const tips = await children(welcome.id);
		const firstTip = tips[0];
		if (firstTip === undefined)
		{
			throw new Error("No welcome tips");
		}

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- POST /nodes answers {node: NodeResponse}
		const {node: created} = (await call(
			"POST",
			"/nodes",
			{
				parent_id: inbox.id,
				name: "first thought",
			},
		)) as
		{
			node: Row;
		};
		await call(
			"PATCH",
			`/nodes/${created.id}`,
			{
				name: "my first bullet",
			},
		);
		await call(
			"POST",
			`/nodes/${created.id}/move`,
			{
				parent_id: welcome.id,
				index: tips.length,
			},
		);
		await call(
			"PATCH",
			"/expansion",
			{
				changes:
				{
					[welcome.id]: true,
				},
			},
		);
		await call("POST", `/nodes/${created.id}/complete`);
		await call("DELETE", `/nodes/${firstTip.id}`);

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- POST /nodes/view answers OutlineViewResponse
		const view = (await call(
			"POST",
			"/nodes/view",
			{
				rootId: null,
				expandedIds: null,
				limit: 100,
				showCompleted: true,
			},
		)) as
		{
			lists:
			{
				parentId: string | null;
				nodes: Row[];
			}[];
			expandedIds: string[];
		};
		const names = new Map([...top, ...tips, created].map((row) => [row.id, row.name]));
		expect(
			{
				lists: view.lists.map((list) => (
				{
					parent: list.parentId === null ? null : names.get(list.parentId),
					nodes: list.nodes.map((node) => (
					{
						name: node.name,
						completed: node.completedAt !== null,
					})),
				})),
				expanded: view.expandedIds.map((id) => names.get(id)),
			},
		).toStrictEqual(
			{
				lists: [
					{
						parent: null,
						nodes: [
							{
								name: "Inbox",
								completed: false,
							},
							{
								name: "Welcome to OutlineDB",
								completed: false,
							},
						],
					},
					{
						parent: "Welcome to OutlineDB",
						nodes: [
							...tips.slice(1).map((tip) => (
							{
								name: tip.name,
								completed: false,
							})),
							{
								name: "my first bullet",
								completed: true,
							},
						],
					},
				],
				expanded: ["Welcome to OutlineDB"],
			},
		);
	});
});

describe("UserStore.provision", () =>
{
	let h: AuthHarness;

	beforeAll(async () =>
	{
		h = await startAuthHarness(
			bindings,
			{
				className: "ProbeStore",
			},
		);
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("is a no-op for the same user and refuses another user with 409", async () =>
	{
		const stub = await stubNamed(h, "user-a");
		const input =
		{
			userId: "user-a",
			email: "a@example.com",
			mode: "standalone",
		} as const;
		const results = [
			await stub.provision(input),
			await stub.provision(
				{
					...input,
					email: "changed@example.com",
					mode: "mirror",
				},
			),
			await stub.provision(
				{
					userId: "user-b",
					email: "b@example.com",
					mode: "standalone",
				},
			),
		];
		const profile =
		{
			userId: "user-a",
			email: "a@example.com",
			mode: "standalone",
		};
		expect(plain(results)).toStrictEqual([
			{
				ok: true,
				created: true,
				profile,
			},
			{
				ok: true,
				created: false,
				profile,
			},
			{
				ok: false,
				status: 409,
				error: "store-provisioned-for-another-user",
			},
		]);
		expect(plain((await stub.adminStatus()).mode)).toBe("standalone");
	});

	it("seeds a new standalone account with an Inbox and a collapsed welcome tutorial, once, and a mirror with nothing", async () =>
	{
		interface Seeded
		{
			name: string | null;
			children?: Seeded[];
		}
		const names = new Map<string, string | null>();
		const tree = async (stub: DurableObjectStub<UserStore>, parentId?: string): Promise<Seeded[]> =>
		{
			const result = await storeClient(stub).call(
				"nodes.list",
				parentId === undefined
					? {}
					:
						{
							parentId,
						},
			);
			if (!result.ok)
			{
				throw new Error(JSON.stringify(result.body));
			}
			return Promise.all(
				result.value.nodes.map(async (node) =>
				{
					names.set(node.id, node.name);
					const children = await tree(stub, node.id);
					return children.length === 0
						?
							{
								name: node.name,
							}
						:
							{
								name: node.name,
								children,
							};
				}),
			);
		};
		const standalone = await stubNamed(h, "user-s");
		await standalone.provision(
			{
				userId: "user-s",
				email: "s@example.com",
				mode: "standalone",
			},
		);
		await standalone.provision(
			{
				userId: "user-s",
				email: "s@example.com",
				mode: "standalone",
			},
		);
		const seeded = await tree(standalone);
		const expansion = await storeClient(standalone).call("expansion.get", {});
		if (!expansion.ok)
		{
			throw new Error(JSON.stringify(expansion.body));
		}

		const mirror = await stubNamed(h, "user-n");
		await mirror.provision(
			{
				userId: "user-n",
				email: "n@example.com",
				mode: "mirror",
			},
		);

		const leaves = (...leafNames: string[]): Seeded[] =>
			leafNames.map((name) => (
			{
				name,
			}));
		expect(
			{
				seeded,
				expanded: expansion.value.expandedIds?.map((id) => names.get(id)),
				mirror: await tree(mirror),
			},
		).toStrictEqual(
			{
				seeded: [
					{
						name: "Inbox",
					},
					{
						name: "Welcome to OutlineDB",
						children: [
							{
								name: "👀 Start here: click this bullet",
								children: [
									{
										name: "Every bullet can hold more bullets, as deep as you like",
										children: [
											{
												name: "Click the dot at the left of this line to open it on its own page",
												children: [
													{
														name: "Keep going, this one opens too",
														children: leaves(
															"The breadcrumbs at the top take you back out",
														),
													},
												],
											},
										],
									},
									{
										name: "Click the arrow beside a bullet to show or hide what is inside it",
										children: leaves("Try hiding the first bullet on this page"),
									},
									{
										name: "Drag a bullet by its dot to move it",
										children: leaves("Move me below the next bullet", "Drop it under this one"),
									},
									{
										name: "Press Enter at the end of a bullet to start a new one",
									},
									{
										name: "Press Tab to indent a bullet and Shift+Tab to outdent it",
									},
									{
										name: "Hover over a bullet's dot to open its menu and see what else it can do",
									},
									{
										name: "That's the basics. Click Home at the top to go back and find more tips",
									},
								],
							},
							{
								name: "🚀 More tips",
								children: [
									{
										name: "🏷️ Tags and completing",
										children: [
											{
												name: "Type a #tag anywhere, like #example, then click it to see everything tagged with it",
											},
											{
												name: "Use @mentions the same way for people",
											},
											{
												name: "Press Ctrl+Enter (Cmd+Enter on a Mac) to complete a bullet",
												children: leaves(
													"Try completing this one, then press it again to bring it back",
												),
											},
											{
												name: "Press Shift+Enter to add a note below a bullet's text",
											},
										],
									},
									{
										name: "⌨️ Keyboard",
										children: [
											{
												name: "Ctrl+Down shows a bullet's children and Ctrl+Up hides them (Cmd on a Mac)",
											},
											{
												name: "Alt+Shift+Up and Down move a bullet (Cmd+Shift on a Mac)",
												children: leaves("Move me around"),
											},
											{
												name: "Ctrl+Z undoes your last change (Cmd+Z on a Mac)",
											},
										],
									},
									{
										name: "🧭 Search and jumping",
										children: leaves(
											"Press Ctrl+K (Cmd+K on a Mac) to jump to any bullet by name",
											"Type in the search box to filter the whole outline",
											"Press Ctrl+Shift+8 (Cmd+Shift+8 on a Mac) to star the page you are on and keep it in the sidebar",
										),
									},
									{
										name: "🪄 Boards",
										children: [
											{
												name: "Turn a bullet into a board from its menu, and its children become columns",
											},
											{
												name: "Try it on this bullet",
												children: leaves("To do", "Doing", "Done"),
											},
										],
									},
									{
										name: "🔗 Links",
										children: leaves(
											"Type [[ and pick a bullet to link to it",
											"Paste a web address and it becomes a link",
										),
									},
								],
							},
							{
								name: "Put quick thoughts in the Inbox and sort them later. Delete this welcome whenever you like",
							},
						],
					},
				],
				expanded: ["Welcome to OutlineDB"],
				mirror: [],
			},
		);
	});

	it("switches a fresh object to mirror mode when provisioned as one", async () =>
	{
		const stub = await stubNamed(h, "user-m");
		const before = (await stub.adminStatus()).mode;
		await stub.provision(
			{
				userId: "user-m",
				email: "m@example.com",
				mode: "mirror",
			},
		);
		expect([before, (await stub.adminStatus()).mode]).toStrictEqual(["standalone", "mirror"]);
	});
});
