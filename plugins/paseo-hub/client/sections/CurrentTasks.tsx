import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { SectionProps } from "../lib/types";
import { useDashStyles } from "../lib/styles";
import { Dot, Empty, Pill } from "../lib/components";
import {
  useAgents,
  useArchiveAgent,
  groupAgents,
  type AgentEntry,
} from "../lib/use-dashboard-data";
import {
  agentStatusColor,
  agentStatusLabel,
  attentionLabel,
  relativeTime,
  shortModel,
} from "../lib/format";

type Filter = "all" | "running" | "attention" | "idle" | "closed";

export function CurrentTasks({ theme, layout }: SectionProps) {
  const styles = useDashStyles({ theme, layout });
  const c = theme.colors;
  const agentsQ = useAgents();
  const archiveAgent = useArchiveAgent();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const g = groupAgents(agentsQ.data);

  const list = useMemo(() => {
    let l: AgentEntry[] = g.current;
    if (filter === "running") l = l.filter((e) => e.agent.status === "running");
    else if (filter === "attention") l = l.filter((e) => e.agent.requiresAttention);
    else if (filter === "idle") l = l.filter((e) => e.agent.status === "idle");
    else if (filter === "closed") l = l.filter((e) => e.agent.status === "closed");
    const q = query.trim().toLowerCase();
    if (q) l = l.filter((e) => (e.agent.title ?? "").toLowerCase().includes(q));
    return l;
  }, [g.current, filter, query]);

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "全部" },
    { id: "attention", label: `需处理(${g.attention.length})` },
    { id: "running", label: "运行中" },
    { id: "idle", label: "空闲" },
    { id: "closed", label: "已结束" },
  ];

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.row}>
        <Text style={styles.h1}>当前任务</Text>
        <Text style={styles.muted}>{g.current.length} 个活跃</Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {filters.map((f) => (
          <Pill
            key={f.id}
            styles={styles}
            active={filter === f.id}
            label={f.label}
            onPress={() => setFilter(f.id)}
          />
        ))}
      </View>

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="搜索任务标题…"
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
        <Empty styles={styles} text="暂无匹配的任务" />
      )}

      {list.map((e) => {
        const isConfirm = confirmId === e.agent.id;
        return (
          <View key={e.agent.id} style={styles.card}>
            <View style={styles.row}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
                <Dot color={agentStatusColor(e.agent.status, c)} />
                <Text style={styles.title} numberOfLines={1}>
                  {e.agent.title || e.agent.id.slice(0, 8)}
                </Text>
                {e.agent.requiresAttention && (
                  <Text style={[styles.badge, { color: c.statusWarning }]}>
                    {attentionLabel(e.agent.attentionReason)}
                  </Text>
                )}
              </View>
              <Pressable
                onPress={() => setConfirmId(isConfirm ? null : e.agent.id)}
                style={[styles.btn, { paddingVertical: 4, paddingHorizontal: 8 }]}
              >
                <Text style={[styles.btnText, { fontSize: 11 }]}>
                  {isConfirm ? "确认?" : "归档"}
                </Text>
              </Pressable>
            </View>
            <View style={styles.row}>
              <Text style={styles.subtitle}>
                {shortModel(e.agent.provider, e.agent.model)}
                {e.agent.currentModeId ? ` · ${e.agent.currentModeId}` : ""}
              </Text>
              <Text style={styles.subtitle}>{agentStatusLabel(e.agent.status)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.subtitle} numberOfLines={1}>
                {e.project.workspaceName ?? e.project.projectName ?? "—"}
              </Text>
              <Text style={styles.subtitle}>{relativeTime(e.agent.updatedAt)}</Text>
            </View>
            {isConfirm && (
              <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                <Pressable
                  onPress={async () => {
                    setConfirmId(null);
                    await archiveAgent.mutateAsync(e.agent.id);
                  }}
                  style={[styles.btn, styles.btnDanger]}
                >
                  <Text style={[styles.btnText, { color: c.accentForeground }]}>
                    {archiveAgent.isPending ? "归档中…" : "确认归档"}
                  </Text>
                </Pressable>
                <Pressable onPress={() => setConfirmId(null)} style={styles.btn}>
                  <Text style={styles.btnText}>取消</Text>
                </Pressable>
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}
