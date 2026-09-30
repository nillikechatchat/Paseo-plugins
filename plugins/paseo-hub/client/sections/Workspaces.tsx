import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { SectionProps } from "../lib/types";
import { useDashStyles } from "../lib/styles";
import { Dot, Empty } from "../lib/components";
import { useAgents, useArchiveWorkspace, useWorkspaces } from "../lib/use-dashboard-data";
import {
  diffStat,
  relativeTime,
  wsKindLabel,
  wsStatusLabel,
  wsStatusColor,
} from "../lib/format";

export function Workspaces({ theme, layout }: SectionProps) {
  const styles = useDashStyles({ theme, layout });
  const c = theme.colors;
  const wsQ = useWorkspaces();
  const agentsQ = useAgents();
  const archiveWs = useArchiveWorkspace();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // workspaceId → agent 计数
  const agentCount = new Map<string, number>();
  for (const e of agentsQ.data ?? []) {
    if (!e.agent.archivedAt && e.agent.workspaceId) {
      agentCount.set(e.agent.workspaceId, (agentCount.get(e.agent.workspaceId) ?? 0) + 1);
    }
  }

  const rows = wsQ.data ?? [];

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.row}>
        <Text style={styles.h1}>工作区</Text>
        <Text style={styles.muted}>{rows.length} 个</Text>
      </View>
      {wsQ.isLoading && <Text style={styles.muted}>加载中…</Text>}
      {wsQ.error && (
        <Text style={[styles.muted, { color: c.statusDanger }]}>错误: {String(wsQ.error)}</Text>
      )}
      {rows.length === 0 && !wsQ.isLoading && <Empty styles={styles} text="暂无活跃工作区" />}

      {rows.map((ws) => {
        const name = ws.title ?? ws.name ?? ws.projectDisplayName ?? ws.id;
        const branch = ws.gitRuntime?.currentBranch ?? null;
        const isConfirm = confirmId === ws.id;
        const archiving = ws.archivingAt != null;
        return (
          <View key={ws.id} style={styles.card}>
            <View style={styles.row}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.title} numberOfLines={1}>
                  {name}
                </Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                  {ws.projectDisplayName}
                  {branch ? ` · ⎇ ${branch}` : ""}
                </Text>
              </View>
              {archiving ? (
                <Text style={[styles.badge, { color: c.foregroundMuted }]}>归档中</Text>
              ) : (
                <Pressable
                  onPress={() => setConfirmId(isConfirm ? null : ws.id)}
                  style={[styles.btn, { paddingVertical: 4, paddingHorizontal: 8 }]}
                >
                  <Text style={[styles.btnText, { fontSize: 11 }]}>
                    {isConfirm ? "确认归档?" : "归档"}
                  </Text>
                </Pressable>
              )}
            </View>
            <View style={styles.row}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Dot color={wsStatusColor(ws.status, c)} />
                <Text style={styles.subtitle}>{wsStatusLabel(ws.status)}</Text>
                <Text style={styles.subtitle}>· {wsKindLabel(ws.workspaceKind)}</Text>
              </View>
              <Text style={styles.subtitle}>
                {agentCount.get(ws.id) ?? 0} agent · {diffStat(ws.diffStat)}
              </Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.subtitle} numberOfLines={1}>
                {ws.workspaceDirectory ?? ws.projectRootPath}
              </Text>
              <Text style={styles.subtitle}>{relativeTime(ws.activityAt)}</Text>
            </View>
            {isConfirm && (
              <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                <Pressable
                  onPress={async () => {
                    setConfirmId(null);
                    await archiveWs.mutateAsync(ws.id);
                  }}
                  style={[styles.btn, styles.btnDanger]}
                >
                  <Text style={[styles.btnText, { color: c.accentForeground }]}>
                    {archiveWs.isPending ? "归档中…" : "确认归档"}
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
