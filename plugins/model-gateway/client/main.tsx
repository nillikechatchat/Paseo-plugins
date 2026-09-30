// Main surface. Tabs: 概览 / 服务商 / 调用 / 缓存 / 网关.
//
// All colours are pulled from `theme.colors` so the UI looks correct under
// any of the host's themes (light, dark, custom). Layout uses compact-mode
// paddings on mobile.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  listProviders,
  upsertProvider,
  deleteProvider,
  toggleProvider,
  gatewayStatus,
  gatewayStart,
  gatewayStop,
  overview,
  recentCalls,
  clearStats,
  cacheStatus,
  cacheConfig,
  cacheClear,
  catalogue,
  bootstrapAgent,
  syncAgentConfigsRpc,
  syncProviderModelsNow,
  setProviderSyncInterval,
  providerSyncStatus,
  testProvider,
} from "../shared/rpc";
import {
  PROVIDER_TYPE_LABELS,
  type ProviderRecord,
  type ProviderType,
} from "./ui/types";
import { ProviderEdit } from "./ui/ProviderEdit";
import { TokenTracker } from "./sections/TokenTracker";
import {
  formatBytes,
  formatMs,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  sparklineBars,
} from "./ui/format";

type Tab = "overview" | "providers" | "models" | "calls" | "cache" | "token" | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "概览" },
  { key: "providers", label: "服务商" },
  { key: "models", label: "模型" },
  { key: "calls", label: "调用记录" },
  { key: "cache", label: "缓存" },
  { key: "token", label: "Token" },
  { key: "settings", label: "网关" },
];

const REFRESH_INTERVAL_MS = 5_000;

/**
 * Polling defaults shared by every live query (RTK-Query-style centralised
 * policy, kept on react-query since the host externalises only this lib):
 * - poll only while the surface is foregrounded (`refetchIntervalInBackground:
 *   false` is react-query's default, stated here as the contract)
 * - keep previous data across window changes so the overview never blanks
 */
const LIVE_QUERY = {
  refetchInterval: REFRESH_INTERVAL_MS,
  refetchIntervalInBackground: false,
} as const;

/** Quasi-static data: skip redundant refetches within its freshness window. */
function staticQuery(staleMs = 30_000) {
  return { staleTime: staleMs, refetchIntervalInBackground: false } as const;
}

export function MainSurface({ theme, layout, host }: PluginSurfaceProps) {
  const compact = layout.compact;
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const [tab, setTab] = useState<Tab>("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProviderRecord | null>(null);
  const queryClient = useQueryClient();

  // RPC handles (useRpc returns a callable)
  const callListProviders = useRpc(listProviders);
  const callUpsertProvider = useRpc(upsertProvider);
  const callDeleteProvider = useRpc(deleteProvider);

  return (
    <View style={styles.screen}>
      <View style={styles.tabBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: compact ? 8 : 16 }}>
          {TABS.map((t) => (
            <Pressable key={t.key} onPress={() => setTab(t.key)} style={[styles.tab, tab === t.key ? styles.tabActive : null]}>
              <Text style={tab === t.key ? styles.tabTextActive : styles.tabText}>{t.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      <View style={{ flex: 1 }}>
        {tab === "overview" && <OverviewTab theme={theme} styles={styles} />}
        {tab === "providers" && (
          <ProvidersTab
            theme={theme}
            styles={styles}
            listProvidersFn={callListProviders}
            deleteProviderFn={callDeleteProvider}
            onAdd={() => { setEditTarget(null); setEditOpen(true); }}
            onEdit={(p) => { setEditTarget(p); setEditOpen(true); }}
          />
        )}
        {tab === "models" && <ModelsTab theme={theme} styles={styles} />}
        {tab === "calls" && <CallsTab theme={theme} styles={styles} />}
        {tab === "cache" && <CacheTab theme={theme} styles={styles} />}
        {tab === "token" && <TokenTracker theme={theme} layout={layout} host={host} />}
        {tab === "settings" && <SettingsTab theme={theme} styles={styles} />}
      </View>
      <ProviderEdit
        open={editOpen}
        initial={editTarget}
        theme={theme}
        onClose={() => setEditOpen(false)}
        onSubmit={async (input) => {
          await callUpsertProvider(input);
          queryClient.invalidateQueries({ queryKey: ["providers"] });
        }}
        onDelete={async (id) => {
          await callDeleteProvider({ id });
          queryClient.invalidateQueries({ queryKey: ["providers"] });
        }}
      />
    </View>
  );
}

// ---- Tabs ---------------------------------------------------------------------

function OverviewTab({ theme, styles }: { theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  const callStatus = useRpc(gatewayStatus);
  const callOverview = useRpc(overview);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: () => callStatus({}),
    ...LIVE_QUERY,
  });
  const overviewQuery = useQuery({
    ...LIVE_QUERY,
    queryKey: ["overview", windowMinutes],
    queryFn: () => callOverview({ windowMinutes }),
    placeholderData: (prev) => prev,
  });

  const status = statusQuery.data;
  const stats = overviewQuery.data;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={statusQuery.isFetching || overviewQuery.isFetching} onRefresh={() => { statusQuery.refetch(); overviewQuery.refetch(); }} tintColor={theme.colors.foreground} />}
    >
      <GatewayHeader status={status} theme={theme} styles={styles} />

      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <Text style={styles.h2}>时间窗口</Text>
        {[15, 60, 360, 1440].map((m) => (
          <Pressable key={m} onPress={() => setWindowMinutes(m)} style={[styles.pill, windowMinutes === m ? styles.pillActive : null]}>
            <Text style={windowMinutes === m ? styles.pillTextActive : styles.pillText}>{formatWindow(m)}</Text>
          </Pressable>
        ))}
      </View>

      {overviewQuery.isLoading && !stats ? (
        <ActivityIndicator color={theme.colors.foreground} />
      ) : stats ? (
        <>
          <MetricGrid stats={stats} theme={theme} styles={styles} />
          <TimeseriesCard stats={stats} theme={theme} styles={styles} />
          <ProviderBreakdown stats={stats} theme={theme} styles={styles} />
          <ModelBreakdown stats={stats} theme={theme} styles={styles} />
        </>
      ) : (
        <Text style={styles.muted}>暂无数据</Text>
      )}
    </ScrollView>
  );
}

function GatewayHeader({ status, theme, styles }: { status: GatewayStatus | undefined; theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  if (!status) return null;
  return (
    <View style={[styles.card, { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }]}>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: status.running ? theme.colors.statusSuccess : theme.colors.statusDanger }} />
          <Text style={styles.h2}>{status.running ? "网关运行中" : "网关未启动"}</Text>
        </View>
        {status.running && <Text style={styles.mono}>{status.baseUrl}</Text>}
        <Text style={styles.muted}>
          PID {status.pid ?? "—"} · {formatNumber(status.requests)} 次调用 · {formatBytes(status.bytesIn + status.bytesOut)}
        </Text>
      </View>
    </View>
  );
}

function MetricGrid({ stats, theme, styles }: { stats: OverviewStats; theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  const cells: Array<[string, string, string?]> = [
    ["请求", formatNumber(stats.requests)],
    ["错误", `${formatNumber(stats.errors)} (${formatPercent(stats.errorRate)})`, stats.errorRate > 0.05 ? theme.colors.statusDanger : undefined],
    ["Prompt Tokens", formatNumber(stats.promptTokens)],
    ["Completion Tokens", formatNumber(stats.completionTokens)],
    ["平均延迟", formatMs(stats.avgDurationMs)],
    ["p50 延迟", formatMs(stats.p50DurationMs)],
    ["p95 延迟", formatMs(stats.p95DurationMs)],
    ["p99 延迟", formatMs(stats.p99DurationMs)],
    ["平均 TTFB", formatMs(stats.avgTtfbMs)],
    ["p95 TTFB", formatMs(stats.p95TtfbMs)],
    ["缓存命中", `${formatNumber(stats.cacheHits)} (${formatPercent(stats.cacheHitRate)})`, stats.cacheHitRate > 0 ? theme.colors.statusSuccess : undefined],
  ];
  return (
    <View style={[styles.card, { flexDirection: "row", flexWrap: "wrap", gap: 8 }]}>
      {cells.map(([label, value, color]) => (
        <View key={label} style={[styles.metricCell]}>
          <Text style={styles.metricLabel}>{label}</Text>
          <Text style={[styles.metricValue, color ? { color } : null]}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

function TimeseriesCard({ stats, theme, styles }: { stats: OverviewStats; theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  const reqSeries = stats.timeseries.map((b) => b.requests);
  const errSeries = stats.timeseries.map((b) => b.errors);
  const tokenSeries = stats.timeseries.map((b) => b.tokens);
  const reqBars = sparklineBars(reqSeries, Math.max(1, ...reqSeries), 60, theme);
  const errBars = sparklineBars(errSeries, Math.max(1, ...errSeries), 60, theme);
  const tokenBars = sparklineBars(tokenSeries, Math.max(1, ...tokenSeries), 60, theme);

  return (
    <View style={[styles.card, { gap: 8 }]}>
      <Text style={styles.h2}>时序（每桶 ≈ window/60）</Text>
      <TimeseriesRow label="请求/桶" bars={reqBars} total={reqSeries.reduce((a, b) => a + b, 0)} styles={styles} />
      <TimeseriesRow label="错误/桶" bars={errBars} total={errSeries.reduce((a, b) => a + b, 0)} styles={styles} />
      <TimeseriesRow label="Tokens/桶" bars={tokenBars} total={tokenSeries.reduce((a, b) => a + b, 0)} styles={styles} />
      {stats.timeseries.length === 0 && <Text style={styles.muted}>窗口内无数据</Text>}
    </View>
  );
}

function TimeseriesRow({ label, bars, total, styles }: { label: string; bars: ReturnType<typeof sparklineBars>; total: number; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={styles.muted}>{label}</Text>
        <Text style={styles.muted}>合计 {formatNumber(total)}</Text>
      </View>
      <Text style={styles.sparkline}>
        {bars.map((b, i) => (
          <Text key={i} style={{ color: b.color }}>{b.bar}</Text>
        ))}
      </Text>
    </View>
  );
}

function ProviderBreakdown({ stats, theme, styles }: { stats: OverviewStats; theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  if (stats.byProvider.length === 0) return null;
  return (
    <View style={[styles.card, { gap: 6 }]}>
      <Text style={styles.h2}>按 Provider</Text>
      <View style={[styles.tableRow, styles.tableHeader]}>
        <Text style={[styles.tableHeaderCell, { flex: 2 }]}>Provider</Text>
        <Text style={[styles.tableHeaderCell, styles.numeric]}>请求</Text>
        <Text style={[styles.tableHeaderCell, styles.numeric]}>错误</Text>
        <Text style={[styles.tableHeaderCell, styles.numeric]}>Tokens</Text>
        <Text style={[styles.tableHeaderCell, styles.numeric]}>平均</Text>
      </View>
      {stats.byProvider.map((row) => (
        <View key={row.provider} style={styles.tableRow}>
          <Text style={[styles.tableCell, { flex: 2 }]} numberOfLines={1}>{row.provider}</Text>
          <Text style={[styles.tableCell, styles.numeric]}>{formatNumber(row.requests)}</Text>
          <Text style={[styles.tableCell, styles.numeric, row.errors > 0 ? { color: theme.colors.statusDanger } : null]}>{formatNumber(row.errors)}</Text>
          <Text style={[styles.tableCell, styles.numeric]}>{formatNumber(row.promptTokens + row.completionTokens)}</Text>
          <Text style={[styles.tableCell, styles.numeric]}>{formatMs(row.avgDurationMs)}</Text>
        </View>
      ))}
    </View>
  );
}

function ModelBreakdown({ stats, theme, styles }: { stats: OverviewStats; theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  if (stats.byModel.length === 0) return null;
  const sorted = [...stats.byModel].sort((a, b) => b.requests - a.requests).slice(0, 50);
  return (
    <View style={[styles.card, { gap: 6 }]}>
      <Text style={styles.h2}>按模型</Text>
      <View style={[styles.tableRow, styles.tableHeader]}>
        <Text style={[styles.tableHeaderCell, { flex: 3 }]}>Model</Text>
        <Text style={[styles.tableHeaderCell, styles.numeric]}>请求</Text>
        <Text style={[styles.tableHeaderCell, styles.numeric]}>错误</Text>
        <Text style={[styles.tableHeaderCell, styles.numeric]}>In Tok</Text>
        <Text style={[styles.tableHeaderCell, styles.numeric]}>Out Tok</Text>
        <Text style={[styles.tableHeaderCell, styles.numeric]}>平均</Text>
      </View>
      {sorted.map((row) => (
        <View key={`${row.provider}:${row.model}`} style={styles.tableRow}>
          <Text style={[styles.tableCell, { flex: 3 }]} numberOfLines={1}>{row.model}</Text>
          <Text style={[styles.tableCell, styles.numeric]}>{formatNumber(row.requests)}</Text>
          <Text style={[styles.tableCell, styles.numeric, row.errors > 0 ? { color: theme.colors.statusDanger } : null]}>{formatNumber(row.errors)}</Text>
          <Text style={[styles.tableCell, styles.numeric]}>{formatNumber(row.promptTokens)}</Text>
          <Text style={[styles.tableCell, styles.numeric]}>{formatNumber(row.completionTokens)}</Text>
          <Text style={[styles.tableCell, styles.numeric]}>{formatMs(row.avgDurationMs)}</Text>
        </View>
      ))}
    </View>
  );
}

function ProvidersTab({ theme, styles, listProvidersFn, deleteProviderFn, onAdd, onEdit }: { theme: PluginTheme; styles: ReturnType<typeof makeStyles>; listProvidersFn: (input: {}) => Promise<{ providers: ProviderRecord[] }>; deleteProviderFn: (input: { id: string }) => Promise<unknown>; onAdd: () => void; onEdit: (p: ProviderRecord) => void }) {
  const callToggle = useRpc(toggleProvider);
  const callTest = useRpc(testProvider);
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    ...LIVE_QUERY,
    ...staticQuery(30_000),
    queryKey: ["providers"],
    queryFn: () => listProvidersFn({}),
  });
  // Optimistic toggle (RTK onQueryStarted pattern): patch the cache first,
  // roll back on error, refetch to settle on success.
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => callToggle(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["providers"] });
      const prev = queryClient.getQueryData<{ providers: ProviderRecord[] }>(["providers"]);
      queryClient.setQueryData<{ providers: ProviderRecord[] }>(["providers"], (old) =>
        old
          ? {
              providers: old.providers.map((p) =>
                p.id === input.id ? { ...p, enabled: input.enabled } : p,
              ),
            }
          : old,
      );
      return { prev };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["providers"], ctx.prev);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });
  const test = useMutation({
    mutationFn: (input: { id: string }) => callTest(input),
  });
  const testingId = test.isPending ? test.variables?.id : null;

  const providers = query.data?.providers ?? [];

  async function handleTest(id: string) {
    try {
      const r = await callTest({ id });
      if (r.ok) {
        const models = r.upstreamModels.length;
        toast.show(`✓ 连通 (${r.status}) · ${models} 个模型 · ${r.latencyMs}ms`, { variant: "success", durationMs: 4000 });
      } else {
        toast.show(`✗ ${r.status ?? "网络错误"} · ${r.error ?? ""}`, { variant: "error", durationMs: 5000 });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const callSyncNow = useRpc(syncProviderModelsNow);
  const callSetInterval = useRpc(setProviderSyncInterval);
  const callSyncStatus = useRpc(providerSyncStatus);
  const [intervalDays, setIntervalDays] = useState("7");
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const syncQuery = useQuery({
    queryKey: ["syncStatus"],
    queryFn: () => callSyncStatus({}),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const intervalDaysNum = Math.max(0, parseInt(intervalDays, 10) || 0);

  async function handleSyncOne(id: string) {
    if (syncingId || syncingAll) return;
    setSyncingId(id);
    try {
      await callSyncNow({ id });
      toast.show("已同步上游模型", { variant: "success", durationMs: 2500 });
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      queryClient.invalidateQueries({ queryKey: ["syncStatus"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingId(null);
    }
  }

  async function handleSyncAll() {
    if (syncingAll || syncingId) return;
    setSyncingAll(true);
    try {
      await callSyncNow({});
      toast.show("全部 provider 已同步", { variant: "success", durationMs: 2500 });
      queryClient.invalidateQueries({ queryKey: ["providers"] });
      queryClient.invalidateQueries({ queryKey: ["syncStatus"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingAll(false);
    }
  }

  async function handleApplyInterval() {
    const days = Math.max(0, parseInt(intervalDays, 10) || 0);
    const ms = days === 0 ? 0 : days * 24 * 60 * 60 * 1000;
    try {
      await callSetInterval({ intervalMs: ms });
      toast.show(ms === 0 ? "已关闭定时同步" : `已设为每 ${days} 天同步一次`, { variant: "success", durationMs: 2500 });
      queryClient.invalidateQueries({ queryKey: ["syncStatus"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.toolbar}>
        <Pressable onPress={onAdd} style={[styles.primaryBtn, { backgroundColor: theme.colors.accent }]}>
          <Text style={{ color: theme.colors.accentForeground, fontWeight: "600" }}>+ 新增 Provider</Text>
        </Pressable>
        <Pressable
          disabled={syncingAll || !!syncingId || providers.length === 0}
          onPress={handleSyncAll}
          style={[styles.pill, { borderColor: theme.colors.border, opacity: syncingAll ? 0.5 : 1 }]}
        >
          {syncingAll ? (
            <ActivityIndicator color={theme.colors.foreground} />
          ) : (
            <Text style={styles.pillText}>↻ 全部同步</Text>
          )}
        </Pressable>
        <View style={{ flex: 1 }} />
        {query.isFetching && <ActivityIndicator color={theme.colors.foreground} />}
      </View>
      <View style={[styles.card, styles.syncCard]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={[styles.h2, { flexShrink: 0 }]}>上游模型同步</Text>
          <View style={{ flex: 1 }} />
          <Text style={styles.muted}>
            间隔 {Math.round((syncQuery.data?.intervalMs ?? 0) / (24 * 60 * 60 * 1000))} 天
            {syncQuery.data?.lastSyncAt ? ` · 上次 ${formatTimeAgo(syncQuery.data.lastSyncAt)}` : " · 尚未同步"}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={[styles.muted, { flexShrink: 0 }]}>每</Text>
          <TextInput
            value={intervalDays}
            onChangeText={setIntervalDays}
            keyboardType="number-pad"
            placeholder="7"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.input, { width: 80, paddingVertical: 6 }]}
          />
          <Text style={[styles.muted, { flexShrink: 0 }]}>天同步一次（0 = 关闭）</Text>
          <View style={{ flex: 1 }} />
          <Pressable
            disabled={intervalDaysNum === Math.round((syncQuery.data?.intervalMs ?? 0) / (24 * 60 * 60 * 1000))}
            onPress={handleApplyInterval}
            style={[styles.pill, { borderColor: theme.colors.accent, opacity: intervalDaysNum === Math.round((syncQuery.data?.intervalMs ?? 0) / (24 * 60 * 60 * 1000)) ? 0.4 : 1 }]}
          >
            <Text style={[styles.pillText, { color: theme.colors.accent }]}>应用</Text>
          </Pressable>
        </View>
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: 0 }]}>
        {providers.length === 0 && (
          <View style={styles.card}>
            <Text style={styles.h2}>还没有配置任何 Provider</Text>
            <Text style={styles.muted}>点击右上角新增，或在客户端配置 Paseo Model Provider 时把 baseUrl 指向本网关即可走代理。</Text>
          </View>
        )}
        {providers.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            theme={theme}
            styles={styles}
            onToggle={(enabled) => toggle.mutate({ id: p.id, enabled })}
            onEdit={() => onEdit(p)}
            onTest={() => handleTest(p.id)}
            onSync={() => handleSyncOne(p.id)}
            syncing={syncingId === p.id}
            onDelete={async () => {
              try {
                await deleteProviderFn({ id: p.id });
                queryClient.invalidateQueries({ queryKey: ["providers"] });
                toast.show(`已删除 ${p.name}`, { variant: "success" });
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        ))}
        {testingId && <Text style={styles.muted}>正在测试 {testingId}...</Text>}
      </ScrollView>
    </View>
  );
}

function ProviderRow({ provider, theme, styles, onToggle, onEdit, onTest, onSync, syncing, onDelete }: { provider: ProviderRecord; theme: PluginTheme; styles: ReturnType<typeof makeStyles>; onToggle: (enabled: boolean) => void; onEdit: () => void; onTest: () => void; onSync: () => void; syncing: boolean; onDelete: () => Promise<void> }) {
  const typeLabel = PROVIDER_TYPE_LABELS[provider.type as ProviderType] ?? provider.type;
  const toast = useToast();
  const [pendingDelete, setPendingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function handleDelete() {
    if (deleting) return;
    if (!pendingDelete) {
      // First tap: arm and tell the user to tap again to confirm.
      setPendingDelete(true);
      toast.show(`再点一次「删除」以确认移除 ${provider.name}`, { variant: "warning", durationMs: 4000 });
      setTimeout(() => setPendingDelete(false), 4000);
      return;
    }
    setDeleting(true);
    setPendingDelete(false);
    onDelete().finally(() => setDeleting(false));
  }
  return (
    <View style={styles.card}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: provider.enabled ? theme.colors.statusSuccess : theme.colors.statusWarning }} />
        <Text style={[styles.h2, { flex: 1 }]} numberOfLines={1}>{provider.name}</Text>
        <Pressable onPress={onEdit} style={[styles.pill, { borderColor: theme.colors.border }]}>
          <Text style={styles.pillText}>编辑</Text>
        </Pressable>
      </View>
      <Text style={styles.muted}>
        {typeLabel} · 优先级 {provider.priority} · 权重 {provider.weight} · {provider.models.length} 个模型
      </Text>
      <Text style={styles.mono} numberOfLines={1}>{provider.baseUrl || "(默认地址)"}</Text>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
        {provider.models.slice(0, 8).map((m) => (
          <View key={m} style={[styles.tag]}>
            <Text style={styles.tagText}>{m}</Text>
          </View>
        ))}
        {provider.models.length > 8 && <Text style={styles.muted}>+{provider.models.length - 8} more</Text>}
      </View>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8, alignItems: "center" }}>
        <Pressable
          onPress={() => onToggle(!provider.enabled)}
          style={[styles.pill, provider.enabled ? { borderColor: theme.colors.statusWarning } : { borderColor: theme.colors.statusSuccess }]}
        >
          <Text style={styles.pillText}>{provider.enabled ? "停用" : "启用"}</Text>
        </Pressable>
        <Pressable onPress={onTest} style={[styles.pill, { borderColor: theme.colors.accent }]}>
          <Text style={styles.pillText}>测试连通</Text>
        </Pressable>
        <Pressable
          disabled={syncing}
          onPress={onSync}
          style={[styles.pill, { borderColor: theme.colors.accent, opacity: syncing ? 0.5 : 1 }]}
        >
          {syncing ? (
            <ActivityIndicator color={theme.colors.accent} />
          ) : (
            <Text style={[styles.pillText, { color: theme.colors.accent }]}>同步模型</Text>
          )}
        </Pressable>
        <Pressable
          disabled={deleting}
          onPress={handleDelete}
          style={[
            styles.pill,
            { borderColor: theme.colors.statusDanger, backgroundColor: pendingDelete ? theme.colors.statusDanger : "transparent" },
          ]}
        >
          {deleting ? (
            <ActivityIndicator color={theme.colors.accentForeground} />
          ) : (
            <Text style={[styles.pillText, { color: pendingDelete ? theme.colors.accentForeground : theme.colors.statusDanger }]}>
              {pendingDelete ? "再点确认" : "删除"}
            </Text>
          )}
        </Pressable>
        {provider.rateLimitRpm > 0 && <Text style={styles.muted}>· 限速 {provider.rateLimitRpm} RPM</Text>}
        {provider.apiKey && <Text style={styles.muted}>· key 已配置</Text>}
      </View>
    </View>
  );
}

function ModelsTab({ theme, styles }: { theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  const callCatalogue = useRpc(catalogue);
  const [filter, setFilter] = useState("");
  const query = useQuery({
    queryKey: ["catalogue"],
    queryFn: () => callCatalogue({}),
    refetchInterval: REFRESH_INTERVAL_MS * 2,
    refetchIntervalInBackground: false,
  });
  const models = query.data?.models ?? [];
  const grouped = useMemo(() => {
    // Group by *claimant*, not by the priority winner. A model two providers
    // list used to show up under the primary only, so the second provider's
    // copy was invisible here while the picker only offered the primary's
    // label — the panel and the conversation selectors disagreed about which
    // upstreams are configurable. Fan out over `claimingProviders` so this tab
    // lists exactly the (provider, model) pairs the picker writes.
    const m = new Map<string, { providerName: string; providerType: string; providerTypeLabel?: string; entries: Array<{ model: string; label: string; protocols: string[] }> }>();
    for (const x of models) {
      const claims = (x as { claimingProviders?: Array<{ id: string; name: string; type: string; typeLabel?: string; label: string; protocols: string[] }> }).claimingProviders;
      const list = claims && claims.length > 0
        ? claims
        : [{ id: x.provider, name: x.providerName, type: x.providerType, typeLabel: x.providerTypeLabel, label: x.label, protocols: x.protocols }];
      for (const c of list) {
        const g = m.get(c.id) ?? { providerName: c.name, providerType: c.type, providerTypeLabel: c.typeLabel, entries: [] };
        if (!g.entries.some((e) => e.model === x.model)) {
          g.entries.push({ model: x.model, label: c.label, protocols: c.protocols ?? [] });
        }
        m.set(c.id, g);
      }
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models]);
  const f = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!f) return grouped;
    return grouped
      .map(([pid, g]) => {
        const matched = g.entries.filter((e) => e.model.toLowerCase().includes(f) || e.label.toLowerCase().includes(f));
        if (matched.length > 0 || pid.toLowerCase().includes(f) || g.providerName.toLowerCase().includes(f)) {
          return [pid, { ...g, entries: matched.length > 0 ? matched : g.entries }] as const;
        }
        return null;
      })
      .filter((x): x is readonly [string, typeof grouped[number][1]] => x !== null);
  }, [grouped, f]);
  // Count chips, not catalogue rows: a model claimed by two providers is two
  // selectable entries, and this number is what the picker will show too.
  const totalCount = grouped.reduce((sum, [, g]) => sum + g.entries.length, 0);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Text style={styles.h2}>模型目录</Text>
        <Text style={styles.muted}>· {totalCount} 个模型 · {grouped.length} 个 Provider</Text>
        <View style={{ flex: 1 }} />
        {query.isFetching && <ActivityIndicator color={theme.colors.foreground} />}
      </View>
      <TextInput
        value={filter}
        onChangeText={setFilter}
        placeholder="按 Provider 名或模型名过滤..."
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { marginBottom: 8 }]}
      />
      {filtered.length === 0 && (
        <View style={styles.card}>
          <Text style={styles.muted}>{totalCount === 0 ? "尚未配置 Provider，或所有 Provider 都未启用。" : "没有匹配的模型。"}</Text>
        </View>
      )}
      {filtered.map(([pid, g]) => (
        <View key={pid} style={styles.card}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[styles.h2, { flex: 1 }]} numberOfLines={1}>{g.providerName}</Text>
            <Text style={styles.muted}>{g.entries.length}</Text>
          </View>
          <Text style={styles.muted}>{pid} · {g.providerTypeLabel ?? g.providerType}</Text>
          <View style={{ gap: 4, marginTop: 4 }}>
            {g.entries.map((e) => (
              <View key={e.model} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={[styles.tag, { flexShrink: 1 }]}>
                  <Text style={styles.tagText}>{e.label}</Text>
                </Text>
                <View style={{ flexDirection: "row", gap: 3 }}>
                  {e.protocols.map((proto) => (
                    <Text key={proto} style={[styles.tag, styles.tagSub]}>{proto}</Text>
                  ))}
                </View>
              </View>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

function FilterChip({ label, active, theme, styles, onPress }: { label: string; active: boolean; theme: PluginTheme; styles: ReturnType<typeof makeStyles>; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.pill, active ? { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent } : null]}
    >
      <Text style={[styles.pillText, active ? { color: theme.colors.accentForeground, fontWeight: "600" as const } : null]}>{label}</Text>
    </Pressable>
  );
}

function CallsTab({ theme, styles }: { theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  const callRecent = useRpc(recentCalls);
  const callListProviders = useRpc(listProviders);
  const [providerFilter, setProviderFilter] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<"ok" | "error" | undefined>(undefined);
  // The provider list is quasi-static: the filters below only need ids, so a
  // 30s staleTime keeps tab switches from refetching it.
  const providersQuery = useQuery({
    ...staticQuery(30_000),
    queryKey: ["providers"],
    queryFn: () => callListProviders({}),
  });
  const query = useQuery({
    queryKey: ["recent", providerFilter, statusFilter],
    queryFn: () => callRecent({ limit: 100, provider: providerFilter, status: statusFilter }),
    refetchInterval: REFRESH_INTERVAL_MS,
  });
  const calls = query.data?.calls ?? [];
  const providers = providersQuery.data?.providers ?? [];
  const providerNames = new Map(providers.map((p) => [p.id, p.name]));

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Text style={styles.h2}>最近调用</Text>
        <View style={{ flex: 1 }} />
        {query.isFetching && <ActivityIndicator color={theme.colors.foreground} />}
      </View>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <FilterChip label="全部 Provider" active={providerFilter === undefined} theme={theme} styles={styles} onPress={() => setProviderFilter(undefined)} />
        {providers.map((p) => (
          <FilterChip
            key={p.id}
            label={p.name || p.id}
            active={providerFilter === p.id}
            theme={theme}
            styles={styles}
            onPress={() => setProviderFilter(providerFilter === p.id ? undefined : p.id)}
          />
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {([
          ["全部状态", undefined],
          ["成功", "ok"],
          ["失败", "error"],
        ] as const).map(([label, value]) => (
          <FilterChip
            key={label}
            label={label}
            active={statusFilter === value}
            theme={theme}
            styles={styles}
            onPress={() => setStatusFilter(value)}
          />
        ))}
      </View>
      <View style={styles.card}>
        <View style={[styles.tableRow, styles.tableHeader]}>
          <Text style={[styles.tableHeaderCell, { flex: 1.6 }]}>时间</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1.2 }]}>Provider</Text>
          <Text style={[styles.tableHeaderCell, { flex: 1.4 }]}>模型</Text>
          <Text style={[styles.tableHeaderCell, styles.numeric, { flex: 0.8 }]}>状态</Text>
          <Text style={[styles.tableHeaderCell, styles.numeric, { flex: 0.8 }]}>延迟</Text>
          <Text style={[styles.tableHeaderCell, styles.numeric, { flex: 0.8 }]}>Tokens</Text>
        </View>
        {calls.map((c: RecentCall) => <CallRow key={c.id} call={c} theme={theme} styles={styles} />)}
        {calls.length === 0 && <Text style={styles.muted}>暂无调用记录</Text>}
      </View>
      {query.data && (
        <Text style={styles.muted}>
          {providerFilter ? `Provider: ${providerNames.get(providerFilter) ?? providerFilter} · ` : ""}
          {statusFilter ? (statusFilter === "ok" ? "仅成功" : "仅失败") + " · " : ""}
          显示 {calls.length} 条
        </Text>
      )}
    </ScrollView>
  );
}

function CallRow({ call, theme, styles }: { call: RecentCall; theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  const isErr = call.status === "error";
  return (
    <View style={styles.tableRow}>
      <Text style={[styles.tableCell, { flex: 1.6, color: theme.colors.foregroundMuted }]} numberOfLines={1}>
        {formatRelativeTime(call.ts)}
      </Text>
      <Text style={[styles.tableCell, { flex: 1.2 }]} numberOfLines={1}>{call.provider}</Text>
      <Text style={[styles.tableCell, { flex: 1.4 }]} numberOfLines={1}>{call.model}{call.stream ? " · stream" : ""}</Text>
      <Text style={[styles.tableCell, styles.numeric, { flex: 0.8, color: isErr ? theme.colors.statusDanger : theme.colors.statusSuccess }]}>{call.statusCode ?? (isErr ? "—" : "200")}</Text>
      <Text style={[styles.tableCell, styles.numeric, { flex: 0.8 }]}>{formatMs(call.durationMs)}</Text>
      <Text style={[styles.tableCell, styles.numeric, { flex: 0.8 }]}>{formatNumber(call.totalTokens ?? ((call.promptTokens ?? 0) + (call.completionTokens ?? 0)))}</Text>
    </View>
  );
}

function CacheTab({ theme, styles }: { theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  const callStatus = useRpc(cacheStatus);
  const callConfig = useRpc(cacheConfig);
  const callClear = useRpc(cacheClear);
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["cache-status"],
    queryFn: () => callStatus({}),
    refetchInterval: REFRESH_INTERVAL_MS,
  });
  const [enabled, setEnabled] = useState(true);
  const [maxEntries, setMaxEntries] = useState("1024");
  const [ttlSeconds, setTtlSeconds] = useState("300");

  useEffect(() => {
    const s = query.data;
    if (s) {
      setEnabled(s.enabled);
      setMaxEntries(String(s.maxEntries));
    }
  }, [query.data]);

  const config = useMutation({
    mutationFn: (input: { enabled: boolean; maxEntries: number; ttlSeconds: number }) => callConfig(input),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["cache-status"] }); toast.show("已保存", { variant: "success" }); },
  });
  const clear = useMutation({
    mutationFn: () => callClear({}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["cache-status"] }); toast.show("缓存已清空", { variant: "success" }); },
  });

  const status = query.data;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.h2}>响应缓存</Text>
        <Text style={styles.muted}>对非流式、无工具调用、温度 ≥ 0 的请求按 model+messages 哈希缓存。</Text>
        {status && (
          <>
            <View style={[styles.tableRow]}><Text style={[styles.tableCell, { flex: 2 }]}>命中</Text><Text style={[styles.tableCell, styles.numeric]}>{formatNumber(status.hits)}</Text></View>
            <View style={[styles.tableRow]}><Text style={[styles.tableCell, { flex: 2 }]}>未命中</Text><Text style={[styles.tableCell, styles.numeric]}>{formatNumber(status.misses)}</Text></View>
            <View style={[styles.tableRow]}><Text style={[styles.tableCell, { flex: 2 }]}>命中率</Text><Text style={[styles.tableCell, styles.numeric]}>{formatPercent(status.hitRate)}</Text></View>
            <View style={[styles.tableRow]}><Text style={[styles.tableCell, { flex: 2 }]}>当前条目</Text><Text style={[styles.tableCell, styles.numeric]}>{formatNumber(status.entries)} / {formatNumber(status.maxEntries)}</Text></View>
          </>
        )}
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>配置</Text>
        <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.muted}>最大条目</Text>
            <TextInput value={maxEntries} onChangeText={setMaxEntries} keyboardType="number-pad" style={styles.input} placeholderTextColor={theme.colors.foregroundMuted} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.muted}>TTL（秒，0=永久）</Text>
            <TextInput value={ttlSeconds} onChangeText={setTtlSeconds} keyboardType="number-pad" style={styles.input} placeholderTextColor={theme.colors.foregroundMuted} />
          </View>
        </View>
        <Pressable onPress={() => setEnabled(!enabled)} style={{ flexDirection: "row", gap: 8, alignItems: "center", marginTop: 12 }}>
          <View style={[styles.checkbox, { backgroundColor: enabled ? theme.colors.accent : "transparent" }]} />
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>启用缓存</Text>
        </Pressable>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 16 }}>
          <Pressable onPress={() => config.mutate({ enabled, maxEntries: Math.max(0, parseInt(maxEntries, 10) || 0), ttlSeconds: Math.max(0, parseInt(ttlSeconds, 10) || 0) })} style={[styles.primaryBtn, { backgroundColor: theme.colors.accent }]}>
            <Text style={{ color: theme.colors.accentForeground, fontWeight: "600" }}>保存</Text>
          </Pressable>
          <Pressable onPress={() => clear.mutate()} style={[styles.ghostBtn, { borderColor: theme.colors.statusDanger }]}>
            <Text style={{ color: theme.colors.statusDanger, fontWeight: "600" }}>清空缓存</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

function SettingsTab({ theme, styles }: { theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  const callStatus = useRpc(gatewayStatus);
  const callStart = useRpc(gatewayStart);
  const callStop = useRpc(gatewayStop);
  const callClear = useRpc(clearStats);
  const callBootstrap = useRpc(bootstrapAgent);
  const callSyncAgentConfigs = useRpc(syncAgentConfigsRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: () => callStatus({}),
    refetchInterval: 15_000,
  });
  const bootstrapQuery = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => callBootstrap({ includeRaw: false }),
    enabled: !!statusQuery.data?.running,
  });
  const stop = useMutation({ mutationFn: () => callStop({}), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["status"] }); toast.show("已停止", { variant: "info" }); } });
  const start = useMutation({ mutationFn: () => callStart({}), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["status"] }); toast.show("已启动", { variant: "success" }); } });
  const clear = useMutation({ mutationFn: () => callClear({}), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["overview"] }); toast.show("统计已重置", { variant: "info" }); } });
  const syncAgentConfigsMutation = useMutation({
    mutationFn: () => callSyncAgentConfigs({}),
    onSuccess: (data) => {
      const ok = data.pi.ok && data.paseo.ok;
      toast.show(ok ? "已同步 Agent 配置" : "同步部分失败,请检查权限", { variant: ok ? "success" : "warning", durationMs: 3500 });
    },
  });

  const status = statusQuery.data;
  const bootstrap = bootstrapQuery.data;
  const curlSnippet = status?.running
    ? `curl ${status.baseUrl}/v1/models`
    : "（启动网关后生成示例）";

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.h2}>网关状态</Text>
        {status ? (
          <>
            <Row label="状态" value={status.running ? "运行中" : "已停止"} valueColor={status.running ? theme.colors.statusSuccess : theme.colors.statusDanger} theme={theme} styles={styles} />
            <Row label="Base URL" value={status.baseUrl ?? "—"} mono theme={theme} styles={styles} />
            <Row label="PID" value={String(status.pid ?? "—")} theme={theme} styles={styles} />
            <Row label="累计请求" value={formatNumber(status.requests)} theme={theme} styles={styles} />
            <Row label="累计流量" value={`${formatBytes(status.bytesIn)} 入 / ${formatBytes(status.bytesOut)} 出`} theme={theme} styles={styles} />
          </>
        ) : (
          <ActivityIndicator color={theme.colors.foreground} />
        )}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          {status?.running ? (
            <Pressable onPress={() => stop.mutate()} style={[styles.ghostBtn, { borderColor: theme.colors.statusDanger }]}>
              <Text style={{ color: theme.colors.statusDanger, fontWeight: "600" }}>停止网关</Text>
            </Pressable>
          ) : (
            <Pressable onPress={() => start.mutate()} style={[styles.primaryBtn, { backgroundColor: theme.colors.accent }]}>
              <Text style={{ color: theme.colors.accentForeground, fontWeight: "600" }}>启动网关</Text>
            </Pressable>
          )}
        </View>
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>Agent Bootstrap</Text>
        <Text style={styles.muted}>
          一键返回 agent 启动所需全部信息:网关地址 / Provider 列表 / 模型目录(每条附协议与 claiming providers)。
          替代原先手写 Python 脚本去拉 /v1/models 并改写 ~/.pi/agent/models.json 的流程。
        </Text>
        <Text style={styles.muted}>RPC 名称:</Text>
        <Text style={styles.mono}>gateway.agent.bootstrap</Text>
        {bootstrap ? (
          <View style={{ gap: 4, marginTop: 6 }}>
            <Row label="网关" value={`${bootstrap.gateway.baseUrl ?? "—"}`} theme={theme} styles={styles} />
            <Row label="Provider" value={`${bootstrap.providers.length} (启用 ${bootstrap.providers.filter((p) => p.enabled).length})`} theme={theme} styles={styles} />
            <Row label="模型目录" value={`${bootstrap.catalogue.length} 个模型`} theme={theme} styles={styles} />
            <Row
              label="最近同步"
              value={bootstrap.sync.lastSyncAt > 0 ? formatTimeAgo(bootstrap.sync.lastSyncAt) : "尚未同步"}
              theme={theme}
              styles={styles}
            />
          </View>
        ) : (
          <Text style={styles.muted}>{status?.running ? "加载中..." : "启动网关后展示"}</Text>
        )}
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>Paseo Provider 接入</Text>
        <Text style={styles.muted}>将任意 Paseo Model Provider 的 baseUrl 指向下方地址即可走网关：</Text>
        <Text style={styles.mono}>{status?.baseUrl ?? "（未启动）"}</Text>
        <Text style={styles.muted}>模型名直接用 Provider 列表里配置的真实模型名，无需加前缀。</Text>
        <Text style={styles.muted}>可选：请求 body 增加 `provider: "&lt;id&gt;"` 字段强制走指定 Provider。</Text>
        <Text style={[styles.muted, { marginTop: 6 }]}>列出可用模型:</Text>
        <Text style={styles.mono}>{curlSnippet}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>同步 Agent 配置</Text>
        <Text style={styles.muted}>
          自动写入 ~/.pi/agent/models.json 与 ~/.paseo/config.json,让 pi / Codex / Claude 模型下拉里显示
          <Text style={{ fontWeight: "700" }}>[服务商] 模型</Text> 前缀。Provider 改动会自动触发,这里只是手动补刀。
        </Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Pressable
            disabled={syncAgentConfigsMutation.isPending}
            onPress={() => syncAgentConfigsMutation.mutate(undefined)}
            style={[styles.primaryBtn, { backgroundColor: theme.colors.accent, opacity: syncAgentConfigsMutation.isPending ? 0.5 : 1 }]}
          >
            {syncAgentConfigsMutation.isPending ? (
              <ActivityIndicator color={theme.colors.accentForeground} />
            ) : (
              <Text style={{ color: theme.colors.accentForeground, fontWeight: "600" }}>立即同步</Text>
            )}
          </Pressable>
          {syncAgentConfigsMutation.data && (
            <View style={{ flex: 1 }}>
              <Text style={styles.muted}>
                pi {syncAgentConfigsMutation.data.pi.ok ? "✓" : "✗"}
                {syncAgentConfigsMutation.data.pi.ok ? ` ${syncAgentConfigsMutation.data.pi.written ?? 0} 条` : ` ${syncAgentConfigsMutation.data.pi.reason ?? ""}`}
              </Text>
              <Text style={styles.muted}>
                paseo {syncAgentConfigsMutation.data.paseo.ok ? "✓" : "✗"}
                {syncAgentConfigsMutation.data.paseo.ok ? ` ${syncAgentConfigsMutation.data.paseo.written ?? 0} 条` : ` ${syncAgentConfigsMutation.data.paseo.reason ?? ""}`}
              </Text>
            </View>
          )}
        </View>
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>重置统计</Text>
        <Text style={styles.muted}>清空内存环与磁盘上的最近调用日志；小时聚合保留。</Text>
        <Pressable onPress={() => clear.mutate()} style={[styles.ghostBtn, { borderColor: theme.colors.statusWarning, marginTop: 12 }]}>
          <Text style={{ color: theme.colors.statusWarning, fontWeight: "600" }}>清空统计</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function Row({ label, value, valueColor, mono, theme, styles }: { label: string; value: string; valueColor?: string; mono?: boolean; theme: PluginTheme; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 }}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[mono ? styles.mono : null, { color: valueColor ?? theme.colors.foreground, fontSize: mono ? 12 : 13 }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

// ---- Styles --------------------------------------------------------------------

function makeStyles(theme: PluginTheme, compact: boolean) {
  const pad = compact ? 12 : 20;
  const gap = compact ? 8 : 12;
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: pad, gap, paddingBottom: 40 },
    toolbar: { flexDirection: "row" as const, paddingHorizontal: pad, paddingVertical: 12, gap: 8, alignItems: "center" as const },
    syncCard: { padding: 12, gap: 8, marginHorizontal: pad, marginBottom: gap },
    tabBar: { borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingVertical: 6, backgroundColor: theme.colors.surface1 },
    tab: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: theme.colors.border },
    tabActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    tabText: { fontSize: 12, color: theme.colors.foreground },
    tabTextActive: { fontSize: 12, color: theme.colors.accentForeground, fontWeight: "600" as const },
    card: { padding: 14, borderRadius: 10, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, gap: 6 },
    h2: { fontSize: 14, fontWeight: "700" as const, color: theme.colors.foreground },
    muted: { fontSize: 12, color: theme.colors.foregroundMuted },
    mono: { fontFamily: "Menlo", fontSize: 12, color: theme.colors.foreground },
    sparkline: { fontFamily: "Menlo", fontSize: 14, color: theme.colors.foreground, letterSpacing: 1 },
    metricCell: { flexBasis: "30%" as const, flexGrow: 1, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, backgroundColor: theme.colors.surface2, gap: 2, minWidth: 90 },
    metricLabel: { fontSize: 10, color: theme.colors.foregroundMuted, textTransform: "uppercase" as const, fontWeight: "600" as const },
    metricValue: { fontSize: 18, fontWeight: "700" as const, color: theme.colors.foreground },
    tableRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 4 },
    tableHeader: { borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingBottom: 4 },
    tableCell: { fontSize: 12, color: theme.colors.foreground },
    tableHeaderCell: { fontSize: 11, fontWeight: "700" as const, color: theme.colors.foregroundMuted, textTransform: "uppercase" as const },
    numeric: { textAlign: "right" as const },
    pill: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.border },
    pillActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    pillText: { fontSize: 12, color: theme.colors.foreground },
    pillTextActive: { fontSize: 12, color: theme.colors.accentForeground, fontWeight: "600" as const },
    tag: { paddingVertical: 2, paddingHorizontal: 6, borderRadius: 4, backgroundColor: theme.colors.surface2 },
    tagText: { fontSize: 10, color: theme.colors.foreground, fontFamily: "Menlo" },
    tagSub: { paddingVertical: 1, paddingHorizontal: 4, backgroundColor: "transparent", borderWidth: 1, borderColor: theme.colors.border ?? theme.colors.foregroundMuted },
    input: { paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, color: theme.colors.foreground, fontSize: 13, backgroundColor: theme.colors.surface0 },
    checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: theme.colors.border },
    primaryBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, alignItems: "center" as const, justifyContent: "center" as const },
    ghostBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, alignItems: "center" as const, justifyContent: "center" as const },
  };
}

function formatWindow(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.round(minutes / 1440)} 天`;
}

// ---- Shared types (re-declared locally to avoid a server-side import) ---------

interface OverviewStats {
  windowMinutes: number;
  requests: number;
  errors: number;
  errorRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  avgTtfbMs: number;
  p95TtfbMs: number;
  cacheHits: number;
  cacheHitRate: number;
  byProvider: Array<{
    provider: string;
    requests: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    avgDurationMs: number;
  }>;
  byModel: Array<{
    provider: string;
    model: string;
    requests: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    avgDurationMs: number;
  }>;
  timeseries: Array<{
    bucket: number;
    requests: number;
    errors: number;
    tokens: number;
  }>;
}

interface GatewayStatus {
  running: boolean;
  baseUrl: string | null;
  port: number | null;
  host: string;
  startedAt: number | null;
  pid: number | null;
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

interface RecentCall {
  id: string;
  ts: number;
  provider: string;
  model: string;
  endpoint: string;
  status: "ok" | "error";
  statusCode?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
  ttfbMs?: number;
  stream: boolean;
  error?: string;
}


// ---- Helpers -----------------------------------------------------------------

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
  return `${Math.floor(diff / (24 * 60 * 60_000))} 天前`;
}
