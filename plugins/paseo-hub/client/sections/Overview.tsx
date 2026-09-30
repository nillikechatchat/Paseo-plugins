import { Pressable, ScrollView, Text, View } from "react-native";
import type { SectionProps } from "../lib/types";
import { useDashStyles } from "../lib/styles";
import { Dot, Empty } from "../lib/components";
import { useAgents, useWorkspaces, useSchedules, groupAgents } from "../lib/use-dashboard-data";
import {
  agentStatusColor,
  agentStatusLabel,
  attentionLabel,
  relativeTime,
  shortModel,
} from "../lib/format";

export function Overview({ theme, layout, onNavigate }: SectionProps) {
  const styles = useDashStyles({ theme, layout });
  const c = theme.colors;
  const agentsQ = useAgents();
  const wsQ = useWorkspaces();
  const schedQ = useSchedules();

  const g = groupAgents(agentsQ.data);
  const wsCount = wsQ.data?.length ?? 0;
  const schedCount = schedQ.data?.schedules.length ?? 0;

  const loading = agentsQ.isLoading || wsQ.isLoading;
  const err = agentsQ.error || wsQ.error || schedQ.error;

  const kpis = [
    { label: "活跃工作区", value: wsCount, color: c.accent, tab: "workspaces" as const },
    { label: "运行中", value: g.runningCount, color: c.accent, tab: "current" as const },
    { label: "需处理", value: g.attention.length, color: c.statusWarning, tab: "current" as const },
    { label: "定时任务", value: schedCount, color: c.statusSuccess, tab: "team" as const },
    { label: "已归档", value: g.archived.length, color: c.foregroundMuted, tab: "archived" as const },
  ];

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      {err && (
        <Text style={[styles.muted, { color: c.statusDanger }]}>错误: {String(err)}</Text>
      )}
      {loading && <Text style={styles.muted}>加载中…</Text>}

      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {kpis.map((k) => (
            <Pressable
              key={k.label}
              onPress={() => onNavigate?.(k.tab)}
              style={[styles.kpi, { minWidth: 120 }]}
            >
              <Text style={[styles.kpiNum, { color: k.color }]}>{k.value}</Text>
              <Text style={styles.kpiLabel}>{k.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* 需处理高亮 */}
      <View style={styles.row}>
        <Text style={styles.h2}>需处理</Text>
        <Text style={styles.muted}>{g.attention.length} 项</Text>
      </View>
      {g.attention.length === 0 ? (
        <Empty styles={styles} text="🎉 暂无需要处理的任务" />
      ) : (
        <View style={styles.card}>
          {g.attention.slice(0, 8).map((e) => (
            <Pressable
              key={e.agent.id}
              onPress={() => onNavigate?.("current")}
              style={{ gap: 4 }}
            >
              <View style={styles.row}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
                  <Dot color={agentStatusColor(e.agent.status, c)} />
                  <Text style={styles.title} numberOfLines={1}>
                    {e.agent.title || e.agent.id.slice(0, 8)}
                  </Text>
                </View>
                <Text style={[styles.badge, { color: c.statusWarning }]}>
                  {attentionLabel(e.agent.attentionReason)}
                </Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.subtitle}>
                  {shortModel(e.agent.provider, e.agent.model)}
                </Text>
                <Text style={styles.subtitle}>{relativeTime(e.agent.updatedAt)}</Text>
              </View>
              <View style={styles.divider} />
            </Pressable>
          ))}
          {g.attention.length > 8 && (
            <Pressable onPress={() => onNavigate?.("current")}>
              <Text style={[styles.muted, { textAlign: "center" }]}>
                查看全部 {g.attention.length} 项 →
              </Text>
            </Pressable>
          )}
        </View>
      )}

      <Text style={styles.muted}>
        agent 状态:{agentStatusLabel("running")} {g.runningCount} ·{" "}
        {agentStatusLabel("idle")} {g.current.filter((x) => x.agent.status === "idle").length} ·{" "}
        {agentStatusLabel("closed")} {g.current.filter((x) => x.agent.status === "closed").length}
      </Text>
    </ScrollView>
  );
}
