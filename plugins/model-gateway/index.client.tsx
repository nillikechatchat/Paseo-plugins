import type { PluginClientContext } from "@getpaseo/plugin/client";

import { MainSurface } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", MainSurface);
  client.addSidebarItem({
    id: "model-gateway",
    title: "Model Gateway",
    icon: "Network",
    surface: "main",
  });

  client.addCommandCenterItem({
    id: "open-model-gateway",
    title: "Open Model Gateway",
    icon: "Network",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("main");
    },
  });

  return async () => {};
}
