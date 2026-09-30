import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { getDataSecurityStatsRpc, listDataEventsRpc } from "../../shared/rpc";

const DATA_CAT_NAMES: Record<string, string> = {
  pii: "个人身份信息", financial: "金融数据", credential: "凭证/凭据",
  secret: "密钥/Token", config: "配置泄露", integrity: "文件篡改",
  metadata: "权限变更", access: "敏感访问",
};
function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function StatCard({ label, value, sub, color, c }: { label: string; value: string; sub?: string; color?: string; c: PluginTheme["colors"] }) {
  return (
    <View style={{ flex: 1, backgroundColor: c.surface1 ?? c.surface0, borderRadius: 10, padding: 12, minWidth: 140 }}>
      <Text style={{ fontSize: 11, color: c.foregroundMuted, marginBottom: 4 }}>{label}</Text>
      <Text style={{ fontSize: 18, fontWeight: "700", color: color ?? c.foreground }}>{value}</Text>
      {sub ? <Text style={{ fontSize: 10, color: c.foregroundMuted, marginTop: 2 }}>{sub}</Text> : null}
    </View>
  );
}
function SectionTitle({ children, c }: { children: React.ReactNode; c: PluginTheme["colors"] }) {
  return <Text style={{ fontSize: 14, fontWeight: "700", color: c.foreground, marginTop: 16, marginBottom: 8 }}>{children}</Text>;
}

export function DataSecurity({ theme, layout }: PluginSurfaceProps) {
  const c = theme.colors;
  const fetchStats = useRpc(getDataSecurityStatsRpc);
  const fetchDataEvents = useRpc(listDataEventsRpc);
  const statsQ = useQuery({ queryKey: ["sg-data-stats"], queryFn: () => fetchStats({}), refetchInterval: 30_000 });
  const eventsQ = useQuery({ queryKey: ["sg-data-events"], queryFn: () => fetchDataEvents({ limit: 30 }), refetchInterval: 30_000 });
  const stats = statsQ.data;
  if (!stats) return <Text style={{ color: c.foregroundMuted, padding: 16 }}>加载数据安全状态…</Text>;

  const catEntries = Object.entries(stats.byCategory).filter(([, v]: [string, number]) => v > 0);

  return (
    <ScrollView style={{ flex: 1 }} refreshControl={<RefreshControl refreshing={statsQ.isFetching} onRefresh={() => { statsQ.refetch(); eventsQ.refetch(); }} />}>
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <StatCard c={c} label="数据安全事件" value={String(stats.total)} sub={`24h ${stats.events24h} 条`}
            color={stats.events24h > 0 ? c.statusWarning : undefined} />
          <StatCard c={c} label="文件篡改" value={String(stats.fileIntegrityChanges)}
            sub={stats.fileIntegrityChanges > 0 ? "⚠️ 有变更" : "✓ 正常"}
            color={stats.fileIntegrityChanges > 0 ? c.statusDanger : undefined} />
          <StatCard c={c} label="权限变更" value={String(stats.fileMetadataChanges)}
            sub={stats.fileMetadataChanges > 0 ? "⚠️ 有变更" : "✓ 正常"}
            color={stats.fileMetadataChanges > 0 ? c.statusDanger : undefined} />
        </View>
        {catEntries.length > 0 ? (
          <>
            <SectionTitle c={c}>泄露分类</SectionTitle>
            {catEntries.map((entry) => {
              const [cat, count] = entry as [string, number];
              return (
                <View key={cat} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, paddingHorizontal: 12, backgroundColor: c.surface1 ?? c.surface0, borderRadius: 6, marginBottom: 3 }}>
                  <Text style={{ color: c.foreground, fontSize: 12 }}>{DATA_CAT_NAMES[cat] ?? cat}</Text>
                  <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{count} 条</Text>
                </View>
              );
            })}
          </>
        ) : null}
        <SectionTitle c={c}>文件完整性</SectionTitle>
        <View style={{ backgroundColor: c.surface1 ?? c.surface0, borderRadius: 10, padding: 12, marginBottom: 8 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>内容篡改</Text>
            <Text style={{ color: stats.fileIntegrityChanges > 0 ? c.statusDanger : c.statusSuccess, fontSize: 12, fontWeight: "600" }}>
              {stats.fileIntegrityChanges > 0 ? `${stats.fileIntegrityChanges} 次` : "无"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>权限变更</Text>
            <Text style={{ color: stats.fileMetadataChanges > 0 ? c.statusDanger : c.statusSuccess, fontSize: 12, fontWeight: "600" }}>
              {stats.fileMetadataChanges > 0 ? `${stats.fileMetadataChanges} 次` : "无"}
            </Text>
          </View>
        </View>
        <SectionTitle c={c}>最近数据事件</SectionTitle>
        {stats.recentEvents.length > 0 ? (
          stats.recentEvents.map((e, i) => (
            <View key={i} style={{ paddingVertical: 5, paddingHorizontal: 12, backgroundColor: c.surface1 ?? c.surface0, borderRadius: 6, marginBottom: 3 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: c.foreground, fontSize: 11, fontFamily: "monospace" }}>{e.ip}</Text>
                <Text style={{ color: e.attackType === "data_file_integrity" ? c.statusDanger : e.attackType === "data_sensitive_access" ? c.statusWarning : c.accent, fontSize: 11 }}>
                  {DATA_CAT_NAMES[e.attackType.replace("data_", "")] ?? e.attackType}
                </Text>
              </View>
              <Text style={{ color: c.foregroundMuted, fontSize: 10, marginTop: 2 }} numberOfLines={2}>
                {fmtTime(e.ts)} · {e.detail}
              </Text>
            </View>
          ))
        ) : (
          <Text style={{ color: c.foregroundMuted, fontSize: 12, padding: 12 }}>暂无数据安全事件</Text>
        )}
        <View style={{ height: 40 }} />
      </View>
    </ScrollView>
  );
}
