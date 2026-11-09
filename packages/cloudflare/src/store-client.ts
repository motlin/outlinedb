import type {OpInput, OpName, OpOutput, OpResult, StoreClient} from "@outlinedb/web/server-app";
import type {UserStore} from "./user-store";

/**
 * Wraps a Durable Object stub as a {@link StoreClient}. The RPC stub types are mapped types that erase `call`'s generic,
 * so this is the one place that restores it.
 */
export function storeClient(stub: DurableObjectStub<UserStore>): StoreClient {
	return {
		async call<K extends OpName>(op: K, input: OpInput<K>): Promise<OpResult<OpOutput<K>>> {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stub's mapped type loses the op-to-result link
			const call = stub.call as unknown as StoreClient["call"];
			return call<K>(op, input);
		},
	};
}
