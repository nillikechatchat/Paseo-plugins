import { useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { SectionProps } from "../lib/types";
import { useDashStyles } from "../lib/styles";
import { Dot, Empty } from "../lib/components";
import { useAgents, groupAgents, type AgentEntry } from "../lib/use-dashboard-data";
import {
  agentStatusColor,
  agentStatusLabel,
  relativeTime,
  shortModel,
  shortTime,
} from "../lib/format";

export function ArchivedTasks({ theme, layout }: SectionProps) {
  const styles = useDashStyles({ theme, layout });
  const c = theme.colors;
  const agentsQ = useAgents();
  const [query, setQuery] = useState("");

  const g = groupAgents(agentsQ.data);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return g.archived;
    return g.archived.filter((e) =>
      (e.agent.title ?? "").toLowerCase().includes(q),
    );
  }, [g.archived, query]) as AgentEntry[];

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.row}>
        <Text style={styles.h1}>归档任务</Text>
        <Text style={styles.muted}>{g.archived.length} 个</Text>
      </View>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="搜索归档任务…"
        placeholderTextColor={c.foregroundMuted}
        style={{
          color: c.foreground,
          backgroundColor: c.surface1 ?? c.surface0,
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          fontSize: 13,
        }}
      />

      {agentsQ.isLoading && <Text style={styles.muted}>加载中…</Text>}
      {agentsQ.error && (
        <Text style={[styles.muted, { color: c.statusDanger }]}>错误: {String(agentsQ.error)}</Text>
      )}
      {list.length === 0 && !agentsQ.isLoading && (
        <Empty styles={styles} text="暂无归档任务" />
      )}

      {list.map((e) => (
        <View key={e.agent.id} style={styles.card}>
          <View style={styles.row}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
              <Dot color={agentStatusColor(e.agent.status, c)} />
              <Text style={styles.title} numberOfLines={1}>
                {e.agent.title || e.agent.id.slice(0, 8)}
              </Text>
            </View>
            <Text style={styles.subtitle}>{agentStatusLabel(e.agent.status)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.subtitle}>
              {shortModel(e.agent.provider, e.agent.model)}
            </Text>
            <Text style={styles.subtitle}>
              归档于 {shortTime(e.agent.archivedAt)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.subtitle} numberOfLines={1}>
              {e.project.workspaceName ?? e.project.projectName ?? "—"}
            </Text>
            <Text style={styles.subtitle}>{relativeTime(e.agent.archivedAt)}</Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}
