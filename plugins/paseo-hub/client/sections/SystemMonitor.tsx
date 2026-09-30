import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useMemo } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { getSystemSnapshotRpc, getAgentProcsRpc } from "../../shared/rpc";

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${n}`;
}
function fmtUptime(s: number): string {
  if (!s) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${m}分`;
  return `${m}分`;
}
function riskColor(pct: number, c: PluginTheme["colors"]): string {
  if (pct >= 90) return c.statusDanger;
  if (pct >= 70) return c.statusWarning;
  return c.statusSuccess;
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

function Bar({ percent, color, c }: { percent: number; color: string; c: PluginTheme["colors"] }) {
  return (
    <View style={{ height: 6, backgroundColor: c.border, borderRadius: 3, overflow: "hidden", marginTop: 4 }}>
      <View style={{ width: `${Math.min(100, percent)}%`, height: 6, backgroundColor: color, borderRadius: 3 }} />
    </View>
  );
}

function SectionTitle({ children, c }: { children: React.ReactNode; c: PluginTheme["colors"] }) {
  return <Text style={{ fontSize: 14, fontWeight: "700", color: c.foreground, marginTop: 16, marginBottom: 8 }}>{children}</Text>;
}

export function SystemMonitor({ theme, layout }: PluginSurfaceProps) {
  const c = theme.colors;
  const fetchSnap = useRpc(getSystemSnapshotRpc);
  const fetchProcs = useRpc(getAgentProcsRpc);
  const snapQ = useQuery({ queryKey: ["sg-system-snapshot"], queryFn: () => fetchSnap({}), refetchInterval: 10_000 });
  const procsQ = useQuery({ queryKey: ["sg-agent-procs"], queryFn: () => fetchProcs({}), refetchInterval: 30_000 });
  const snap = snapQ.data;
  if (!snap) return <Text style={{ color: c.foregroundMuted, padding: 16 }}>加载系统指标…</Text>;

  const memPct = snap.memory.totalBytes ? (snap.memory.usedBytes / snap.memory.totalBytes) * 100 : 0;
  const swapPct = snap.memory.swapTotalBytes ? (snap.memory.swapUsedBytes / snap.memory.swapTotalBytes) * 100 : 0;
  const loadPerCore = snap.cpuCores ? snap.load.min1 / snap.cpuCores : 0;

  return (
    <ScrollView style={{ flex: 1 }} refreshControl={<RefreshControl refreshing={snapQ.isFetching} onRefresh={() => snapQ.refetch()} />}>
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <StatCard c={c} label="负载 (1/5/15min)" value={snap.load.min1.toFixed(2)}
            sub={`${snap.load.min5.toFixed(2)} / ${snap.load.min15.toFixed(2)} · ${snap.cpuCores}核 · ${loadPerCore > 1 ? "过载" : "正常"}`}
            color={riskColor(loadPerCore * 100, c)} />
          <StatCard c={c} label="内存" value={`${memPct.toFixed(0)}%`}
            sub={`${fmtBytes(snap.memory.usedBytes)} / ${fmtBytes(snap.memory.totalBytes)} · 可用 ${fmtBytes(snap.memory.availableBytes)}`}
            color={riskColor(memPct, c)} />
          <StatCard c={c} label="Swap" value={swapPct.toFixed(0) === "0" && snap.memory.swapUsedBytes === 0 ? "未用" : `${fmtBytes(snap.memory.swapUsedBytes)}`}
            sub={snap.memory.swapTotalBytes ? `/ ${fmtBytes(snap.memory.swapTotalBytes)}` : "无 swap"}
            color={riskColor(swapPct, c)} />
          <StatCard c={c} label="开机时长" value={fmtUptime(snap.uptimeSeconds)} sub={snap.hostname} />
        </View>
        {snap.psi ? (
          <>
            <SectionTitle c={c}>内核压力 (PSI avg10)</SectionTitle>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <StatCard c={c} label="IO" value={`${snap.psi.ioSome.toFixed(0)}%`} color={riskColor(snap.psi.ioSome, c)} sub={snap.psi.ioSome > 50 ? "磁盘打满" : "正常"} />
              <StatCard c={c} label="内存" value={`${snap.psi.memSome.toFixed(0)}%`} color={riskColor(snap.psi.memSome, c)} sub={snap.psi.memSome > 50 ? "换页压力" : "正常"} />
              <StatCard c={c} label="CPU" value={`${snap.psi.cpuSome.toFixed(0)}%`} color={riskColor(snap.psi.cpuSome, c)} />
            </View>
          </>
        ) : null}
        <SectionTitle c={c}>磁盘</SectionTitle>
        {snap.disks.map((d) => (
          <View key={d.mount} style={{ backgroundColor: c.surface1 ?? c.surface0, borderRadius: 10, padding: 12, marginBottom: 6 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ color: c.foreground, fontSize: 13 }}>{d.mount}</Text>
              <Text style={{ color: riskColor(d.usePercent, c), fontSize: 13, fontWeight: "600" }}>
                {d.usePercent.toFixed(0)}% · {fmtBytes(d.usedBytes)}/{fmtBytes(d.totalBytes)}
              </Text>
            </View>
            <Bar c={c} percent={d.usePercent} color={riskColor(d.usePercent, c)} />
          </View>
        ))}
        <SectionTitle c={c}>Agent 运行时进程</SectionTitle>
        {procsQ.data && procsQ.data.groups.length > 0 ? (
          procsQ.data.groups.map((g) => (
            <View key={g.name} style={{ backgroundColor: c.surface1 ?? c.surface0, borderRadius: 10, padding: 12, marginBottom: 6, flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ color: c.foreground, fontSize: 13 }}>{g.name}</Text>
              <Text style={{ fontSize: 13, color: g.count > 2 ? c.statusWarning : c.foregroundMuted }}>
                {g.count} 个进程 · {g.totalMemMb}MB {g.count > 2 ? "⚠️ 堆积" : ""}
              </Text>
            </View>
          ))
        ) : (
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>无 agent 运行时进程</Text>
        )}
        <SectionTitle c={c}>Top 进程 (CPU)</SectionTitle>
        {snap.topProcs.map((p) => (
          <View key={p.pid} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4, paddingHorizontal: 12 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1 }} numberOfLines={1}>{p.command}</Text>
            <Text style={{ color: c.foreground, fontSize: 12 }}>{p.cpuPercent.toFixed(1)}% · {p.memMb}MB</Text>
          </View>
        ))}
        {snap.dStateCount > 0 ? (
          <Text style={{ color: c.statusWarning, fontSize: 12, marginTop: 8, padding: 8 }}>
            ⚠️ {snap.dStateCount} 个 D 状态进程(IO 阻塞)
          </Text>
        ) : null}
        <View style={{ height: 40 }} />
      </View>
    </ScrollView>
  );
}
