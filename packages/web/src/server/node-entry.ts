// The Node host's composition root for other Node processes (the stdio MCP server): a context over the local
// better-sqlite3 file and environment, and the in-process store that runs ops against it.
export {createServerContext} from "./node-context.js";
export {inProcessStore} from "./store.js";
export type {StoreClient} from "./store.js";
export type {OpName, OpInput, OpOutput} from "./ops/index.js";
export type {OpResult} from "./ops/define.js";
