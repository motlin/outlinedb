import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {cookiesFrom, drainEmails, linkIn, origin, post, startAuthHarness, turnstile} from "./auth-harness";
import type {AuthHarness} from "./auth-harness";
import {authDb, countStoreCalls} from "./harness";
import type {UserStore} from "../src/user-store";

const bindings = {
	BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
	SIGNUP_MODE: "invite",
	SIGNUP_INVITES: "owner@example.com, sam@example.com, uma@example.com, rita@example.com, lou@example.com",
	TURNSTILE_SECRET_KEY: turnstile.passSecret,
	TURNSTILE_SITE_KEY: turnstile.siteKey,
	OUTLINEDB_ENV_OWNERS: "Owner@example.com",
};
const password = "correct horse battery staple";

/** A copy in this realm: objects from Miniflare's RPC carry another realm's prototypes, which strict equality rejects. */
function plain(value: unknown): unknown {
	// oxlint-disable-next-line unicorn/prefer-structured-clone -- structuredClone keeps the other realm's prototypes
	return JSON.parse(JSON.stringify(value));
}

async function stubNamed(h: AuthHarness, name: string): Promise<DurableObjectStub<UserStore>> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace<UserStore>;
	return ns.get(ns.idFromName(name));
}

/** How many `provision` RPCs the Durable Object named `name` has received. */
async function provisions(h: AuthHarness, name: string): Promise<number> {
	const response = await (await stubNamed(h, name)).fetch("http://localhost/__provisions");
	const body: {provisions: number} = await response.json();
	return body.provisions;
}

/** Sign up an invited email from its own client IP and return its user id and verification link, unopened. */
async function signUpUnverified(h: AuthHarness, email: string): Promise<{userId: string; link: string}> {
	const signup = await post(
		h,
		"/sign-up/email",
		{email, password, name: email},
		{"cf-connecting-ip": `198.51.100.${email.length}`},
	);
	expect(signup.status).toBe(200);
	const [verification] = await drainEmails(h);
	if (!verification) {
		throw new Error(`No verification email for ${email}`);
	}
	const row = await (
		await authDb(h.mf)
	)
		.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email)
		.first<{id: string}>();
	if (!row) {
		throw new Error(`No user row for ${email}`);
	}
	return {userId: row.id, link: linkIn(verification)};
}

async function provisionedAt(h: AuthHarness, userId: string): Promise<string | null> {
	const row = await (
		await authDb(h.mf)
	)
		.prepare('SELECT provisioned_at FROM "user" WHERE id = ?')
		.bind(userId)
		.first<{provisioned_at: string | null}>();
	return row?.provisioned_at ?? null;
}

async function verify(h: AuthHarness, link: string): Promise<string> {
	const verified = await h.mf.dispatchFetch(`${origin}${link}`, {redirect: "manual"});
	return cookiesFrom(verified);
}

describe("a verified email provisions its user's Durable Object exactly once", () => {
	let h: AuthHarness;

	beforeAll(async () => {
		h = await startAuthHarness(bindings, {className: "ProbeStore"});
	}, 120_000);

	afterAll(async () => {
		await h.dispose();
	});

	it("never provisions an unverified user", async () => {
		const uma = await signUpUnverified(h, "uma@example.com");
		await expect(Promise.all([provisions(h, uma.userId), provisionedAt(h, uma.userId)])).resolves.toStrictEqual([
			0,
			null,
		]);
	});

	it("provisions on verification, an owner email in mirror mode and any other standalone, and keeps it across a restart", async () => {
		const owner = await signUpUnverified(h, "owner@example.com");
		const sam = await signUpUnverified(h, "sam@example.com");
		await verify(h, owner.link);
		await verify(h, sam.link);

		const flags = await Promise.all([provisionedAt(h, owner.userId), provisionedAt(h, sam.userId)]);
		expect(flags.map((flag) => flag !== null)).toStrictEqual([true, true]);
		await expect(Promise.all([provisions(h, owner.userId), provisions(h, sam.userId)])).resolves.toStrictEqual([
			1, 1,
		]);

		const restarted = await startAuthHarness(bindings, {className: "ProbeStore", persistDir: h.persistDir});
		await h.dispose(true);
		h = restarted;
		const statuses = await Promise.all(
			[owner, sam].map(async ({userId}) => {
				const status = await (await stubNamed(h, userId)).adminStatus();
				return plain({storeName: status.storeName, mode: status.mode, profile: status.profile});
			}),
		);
		expect(statuses).toStrictEqual([
			{
				storeName: owner.userId,
				mode: "mirror",
				profile: {userId: owner.userId, email: "owner@example.com", mode: "mirror"},
			},
			{
				storeName: sam.userId,
				mode: "standalone",
				profile: {userId: sam.userId, email: "sam@example.com", mode: "standalone"},
			},
		]);
	});

	it("does not re-provision when the verification link is replayed", async () => {
		const rita = await signUpUnverified(h, "rita@example.com");
		await verify(h, rita.link);
		const first = await provisionedAt(h, rita.userId);
		await verify(h, rita.link);
		await expect(Promise.all([provisions(h, rita.userId), provisionedAt(h, rita.userId)])).resolves.toStrictEqual([
			1,
			first,
		]);
	});

	it("provisions lazily on the first request when the D1 flag is unset, with one extra RPC only that once", async () => {
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

		const request = async () => h.mf.dispatchFetch(`${origin}/api/v1/nodes`, {headers: {cookie}});
		const calls = [await countStoreCalls(h.mf, lou.userId, request)];
		const afterFirst = [await provisions(h, lou.userId), (await provisionedAt(h, lou.userId)) !== null];
		calls.push(await countStoreCalls(h.mf, lou.userId, request));

		expect({calls, afterFirst, afterSecond: await provisions(h, lou.userId)}).toStrictEqual({
			calls: [1, 1],
			afterFirst: [2, true],
			afterSecond: 2,
		});
	});
});

describe("UserStore.provision", () => {
	let h: AuthHarness;

	beforeAll(async () => {
		h = await startAuthHarness(bindings, {className: "ProbeStore"});
	}, 120_000);

	afterAll(async () => {
		await h.dispose();
	});

	it("is a no-op for the same user and refuses another user with 409", async () => {
		const stub = await stubNamed(h, "user-a");
		const input = {userId: "user-a", email: "a@example.com", mode: "standalone"} as const;
		const results = [
			await stub.provision(input),
			await stub.provision({...input, email: "changed@example.com", mode: "mirror"}),
			await stub.provision({userId: "user-b", email: "b@example.com", mode: "standalone"}),
		];
		const profile = {userId: "user-a", email: "a@example.com", mode: "standalone"};
		expect(plain(results)).toStrictEqual([
			{ok: true, created: true, profile},
			{ok: true, created: false, profile},
			{ok: false, status: 409, error: "store-provisioned-for-another-user"},
		]);
		expect(plain((await stub.adminStatus()).mode)).toBe("standalone");
	});

	it("switches a fresh object to mirror mode when provisioned as one", async () => {
		const stub = await stubNamed(h, "user-m");
		const before = (await stub.adminStatus()).mode;
		await stub.provision({userId: "user-m", email: "m@example.com", mode: "mirror"});
		expect([before, (await stub.adminStatus()).mode]).toStrictEqual(["standalone", "mirror"]);
	});
});
