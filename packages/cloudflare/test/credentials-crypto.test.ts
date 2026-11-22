import {describe, expect, it} from "vite-plus/test";
import {deriveCredentialsKey, openSecret, sealSecret} from "../src/credentials-crypto";

describe("credentials crypto", () =>
{
	it("opens what it sealed under the same secret and object id, and nothing else", async () =>
	{
		const key = await deriveCredentialsKey("worker-secret", "object-a");
		const sealed = await sealSecret(key, "sessionid=abc");
		const again = await sealSecret(key, "sessionid=abc");

		const outcomes = await Promise.all(
			[
				deriveCredentialsKey("worker-secret", "object-a"),
				deriveCredentialsKey("worker-secret", "object-b"),
				deriveCredentialsKey("other-secret", "object-a"),
			].map(async (candidate) => openSecret(await candidate, sealed).catch(() => "rejected")),
		);
		expect(
			{
				outcomes,
				ivBytes: sealed.iv.length,
				// AES-GCM's 16-byte tag follows the 13 bytes of plaintext.
				ciphertextBytes: sealed.ciphertext.length,
				plaintextVisible: new TextDecoder().decode(sealed.ciphertext).includes("sessionid"),
				freshNonce: !Buffer.from(again.iv).equals(Buffer.from(sealed.iv)),
			},
		).toStrictEqual(
			{
				outcomes: ["sessionid=abc", "rejected", "rejected"],
				ivBytes: 12,
				ciphertextBytes: 29,
				plaintextVisible: false,
				freshNonce: true,
			},
		);
	});
});
