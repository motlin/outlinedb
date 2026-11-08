/** One outgoing email; the sender adds the from address. */
export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
	html: string;
	headers?: Record<string, string>;
}

export interface EmailSender {
	send(message: EmailMessage): Promise<void>;
}

/** The part of the Cloudflare Email Service `send_email` binding we use. */
export interface EmailBinding {
	send(
		builder: EmailMessage & {
			from: string;
		},
	): Promise<{
		messageId: string;
	}>;
}

/** Bindings and vars that pick the sender. */
export interface EmailEnv {
	/** Var: "cloudflare" in production; "log" only in local dev and tests. */
	EMAIL_PROVIDER?: string;
	/** Var: the from address on an onboarded Email Service domain. */
	EMAIL_FROM?: string;
	/** The `send_email` binding. */
	EMAIL?: EmailBinding;
	ACCESS_DEV_IDENTITY?: string;
}

/** Sends through the Email Service binding, which throws an Error carrying a `code` on failure. */
export function cloudflareSender(binding: EmailBinding, from: string): EmailSender {
	return {
		async send(message) {
			try {
				await binding.send({
					from,
					...message,
				});
			} catch (error) {
				const code =
					error instanceof Error && "code" in error && typeof error.code === "string"
						? error.code
						: "unknown";
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(`Email send failed (${code}): ${detail}`, {
					cause: error,
				});
			}
		},
	};
}

/** Hands each message to `sink` instead of sending it; for local dev and tests only. */
export function logSender(sink: (message: EmailMessage) => void): EmailSender {
	return {
		async send(message) {
			await Promise.resolve();
			sink(message);
		},
	};
}

/** Pick the sender from `EMAIL_PROVIDER`, refusing the log sender anywhere but local dev and tests. */
export function senderFor(
	env: EmailEnv,
	options: {
		test?: boolean;
		sink?: (message: EmailMessage) => void;
	} = {},
): EmailSender {
	switch (env.EMAIL_PROVIDER) {
		case "cloudflare": {
			if (!env.EMAIL || !env.EMAIL_FROM) {
				throw new Error("EMAIL_PROVIDER=cloudflare needs the EMAIL send_email binding and EMAIL_FROM");
			}
			return cloudflareSender(env.EMAIL, env.EMAIL_FROM);
		}
		case "log": {
			if (!env.ACCESS_DEV_IDENTITY && !options.test) {
				throw new Error("EMAIL_PROVIDER=log is only allowed in local dev (ACCESS_DEV_IDENTITY) or tests");
			}
			return logSender(
				options.sink ??
					((message) => {
						console.log("email (not sent)", message);
					}),
			);
		}
		case undefined:
		default: {
			throw new Error(`Unknown EMAIL_PROVIDER: ${env.EMAIL_PROVIDER ?? "(unset)"}`);
		}
	}
}
