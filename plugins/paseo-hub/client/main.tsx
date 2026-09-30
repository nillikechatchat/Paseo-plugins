import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useDashStyles } from "./lib/styles";
import type { TopTab, DashTabId } from "./lib/types";
import { Overview } from "./sections/Overview";
import { Workspaces } from "./sections/Workspaces";
import { CurrentTasks } from "./sections/CurrentTasks";
import { TeamTasks } from "./sections/TeamTasks";
import { ArchivedTasks } from "./sections/ArchivedTasks";
import { SystemMonitor } from "./sections/SystemMonitor";
import { Firewall } from "./sections/Firewall";
import { DataSecurity } from "./sections/DataSecurity";
import { AihotNews } from "./sections/AihotNews";

const TOP_TABS: { id: TopTab; label: string }[] = [
  { id: "dashboard", label: "📊 工作台" },
  { id: "server", label: "🛡️ 服务器" },
  { id: "news", label: "📰 AI 新闻" },
];

const DASH_TABS: { id: DashTabId; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "workspaces", label: "工作区" },
  { id: "current", label: "当前任务" },
  { id: "team", label: "团队任务" },
  { id: "archived", label: "归档" },
];

export function MainSurface(props: PluginSurfaceProps) {
  const styles = useDashStyles(props);
  const c = props.theme.colors;
  const [topTab, setTopTab] = useState<TopTab>("dashboard");
  const [dashTab, setDashTab] = useState<DashTabId>("overview");
  const [serverTab, setServerTab] = useState<"system" | "guard" | "data">("system");

  return (
    <View style={styles.screen}>
      {/* Top-level tab bar */}
      <View style={{
        flexDirection: "row",
        paddingHorizontal: 8,
        paddingVertical: 4,
        backgroundColor: c.surface1 ?? c.surface0,
        borderBottomWidth: 1,
        borderBottomColor: c.border ?? "#ffffff10",
        gap: 2,
      }}>
        {TOP_TABS.map((t) => {
          const active = topTab === t.id;
          return (
            <Pressable
              key={t.id}
              onPress={() => setTopTab(t.id)}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 14,
                borderRadius: 8,
                backgroundColor: active ? c.accent : "transparent",
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Text style={{
                fontSize: 14,
                fontWeight: active ? "700" : "500",
                color: active ? c.accentForeground : c.foregroundMuted,
              }}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Content area */}
      <View style={{ flex: 1 }}>
        {topTab === "dashboard" && (
          <View style={{ flex: 1 }}>
            {/* Dashboard sub-tabs */}
            <View style={{
              flexDirection: "row",
              paddingHorizontal: 8,
              paddingVertical: 4,
              backgroundColor: c.surface0,
              borderBottomWidth: 1,
              borderBottomColor: c.border ?? "#ffffff10",
              gap: 2,
            }}>
              {DASH_TABS.map((t) => {
                const active = dashTab === t.id;
                return (
                  <Pressable
                    key={t.id}
                    onPress={() => setDashTab(t.id)}
                    style={{
                      paddingVertical: 6,
                      paddingHorizontal: 10,
                      borderRadius: 6,
                      backgroundColor: active ? "#ffffff10" : "transparent",
                    }}
                  >
                    <Text style={{
                      fontSize: 12,
                      fontWeight: active ? "600" : "400",
                      color: active ? c.foreground : c.foregroundMuted,
                    }}>
                      {t.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ flex: 1 }}>
              {dashTab === "overview" && <Overview {...props} onNavigate={setDashTab} />}
              {dashTab === "workspaces" && <Workspaces {...props} />}
              {dashTab === "current" && <CurrentTasks {...props} />}
              {dashTab === "team" && <TeamTasks {...props} />}
              {dashTab === "archived" && <ArchivedTasks {...props} />}
            </View>
          </View>
        )}

        {topTab === "server" && (
          <View style={{ flex: 1 }}>
            {/* Server sub-tabs */}
            <View style={{
              flexDirection: "row",
              paddingHorizontal: 8,
              paddingVertical: 4,
              backgroundColor: c.surface0,
              borderBottomWidth: 1,
              borderBottomColor: c.border ?? "#ffffff10",
              gap: 2,
            }}>
              {([
                { id: "system" as const, label: "系统监控" },
                { id: "guard" as const, label: "防火墙" },
                { id: "data" as const, label: "数据安全" },
              ]).map((t) => {
                const active = serverTab === t.id;
                return (
                  <Pressable
                    key={t.id}
                    onPress={() => setServerTab(t.id)}
                    style={{
                      paddingVertical: 6,
                      paddingHorizontal: 10,
                      borderRadius: 6,
                      backgroundColor: active ? "#ffffff10" : "transparent",
                    }}
                  >
                    <Text style={{
                      fontSize: 12,
                      fontWeight: active ? "600" : "400",
                      color: active ? c.foreground : c.foregroundMuted,
                    }}>
                      {t.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ flex: 1 }}>
              {serverTab === "system" && <SystemMonitor {...props} />}
              {serverTab === "guard" && <Firewall {...props} />}
              {serverTab === "data" && <DataSecurity {...props} />}
            </View>
          </View>
        )}

        {topTab === "news" && (
          <View style={{ flex: 1 }}>
            <AihotNews {...props} />
          </View>
        )}
      </View>
    </View>
  );
}
