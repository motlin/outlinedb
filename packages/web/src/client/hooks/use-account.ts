import {useQuery} from "@tanstack/react-query";
import type {AccountAiResponse, AccountResponse} from "../../node-types.js";
import type {MentionAccount} from "../mention-pills.js";
import {readJson} from "../read-json.js";

export const accountKeys = {all: ["account"] as const};

/** Settings `ai.assistants` names by system user id (upstream's participant names); empty when unavailable. */
async function fetchAssistantNames(fetcher: typeof fetch): Promise<Record<string, string>> {
	const response = await fetcher("/api/v1/account/ai");
	if (!response.ok) {
		return {};
	}
	const {assistants} = await readJson<AccountAiResponse>(response);
	return Object.fromEntries(
		assistants.flatMap(({systemUserId, name}) =>
			systemUserId === null || name === null ? [] : [[String(systemUserId), name]],
		),
	);
}

/** The account's id, name, join date and AI assistant names, or null when the account is unavailable. */
export async function fetchMentionAccount(fetcher: typeof fetch): Promise<MentionAccount> {
	const [response, assistantNames] = await Promise.all([fetcher("/api/v1/account"), fetchAssistantNames(fetcher)]);
	if (!response.ok) {
		return null;
	}
	const {userId, fullName, joinedAt} = await readJson<AccountResponse>(response);
	return {userId, fullName, joinedAt, assistantNames};
}

/** The signed-in account's id, full name and AI assistant names, which resolve stored `<mention>` ids to names; null until loaded or unavailable. */
export function useAccount(): MentionAccount {
	const {data} = useQuery({
		queryKey: accountKeys.all,
		staleTime: Infinity,
		retry: false,
		queryFn: async (): Promise<MentionAccount> => fetchMentionAccount(fetch),
	});
	return data ?? null;
}
