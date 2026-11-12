/** The string body a stubbed `fetch` received, or undefined when the request had none. */
export function requestBody(init?: RequestInit): string | undefined
{
	const body = init?.body;
	if (body === undefined || body === null)
	{
		return undefined;
	}
	if (typeof body !== "string")
	{
		throw new TypeError(`Expected a string request body, got ${Object.prototype.toString.call(body)}`);
	}
	return body;
}

/** The parsed JSON body a stubbed `fetch` received, or undefined when the request had none. */
export function requestJson(init?: RequestInit): unknown
{
	const body = requestBody(init);
	return body === undefined ? undefined : JSON.parse(body);
}
