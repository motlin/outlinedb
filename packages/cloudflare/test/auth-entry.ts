import type {EmailBinding} from "../src/email/send";
import worker from "../src/worker";

export {UserStore} from "../src/worker";
export {ProbeStore} from "./probe-entry";

/** Every message the Worker handed to the `EMAIL` binding, oldest first, until `/__emails` drains it. */
const sent: unknown[] = [];

const recordingBinding: EmailBinding =
{
	async send(builder)
	{
		await Promise.resolve();
		sent.push(builder);
		return {
			messageId: `test-${sent.length}`,
		};
	},
};

/** Test-only entry: the real Worker with a recording `send_email` binding, plus `GET /__emails` to drain what it sent. */
export default
{
	async fetch(request, env, ctx)
	{
		if (new URL(request.url).pathname === "/__emails")
		{
			return Response.json(sent.splice(0));
		}
		return worker.fetch(
			request,
			{
				...env,
				EMAIL: recordingBinding,
			},
			ctx,
		);
	},
} satisfies ExportedHandler<Parameters<typeof worker.fetch>[1]>;
