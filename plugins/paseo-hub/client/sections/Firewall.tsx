import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  getGuardStatusRpc, listBansRpc, banIpRpc, unbanIpRpc, listEventsRpc, topAttackersRpc,
} from "../../shared/rpc";

function fmtUptime(s: number): string {
  if (!s) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${m}分`;
  return `${m}分`;
}
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

export function Firewall({ theme, layout }: PluginSurfaceProps) {
  const c = theme.colors;
  const qc = useQueryClient();
  const fetchStatus = useRpc(getGuardStatusRpc);
  const fetchBans = useRpc(listBansRpc);
  const fetchEvents = useRpc(listEventsRpc);
  const fetchTop = useRpc(topAttackersRpc);
  const fetchBan = useRpc(banIpRpc);
  const fetchUnban = useRpc(unbanIpRpc);

  const statusQ = useQuery({ queryKey: ["sg-guard-status"], queryFn: () => fetchStatus({}), refetchInterval: 15_000 });
  const bansQ = useQuery({ queryKey: ["sg-bans"], queryFn: () => fetchBans({ limit: 50, offset: 0 }), refetchInterval: 30_000 });
  const eventsQ = useQuery({ queryKey: ["sg-events"], queryFn: () => fetchEvents({ limit: 30 }), refetchInterval: 30_000 });
  const topQ = useQuery({ queryKey: ["sg-top", 24], queryFn: () => fetchTop({ sinceHours: 24, limit: 10 }), refetchInterval: 60_000 });

  const [ip, setIp] = useState("");
  const [msg, setMsg] = useState("");

  const banMut = useMutation({
    mutationFn: (v: { ip: string }) => fetchBan({ ip: v.ip, reason: "manual via plugin" }),
    onSuccess: (r) => { setMsg(r.message); if (r.ok) { setIp(""); qc.invalidateQueries({ queryKey: ["sg-bans"] }); qc.invalidateQueries({ queryKey: ["sg-guard-status"] }); } },
    onError: (e: any) => setMsg(`错误: ${e?.message ?? e}`),
  });
  const unbanMut = useMutation({
    mutationFn: (v: { ip: string }) => fetchUnban({ ip: v.ip }),
    onSuccess: (r) => { setMsg(r.message); if (r.ok) { qc.invalidateQueries({ queryKey: ["sg-bans"] }); qc.invalidateQueries({ queryKey: ["sg-guard-status"] }); } },
    onError: (e: any) => setMsg(`错误: ${e?.message ?? e}`),
  });

  const st = statusQ.data;
  if (!st) return <Text style={{ color: c.foregroundMuted, padding: 16 }}>加载防火墙状态…</Text>;

  return (
    <ScrollView style={{ flex: 1 }} refreshControl={<RefreshControl refreshing={statusQ.isFetching} onRefresh={() => { statusQ.refetch(); bansQ.refetch(); eventsQ.refetch(); }} />}>
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <StatCard c={c} label="服务状态" value={st.serviceActive ? "运行中" : "已停止"}
            color={st.serviceActive ? c.statusSuccess : c.statusDanger} sub={fmtUptime(st.uptimeSeconds)} />
          <StatCard c={c} label="黑名单 IP" value={String(st.dbBans)}
            sub={`ipset ${st.ipsetEntries} 条 ${st.dbBans !== st.ipsetEntries ? "⚠️ 不同步" : "✓ 同步"}`}
            color={st.dbBans !== st.ipsetEntries ? c.statusWarning : undefined} />
          <StatCard c={c} label="24h 攻击事件" value={String(st.events24h)}
            sub={st.dryRun ? "dry-run 模式" : "自动封禁中"}
            color={st.dryRun ? c.statusWarning : undefined} />
        </View>
        <SectionTitle c={c}>手动操作(永久封禁)</SectionTitle>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <TextInput value={ip} onChangeText={setIp} placeholder="IP 地址" placeholderTextColor={c.foregroundMuted}
            style={{ flex: 1, backgroundColor: c.surface1 ?? c.surface0, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, color: c.foreground, fontSize: 13 }} />
          <Pressable onPress={() => ip && banMut.mutate({ ip })} disabled={!ip || banMut.isPending}
            style={{ backgroundColor: c.statusDanger, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 }}>
            <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>封禁</Text>
          </Pressable>
          <Pressable onPress={() => ip && unbanMut.mutate({ ip })} disabled={!ip || unbanMut.isPending}
            style={{ backgroundColor: c.statusSuccess, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 }}>
            <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>解封</Text>
          </Pressable>
        </View>
        {msg ? <Text style={{ color: c.foregroundMuted, fontSize: 12, marginTop: 6 }}>{msg}</Text> : null}
        <SectionTitle c={c}>24h Top 攻击者</SectionTitle>
        {topQ.data?.items.map((t) => (
          <View key={t.ip} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, paddingHorizontal: 12 }}>
            <Text style={{ color: c.foreground, fontSize: 12, fontFamily: "monospace" }}>{t.ip}</Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t.count} 次 · sev{t.maxSeverity}</Text>
          </View>
        ))}
        <SectionTitle c={c}>黑名单(最近 50 条)</SectionTitle>
        {bansQ.data?.bans.map((b) => (
          <View key={b.ip} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 5, paddingHorizontal: 12, backgroundColor: c.surface1 ?? c.surface0, borderRadius: 6, marginBottom: 3 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.foreground, fontSize: 12, fontFamily: "monospace" }}>{b.ip}</Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{fmtTime(b.ts)} · {b.attackType} · {b.reason.slice(0, 30)}</Text>
            </View>
            <Pressable onPress={() => unbanMut.mutate({ ip: b.ip })} style={{ backgroundColor: c.surface2 ?? c.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ color: c.statusSuccess, fontSize: 11 }}>解封</Text>
            </Pressable>
          </View>
        ))}
        <SectionTitle c={c}>最近攻击事件</SectionTitle>
        {eventsQ.data?.events.slice(0, 15).map((e, i) => (
          <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, paddingHorizontal: 12 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{fmtTime(e.ts)} {e.ip}</Text>
            <Text style={{ color: e.severity >= 5 ? c.statusDanger : c.statusWarning, fontSize: 11 }}>{e.attackType}</Text>
          </View>
        ))}
        <View style={{ height: 40 }} />
      </View>
    </ScrollView>
  );
}
