import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { SectionProps } from "../lib/types";
import { useDashStyles } from "../lib/styles";
import { Dot, Empty } from "../lib/components";
import {
  useAgents,
  useControlSchedule,
  useScheduleDetail,
  useSchedules,
  groupAgents,
  groupTeamBySchedule,
  type ScheduleRun,
} from "../lib/use-dashboard-data";
import { relativeTime, shortTime, shortModel, agentStatusColor, agentStatusLabel } from "../lib/format";

function runSummary(r: ScheduleRun): string {
  const s = r.status ?? r.state ?? r.result;
  const t = (r.startedAt ?? r.runAt ?? r.at ?? r.timestamp ?? r.createdAt) as
    | string
    | null
    | undefined;
  const parts = [t ? shortTime(t) : null, s != null ? String(s) : null].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return JSON.stringify(r).slice(0, 80);
}

export function TeamTasks({ theme, layout }: SectionProps) {
  const styles = useDashStyles({ theme, layout });
  const c = theme.colors;
  const schedQ = useSchedules();
  const agentsQ = useAgents();
  const control = useControlSchedule();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const detailQ = useScheduleDetail(expandedId);

  const g = groupAgents(agentsQ.data);
  const teamGroups = useMemo(() => groupTeamBySchedule(g.teamAgents), [g.teamAgents]);
  const teamBySchedId = useMemo(() => {
    const m = new Map<string, typeof teamGroups[number]["agents"]>();
    for (const grp of teamGroups) m.set(grp.scheduleId, grp.agents);
    return m;
  }, [teamGroups]);

  const schedules = schedQ.data?.schedules ?? [];
  const knownIds = new Set(schedules.map((s) => s.id));
  // 已删除 schedule 的在跑成员
  const orphanGroups = teamGroups.filter((grp) => !knownIds.has(grp.scheduleId));

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.row}>
        <Text style={styles.h1}>团队任务</Text>
        <Text style={styles.muted}>{schedules.length} 定时 · {g.teamAgents.length} 在跑</Text>
      </View>

      {schedQ.isLoading && <Text style={styles.muted}>加载中…</Text>}
      {schedQ.error && (
        <Text style={[styles.muted, { color: c.statusDanger }]}>错误: {String(schedQ.error)}</Text>
      )}
      {schedules.length === 0 && !schedQ.isLoading && (
        <Empty styles={styles} text="暂无定时任务。用 paseo schedule create 创建。" />
      )}

      {schedules.map((s) => {
        const isPaused = s.status === "paused";
        const expanded = expandedId === s.id;
        const isDelete = deleteId === s.id;
        const runs = detailQ.data?.schedule.id === s.id ? detailQ.data.schedule.runs : [];
        const members = teamBySchedId.get(s.id) ?? [];
        return (
          <View key={s.id} style={styles.card}>
            <Pressable onPress={() => setExpandedId(expanded ? null : s.id)} style={{ gap: 6 }}>
              <View style={styles.row}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.title} numberOfLines={1}>{s.name || s.id}</Text>
                  <Text style={styles.subtitle} numberOfLines={1}>{s.cadence}</Text>
                </View>
                <Dot color={isPaused ? c.foregroundMuted : c.statusSuccess} />
                <Text style={[styles.badge, { color: isPaused ? c.foregroundMuted : c.statusSuccess }]}>
                  {isPaused ? "已暂停" : "active"}
                </Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.subtitle}>{s.target}</Text>
                <Text style={styles.subtitle}>
                  下次 {relativeTime(s.nextRunAt)}
                </Text>
              </View>
              {s.lastRunAt && (
                <Text style={styles.subtitle}>上次运行 {relativeTime(s.lastRunAt)}</Text>
              )}
            </Pressable>

            {/* 操作 */}
            <View style={{ flexDirection: "row", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              <Pressable
                onPress={() => control.mutate({ id: s.id, action: isPaused ? "resume" : "pause" })}
                style={[styles.btn, control.isPending && { opacity: 0.5 }]}
              >
                <Text style={styles.btnText}>{isPaused ? "恢复" : "暂停"}</Text>
              </Pressable>
              <Pressable
                onPress={() => control.mutate({ id: s.id, action: "run-once" })}
                style={[styles.btn, control.isPending && { opacity: 0.5 }]}
              >
                <Text style={styles.btnText}>立即触发</Text>
              </Pressable>
              <Pressable
                onPress={() => setDeleteId(isDelete ? null : s.id)}
                style={[styles.btn, isDelete && styles.btnDanger]}
              >
                <Text style={[styles.btnText, isDelete && { color: c.accentForeground }]}>
                  {isDelete ? "确认删除?" : "删除"}
                </Text>
              </Pressable>
              {isDelete && (
                <Pressable
                  onPress={async () => {
                    setDeleteId(null);
                    await control.mutateAsync({ id: s.id, action: "delete" });
                    setExpandedId(null);
                  }}
                  style={[styles.btn, styles.btnDanger]}
                >
                  <Text style={[styles.btnText, { color: c.accentForeground }]}>确认</Text>
                </Pressable>
              )}
            </View>
            {control.isError && control.variables?.id === s.id && (
              <Text style={[styles.muted, { color: c.statusDanger }]}>操作失败</Text>
            )}

            {/* 展开详情 */}
            {expanded && (
              <View style={{ gap: 6, marginTop: 4 }}>
                {detailQ.isLoading && <Text style={styles.muted}>读取详情…</Text>}
                {detailQ.data && (
                  <>
                    <Text style={styles.subtitle} numberOfLines={3}>
                      {detailQ.data.schedule.prompt.slice(0, 160)}
                      {detailQ.data.schedule.prompt.length > 160 ? "…" : ""}
                    </Text>
                    {runs.length > 0 && (
                      <View style={{ gap: 2 }}>
                        <Text style={styles.muted}>运行历史({runs.length})</Text>
                        {runs.slice(-8).reverse().map((r, i) => (
                          <Text key={i} style={[styles.subtitle, { fontVariant: ["tabular-nums"] as const }]}>
                            • {runSummary(r)}
                          </Text>
                        ))}
                      </View>
                    )}
                  </>
                )}
              </View>
            )}

            {/* 该 schedule 在跑的成员 */}
            {members.length > 0 && (
              <View style={{ gap: 4, marginTop: 4 }}>
                <Text style={styles.muted}>在跑成员({members.length})</Text>
                {members.map((e) => (
                  <View key={e.agent.id} style={[styles.row, { gap: 8 }]}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                      <Dot color={agentStatusColor(e.agent.status, c)} />
                      <Text style={styles.title} numberOfLines={1}>
                        {e.agent.title || e.agent.id.slice(0, 8)}
                      </Text>
                    </View>
                    <Text style={styles.subtitle}>
                      {shortModel(e.agent.provider, e.agent.model)} · {agentStatusLabel(e.agent.status)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      })}

      {/* 已删除 schedule 的在跑成员 */}
      {orphanGroups.length > 0 && (
        <>
          <Text style={styles.h2}>已删除 schedule 的在跑成员</Text>
          <View style={styles.card}>
            {orphanGroups.map((grp) => (
              <View key={grp.scheduleId} style={{ gap: 4 }}>
                <Text style={styles.subtitle}>schedule {grp.scheduleId}</Text>
                {grp.agents.map((e) => (
                  <View key={e.agent.id} style={[styles.row, { gap: 8 }]}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                      <Dot color={agentStatusColor(e.agent.status, c)} />
                      <Text style={styles.title} numberOfLines={1}>
                        {e.agent.title || e.agent.id.slice(0, 8)}
                      </Text>
                    </View>
                    <Text style={styles.subtitle}>{agentStatusLabel(e.agent.status)}</Text>
                  </View>
                ))}
                <View style={styles.divider} />
              </View>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}
