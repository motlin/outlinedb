/** HKDF's `info`: names what the derived key is for, so the same secret never yields this key for another purpose. */
const KEY_INFO = new TextEncoder().encode("outlinedb workflowy.com session v1");
/** AES-GCM's recommended 96-bit nonce. */
const IV_BYTES = 12;

/** A secret sealed with AES-GCM: the random nonce and the ciphertext with its authentication tag. */
export interface SealedSecret
{
	iv: Uint8Array<ArrayBuffer>;
	ciphertext: Uint8Array<ArrayBuffer>;
}

/**
 * The AES-GCM key that seals one Durable Object's Workflowy session: HKDF-SHA-256 over the Worker secret
 * `OUTLINEDB_CREDENTIALS_KEY`, salted with the object's id. Each object gets its own key, so one object's stored row
 * never decrypts under another's, and the database alone (without the Worker secret) decrypts nothing.
 */
export async function deriveCredentialsKey(secret: string, objectId: string): Promise<CryptoKey>
{
	const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, [
		"deriveKey",
	]);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new TextEncoder().encode(objectId),
			info: KEY_INFO,
		},
		material,
		{
			name: "AES-GCM",
			length: 256,
		},
		false,
		["encrypt", "decrypt"],
	);
}

/** Seal `plaintext` under `key` with a fresh random nonce. */
export async function sealSecret(key: CryptoKey, plaintext: string): Promise<SealedSecret>
{
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv,
		},
		key,
		new TextEncoder().encode(plaintext),
	);
	return {
		iv,
		ciphertext: new Uint8Array(ciphertext),
	};
}

/** Open a {@link SealedSecret}; throws when `key` is not the one that sealed it or the bytes were altered. */
export async function openSecret(key: CryptoKey, sealed: SealedSecret): Promise<string>
{
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: sealed.iv,
		},
		key,
		sealed.ciphertext,
	);
	return new TextDecoder().decode(plaintext);
}
