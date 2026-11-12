import {describe, expect, it} from "vite-plus/test";
import {WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";

describe("WorkflowyInternalClient.signedFileUrl", () =>
{
	it("GETs the file-proxy path with the session cookie and returns the signed url", async () =>
	{
		const seen:
		{
			url: string;
			cookie: string | undefined;
		}[] = [];
		const fetchStub: typeof fetch = async (input, init) =>
		{
			seen.push(
				{
					url: typeof input === "string" ? input : "",
					cookie: new Headers(init?.headers).get("cookie") ?? undefined,
				},
			);
			return Promise.resolve(
				Response.json(
					{
						url: "https://s3.example/signed",
					},
				),
			);
		};
		const client = new WorkflowyInternalClient(
			{
				sessionStore:
				{
					read: () => "sessionid=abc",
					write: () =>
					{
					},
					clear: () =>
					{
					},
				},
				fetch: fetchStub,
				baseUrl: "https://workflowy.test",
			},
		);

		const url = await client.signedFileUrl("/file-proxy/signed-original/7/n1/?attempt=1");

		expect(
			{
				url,
				seen,
			},
		).toStrictEqual(
			{
				url: "https://s3.example/signed",
				seen: [
					{
						url: "https://workflowy.test/file-proxy/signed-original/7/n1/?attempt=1",
						cookie: "sessionid=abc",
					},
				],
			},
		);
	});
});
