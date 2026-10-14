import type {
  PluginHookContext,
  PluginLifecycleEvents,
} from "@getpaseo/plugin/server";

// Derive host types through the plugin SDK. Direct type imports from client /
// protocol packages require local development dependencies during host compilation.
export type PaseoApi = PluginHookContext["paseo"];
export type AgentTimelineItem =
  PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];
