import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.ts";
import { REFRESH_INTERVAL_MS, discover, fetchUsage, maintainRefresh } from "./server/usage.ts";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "antigravity",
    label: "Antigravity",
    icon: "icon.svg",
    input: inputSchema,
    discover: (scope) => (scope.kind === "global" ? discover() : Promise.resolve([])),
    fetch: fetchUsage,
  });

  // `agy -p "/quota"` boots a 200 MB CLI (~6s), so the panel reads a snapshot instead. The first
  // look spawns once; this timer keeps it fresh only while someone has been opening the panel.
  const timer = setInterval(() => void maintainRefresh(), REFRESH_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
