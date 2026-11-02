import {vi, afterEach, describe, expect, it} from "vite-plus/test";
import {WorkflowyApiClient} from "../src/api/workflowy-client.js";

/**
 * A 403 from Workflowy's abuse protection carries the only text that explains
 * the block -- the support address, the blocked IP, and the reference code.
 * Reporting just the status code strands the caller with "403" and no way to
 * tell an IP block apart from a bad key, an expired token, or a quota.
 */

const ABUSE_BODY =
	"Access denied. Please reach out to our support team at help@workflowy.com\n" +
	"and include your IP address (100.8.164.75) and code WFB(3) so we can help resolve this.";

function clientRespondingWith(status: number, statusText: string, body: string)
{
	const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
		new Response(
			body,
			{
				status,
				statusText,
				headers:
				{
					"Content-Type": "text/plain",
				},
			},
		),
	);
	vi.stubGlobal("fetch", fetchMock);
	// A single retry attempt with no delay keeps the test fast; the retry path is
	// not what is under test here.
	return new WorkflowyApiClient(
		"test-key",
		undefined,
		"https://workflowy.test",
		{
			maxRetries: 0,
			baseDelayMs: 0,
			maxDelayMs: 0,
		},
	);
}

describe("WorkflowyApiClient error reporting", () =>
{
	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	it("includes the response body when a write is refused", async () =>
	{
		const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

		await expect(
			client.createNode(
				{
					parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
					name: "probe",
				},
			),
		).rejects.toThrow(/help@workflowy\.com/u);
	});

	it("names the blocked IP and support code so the block is actionable", async () =>
	{
		const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

		await expect(
			client.createNode(
				{
					parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
					name: "probe",
				},
			),
		).rejects.toThrow(/100\.8\.164\.75.*WFB\(3\)/su);
	});

	it("still reports the status code alongside the body", async () =>
	{
		const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

		await expect(
			client.createNode(
				{
					parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
					name: "probe",
				},
			),
		).rejects.toThrow(/403/u);
	});

	it("falls back to the status line when the body is empty", async () =>
	{
		const client = clientRespondingWith(500, "Internal Server Error", "");

		await expect(
			client.createNode(
				{
					parent_id: "10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
					name: "probe",
				},
			),
		).rejects.toThrow(/Failed to create node: 500 Internal Server Error/u);
	});

	it("reports the body on a refused move, not only on create", async () =>
	{
		const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

		await expect(
			client.moveNode("10e2d6c2-d165-b390-9484-d4fdbf4c4afa", "a71aed23-b0cc-0000-0000-000000000000"),
		).rejects.toThrow(/help@workflowy\.com/u);
	});

	it("reports the body on a refused update", async () =>
	{
		const client = clientRespondingWith(403, "Forbidden", ABUSE_BODY);

		await expect(
			client.updateNode(
				"10e2d6c2-d165-b390-9484-d4fdbf4c4afa",
				{
					name: "x",
				},
			),
		).rejects.toThrow(/help@workflowy\.com/u);
	});
});
