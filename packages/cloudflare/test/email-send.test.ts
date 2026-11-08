import {describe, expect, it} from "vite-plus/test";
import {cloudflareSender, logSender, senderFor} from "../src/email/send";
import type {EmailBinding, EmailMessage} from "../src/email/send";

const message: EmailMessage = {
	to: "alice@example.com",
	subject: "Verify your email",
	text: "Click the link",
	html: "<p>Click the link</p>",
	headers: {
		"X-Entity-Ref-ID": "abc",
	},
};

function fakeBinding(): {
	binding: EmailBinding;
	sent: unknown[];
} {
	const sent: unknown[] = [];
	return {
		sent,
		binding: {
			send: async (builder) => {
				await Promise.resolve();
				sent.push(builder);
				return {
					messageId: "msg-1",
				};
			},
		},
	};
}

describe("cloudflareSender", () => {
	it("hands the exact message, with the from address, to the send_email binding", async () => {
		const {binding, sent} = fakeBinding();
		await cloudflareSender(binding, "no-reply@outlinedb.com").send(message);
		expect(sent).toStrictEqual([
			{
				from: "no-reply@outlinedb.com",
				to: "alice@example.com",
				subject: "Verify your email",
				text: "Click the link",
				html: "<p>Click the link</p>",
				headers: {
					"X-Entity-Ref-ID": "abc",
				},
			},
		]);
	});

	it("omits headers when the message has none", async () => {
		const {binding, sent} = fakeBinding();
		await cloudflareSender(binding, "no-reply@outlinedb.com").send({
			to: "bob@example.com",
			subject: "Hi",
			text: "t",
			html: "h",
		});
		expect(sent).toStrictEqual([
			{
				from: "no-reply@outlinedb.com",
				to: "bob@example.com",
				subject: "Hi",
				text: "t",
				html: "h",
			},
		]);
	});

	it("throws with the binding's error code when the send fails", async () => {
		const binding: EmailBinding = {
			send: async () => {
				await Promise.resolve();
				throw Object.assign(new Error("Domain not available for sending"), {
					code: "E_SENDER_DOMAIN_NOT_AVAILABLE",
				});
			},
		};
		await expect(cloudflareSender(binding, "no-reply@outlinedb.com").send(message)).rejects.toThrow(
			"Email send failed (E_SENDER_DOMAIN_NOT_AVAILABLE): Domain not available for sending",
		);
	});
});

describe("logSender", () => {
	it("writes the message to the sink instead of sending it", async () => {
		const lines: EmailMessage[] = [];
		await logSender((sent) => {
			lines.push(sent);
		}).send(message);
		expect(lines).toStrictEqual([message]);
	});
});

describe("senderFor", () => {
	const {binding} = fakeBinding();

	it("uses the binding when EMAIL_PROVIDER is cloudflare", async () => {
		const {binding: tracked, sent} = fakeBinding();
		await senderFor({
			EMAIL_PROVIDER: "cloudflare",
			EMAIL_FROM: "no-reply@outlinedb.com",
			EMAIL: tracked,
		}).send(message);
		expect(sent).toHaveLength(1);
	});

	it("refuses cloudflare without a binding or a from address", () => {
		expect(() =>
			senderFor({
				EMAIL_PROVIDER: "cloudflare",
				EMAIL_FROM: "no-reply@outlinedb.com",
			}),
		).toThrow("EMAIL_PROVIDER=cloudflare needs the EMAIL send_email binding and EMAIL_FROM");
		expect(() =>
			senderFor({
				EMAIL_PROVIDER: "cloudflare",
				EMAIL: binding,
			}),
		).toThrow("EMAIL_PROVIDER=cloudflare needs the EMAIL send_email binding and EMAIL_FROM");
	});

	it("refuses log outside local dev and tests", () => {
		expect(() =>
			senderFor({
				EMAIL_PROVIDER: "log",
				EMAIL: binding,
			}),
		).toThrow("EMAIL_PROVIDER=log is only allowed in local dev (ACCESS_DEV_IDENTITY) or tests");
	});

	it("allows log in local dev", async () => {
		const lines: EmailMessage[] = [];
		await senderFor(
			{
				EMAIL_PROVIDER: "log",
				ACCESS_DEV_IDENTITY: "dev",
			},
			{
				sink: (sent) => {
					lines.push(sent);
				},
			},
		).send(message);
		expect(lines).toStrictEqual([message]);
	});

	it("allows log in tests", async () => {
		const lines: EmailMessage[] = [];
		await senderFor(
			{
				EMAIL_PROVIDER: "log",
			},
			{
				test: true,
				sink: (sent) => {
					lines.push(sent);
				},
			},
		).send(message);
		expect(lines).toStrictEqual([message]);
	});

	it("refuses an unknown or missing provider", () => {
		expect(() =>
			senderFor({
				EMAIL_PROVIDER: "resend",
			}),
		).toThrow("Unknown EMAIL_PROVIDER: resend");
		expect(() => senderFor({})).toThrow("Unknown EMAIL_PROVIDER: (unset)");
	});
});
