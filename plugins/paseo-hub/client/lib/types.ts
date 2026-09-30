import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

// 顶层 tabs (4 个一级分区)
export type TopTab = "dashboard" | "server" | "news";

// Dashboard 子 tabs
export type DashTabId = "overview" | "workspaces" | "current" | "team" | "archived";

// Server 子 tabs
export type ServerTab = "system" | "guard" | "data";

// AIHOT 子 tabs
export type NewsTab = "latest" | "hot" | "daily";

export interface SectionProps extends PluginSurfaceProps {
  onNavigate?: (tab: DashTabId) => void;
}
