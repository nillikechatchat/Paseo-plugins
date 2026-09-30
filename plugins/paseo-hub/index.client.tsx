import type { PluginClientContext } from "@getpaseo/plugin/client";

import { MainSurface } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", MainSurface);

  client.addSidebarItem({
    id: "paseo-hub",
    title: "Paseo Hub",
    icon: "LayoutDashboard",
    surface: "main",
  });

  client.addCommandCenterItem({
    id: "open-paseo-hub",
    title: "打开 Paseo Hub",
    icon: "LayoutDashboard",
    keywords: ["hub", "dashboard", "server", "token", "news", "guard", "防火墙", "数据安全"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("main");
    },
  });

  return async () => {};
}
