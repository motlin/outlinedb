import * as readline from "node:readline/promises";
import {Writable} from "node:stream";

/**
 * Ask one question on the terminal and resolve with the line typed. A `masked` answer (a password) is not echoed: the
 * prompt shows, then every key typed goes unprinted until Enter.
 */
export async function ask(question: string, masked: boolean): Promise<string>
{
	let muted = false;
	const output = new Writable(
		{
			write(chunk: Buffer | string, _encoding, callback)
			{
				if (!muted)
				{
					process.stdout.write(chunk);
				}
				callback();
			},
		},
	);
	const rl = readline.createInterface(
		{
			input: process.stdin,
			output,
			terminal: process.stdin.isTTY,
		},
	);
	try
	{
		const answer = rl.question(question);
		muted = masked;
		const line = await answer;
		if (masked)
		{
			process.stdout.write("\n");
		}
		return line;
	}
	finally
	{
		rl.close();
	}
}
