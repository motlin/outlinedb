import {beforeAll, describe, expect, it} from "vite-plus/test";
import {SignJWT, createLocalJWKSet, exportJWK, generateKeyPair} from "jose";
import type {JWTVerifyGetKey} from "jose";
import {resolveIdentity} from "../src/access";
import type {AccessEnv} from "../src/access";

const issuer = "https://team.example.com";
const env: AccessEnv =
{
	ACCESS_TEAM_DOMAIN: "team.example.com",
	ACCESS_AUD: "aud-123",
	ALLOWED_EMAILS: "Alice@example.com, bob@example.com",
	ALLOWED_SERVICE_TOKENS: "client-1.access=Alice@example.com, client-2.access = bob@example.com",
};

describe("resolveIdentity", () =>
{
	let privateKey: CryptoKey;
	let otherKey: CryptoKey;
	let keys: JWTVerifyGetKey;

	beforeAll(async () =>
	{
		const pair = await generateKeyPair("RS256");
		privateKey = pair.privateKey;
		otherKey = (await generateKeyPair("RS256")).privateKey;
		keys = createLocalJWKSet(
			{
				keys: [
					{
						...(await exportJWK(pair.publicKey)),
						alg: "RS256",
						use: "sig",
					},
				],
			},
		);
	});

	async function token(
		claims:
		{
			email?: string;
			common_name?: string;
		},
		options:
		{
			aud?: string;
			iss?: string;
			exp?: string | number;
			key?: CryptoKey;
		} = {},
	): Promise<string>
	{
		return new SignJWT(claims)
			.setProtectedHeader(
				{
					alg: "RS256",
				},
			)
			.setAudience(options.aud ?? env.ACCESS_AUD ?? "")
			.setIssuer(options.iss ?? issuer)
			.setIssuedAt()
			.setExpirationTime(options.exp ?? "1h")
			.sign(options.key ?? privateKey);
	}

	const request = (jwt?: string) =>
		new Request(
			"http://localhost/api/v1/nodes",
			jwt
				?
					{
						headers:
						{
							"Cf-Access-Jwt-Assertion": jwt,
						},
					}
				: {},
		);

	it("returns 401 when the header is missing", async () =>
	{
		await expect(resolveIdentity(request(), env, keys)).resolves.toStrictEqual(
			{
				status: 401,
			},
		);
	});

	it("returns 403 for a bad signature", async () =>
	{
		const jwt = await token(
			{
				email: "bob@example.com",
			},
			{
				key: otherKey,
			},
		);
		await expect(resolveIdentity(request(jwt), env, keys)).resolves.toStrictEqual(
			{
				status: 403,
			},
		);
	});

	it("returns 403 for the wrong audience", async () =>
	{
		const jwt = await token(
			{
				email: "bob@example.com",
			},
			{
				aud: "other",
			},
		);
		await expect(resolveIdentity(request(jwt), env, keys)).resolves.toStrictEqual(
			{
				status: 403,
			},
		);
	});

	it("returns 403 for the wrong issuer", async () =>
	{
		const jwt = await token(
			{
				email: "bob@example.com",
			},
			{
				iss: "https://evil.example.com",
			},
		);
		await expect(resolveIdentity(request(jwt), env, keys)).resolves.toStrictEqual(
			{
				status: 403,
			},
		);
	});

	it("returns 403 for an expired token", async () =>
	{
		const jwt = await token(
			{
				email: "bob@example.com",
			},
			{
				exp: Math.floor(Date.now() / 1000) - 3600,
			},
		);
		await expect(resolveIdentity(request(jwt), env, keys)).resolves.toStrictEqual(
			{
				status: 403,
			},
		);
	});

	it("returns 403 for an email outside the allowlist", async () =>
	{
		const jwt = await token(
			{
				email: "mallory@example.com",
			},
		);
		await expect(resolveIdentity(request(jwt), env, keys)).resolves.toStrictEqual(
			{
				status: 403,
			},
		);
	});

	it("returns 403 when the token has no email claim", async () =>
	{
		const jwt = await token({});
		await expect(resolveIdentity(request(jwt), env, keys)).resolves.toStrictEqual(
			{
				status: 403,
			},
		);
	});

	it("accepts a valid token and lowercases the email", async () =>
	{
		const jwt = await token(
			{
				email: "ALICE@example.com",
			},
		);
		await expect(resolveIdentity(request(jwt), env, keys)).resolves.toStrictEqual(
			{
				email: "alice@example.com",
			},
		);
	});

	it("ignores the dev bypass when the var is unset", async () =>
	{
		await expect(
			resolveIdentity(
				request(),
				{
					...env,
					ACCESS_DEV_IDENTITY: undefined,
				},
				keys,
			),
		).resolves.toStrictEqual(
			{
				status: 401,
			},
		);
		await expect(
			resolveIdentity(
				request(),
				{
					...env,
					ACCESS_DEV_IDENTITY: "",
				},
				keys,
			),
		).resolves.toStrictEqual(
			{
				status: 401,
			},
		);
	});

	it("uses the dev identity without a token when the var is set", async () =>
	{
		await expect(
			resolveIdentity(
				request(),
				{
					ACCESS_DEV_IDENTITY: "dev",
				},
				keys,
			),
		).resolves.toStrictEqual(
			{
				email: "dev",
			},
		);
	});

	it("fails closed when Access is not configured", async () =>
	{
		const jwt = await token(
			{
				email: "bob@example.com",
			},
		);
		await expect(resolveIdentity(request(jwt), {}, keys)).resolves.toStrictEqual(
			{
				status: 403,
			},
		);
	});

	describe("service tokens", () =>
	{
		it("maps an allowlisted client id to its lowercased identity", async () =>
		{
			const jwt = await token(
				{
					common_name: "client-1.access",
				},
			);
			await expect(resolveIdentity(request(jwt), env, keys)).resolves.toStrictEqual(
				{
					email: "alice@example.com",
				},
			);
			const second = await token(
				{
					common_name: "client-2.access",
				},
			);
			await expect(resolveIdentity(request(second), env, keys)).resolves.toStrictEqual(
				{
					email: "bob@example.com",
				},
			);
		});

		it("returns 403 for an unmapped client id", async () =>
		{
			const jwt = await token(
				{
					common_name: "client-9.access",
				},
			);
			await expect(resolveIdentity(request(jwt), env, keys)).resolves.toStrictEqual(
				{
					status: 403,
				},
			);
		});

		it("returns 403 when no service tokens are configured", async () =>
		{
			const jwt = await token(
				{
					common_name: "client-1.access",
				},
			);
			await expect(
				resolveIdentity(
					request(jwt),
					{
						...env,
						ALLOWED_SERVICE_TOKENS: "",
					},
					keys,
				),
			).resolves.toStrictEqual(
				{
					status: 403,
				},
			);
			await expect(
				resolveIdentity(
					request(jwt),
					{
						...env,
						ALLOWED_SERVICE_TOKENS: undefined,
					},
					keys,
				),
			).resolves.toStrictEqual(
				{
					status: 403,
				},
			);
		});

		it("returns 403 for a bad signature even when the client id is mapped", async () =>
		{
			const jwt = await token(
				{
					common_name: "client-1.access",
				},
				{
					key: otherKey,
				},
			);
			await expect(resolveIdentity(request(jwt), env, keys)).resolves.toStrictEqual(
				{
					status: 403,
				},
			);
		});
	});
});
