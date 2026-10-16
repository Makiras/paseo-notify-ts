import type { Config } from "../shared/config";
import type { PaseoApi } from "./types";

// Use exact lookups, not a paginated/filtered directory. Any lookup error aborts
// cleanup. The caller commits the resulting settings through Paseo's revision CAS.
export async function prepareSessionConfigCleanup(
  paseo: PaseoApi,
  ids: string[],
  read: () => Promise<{ status: string; revision: string; values?: Config }>,
) {
  for (const id of ids) {
    if ((await paseo.agents.ref(id).refresh())?.agent)
      throw new Error("会话仍存在，已保留其配置");
  }
  const state = await read();
  if (state.status !== "ready" || !state.values)
    throw new Error("配置暂不可用，已保留原设置");
  const config = structuredClone(state.values);
  let changed = false;
  for (const id of ids) {
    for (const scopes of [
      config.routing.sessions,
      config.recoveryOverrides.sessions,
    ]) {
      if (Object.hasOwn(scopes, id)) {
        delete scopes[id];
        changed = true;
      }
    }
  }
  return { revision: state.revision, config, changed };
}
