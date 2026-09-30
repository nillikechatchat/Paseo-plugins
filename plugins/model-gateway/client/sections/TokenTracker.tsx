import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { tokenGetStats, tokenGetPricing, tokenGetCacheStatus, tokenClearCache, tokenRefresh, type TokenStats } from "../../shared/rpc";

// ===== 工具函数 =====

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(n: number): string {
  if (n < 0.01 && n > 0) return `¥${(n * 100).toFixed(1)}分`;
  if (n === 0) return "—";
  if (n < 1) return `¥${n.toFixed(2)}`;
  if (n < 10000) return `¥${n.toFixed(0)}`;
  return `¥${(n / 10000).toFixed(1)}万`;
}

// 给数据点挑颜色(用 hue 旋转)
const PALETTE = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#84cc16"];

function colorFor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

// ===== 图表组件 =====

// 横向堆叠条(展示总成本构成 + 无定价的占比)
function StackedBar({
  segments,
  total,
  c,
}: {
  segments: { value: number; color: string; label?: string }[];
  total: number;
  c: PluginTheme["colors"];
}) {
  if (total === 0) {
    return (
      <View style={{ height: 18, backgroundColor: c.border, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 10, color: c.foregroundMuted }}>无计费数据</Text>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", height: 18, borderRadius: 6, overflow: "hidden" }}>
      {segments.map((s, i) => {
        const pct = (s.value / total) * 100;
        if (pct < 0.5) return null;
        return (
          <View
            key={i}
            style={{ width: `${pct}%`, backgroundColor: s.color, alignItems: "center", justifyContent: "center" }}
          >
            {pct > 6 && <Text style={{ fontSize: 9, color: "#fff", fontWeight: "600" }}>{pct.toFixed(0)}%</Text>}
          </View>
        );
      })}
    </View>
  );
}

// 垂直柱状图(每日成本 / 每模型成本)
function VBarChart({
  data,
  maxValue,
  height = 100,
  c,
}: {
  data: { label: string; value: number; color?: string; highlight?: boolean }[];
  maxValue: number;
  height?: number;
  c: PluginTheme["colors"];
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", height, gap: 3, paddingTop: 4 }}>
      {data.map((d, i) => {
        const pct = maxValue > 0 ? (d.value / maxValue) * 100 : 0;
        return (
          <View key={i} style={{ flex: 1, alignItems: "center", gap: 2 }}>
            <View
              style={{
                width: "100%",
                height: `${Math.max(2, pct)}%`,
                backgroundColor: d.color ?? "#3b82f6",
                opacity: d.highlight ? 1 : 0.6,
                borderRadius: 3,
              }}
            />
            <Text style={{ fontSize: 9, color: c.foregroundMuted }} numberOfLines={1}>{d.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

// Sparkline(用 unicode block 字符)
function Sparkline({ data, height = 4, c }: { data: number[]; height?: number; c: PluginTheme["colors"] }) {
  if (data.length === 0) return null;
  // 每个 block 字符高 8 px 一档,共 8 档
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const max = Math.max(1, ...data);
  const min = Math.min(...data);
  const range = Math.max(1, max - min);
  return (
    <View style={{ height: 22, justifyContent: "center" }}>
      <Text
        style={{
          fontFamily: "monospace",
          fontSize: 20,
          lineHeight: 22,
          color: c.accent,
          letterSpacing: 1,
        }}
        numberOfLines={1}
      >
        {data.map((v) => {
          const idx = Math.round(((v - min) / range) * (blocks.length - 1));
          return blocks[Math.max(0, Math.min(blocks.length - 1, idx))];
        }).join("")}
      </Text>
    </View>
  );
}

// 饼图替代:用 emoji 圆环 + 图例
function DonutLegend({
  segments,
  c,
}: {
  segments: { label: string; value: number; color: string; pct: number }[];
  c: PluginTheme["colors"];
}) {
  if (segments.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      {segments.map((s, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: s.color }} />
          <Text style={{ fontSize: 12, color: c.foreground, flex: 1 }} numberOfLines={1}>
            {s.label}
          </Text>
          <Text style={{ fontSize: 12, color: c.foregroundMuted, fontVariant: ["tabular-nums"] }}>
            {s.pct.toFixed(1)}%
          </Text>
          <Text style={{ fontSize: 12, color: c.foreground, fontWeight: "600", minWidth: 70, textAlign: "right" }}>
            {fmtCost(s.value)}
          </Text>
        </View>
      ))}
    </View>
  );
}

// 移除重复的 zod 定义,从 rpc.ts 引入 ProviderBucket
type ProviderBucketLocal = {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  estimatedCostCNY: number;
  hasPricing: boolean;
  isLocal: boolean;
  isEstimate?: boolean;
  completeness?: "complete" | "partial" | "estimate";
  missingSessions?: number;
  totalSessions?: number;
};

// ===== 主组件 =====

export function TokenTracker({ theme, layout }: PluginSurfaceProps) {
  const c = theme.colors;
  const [sinceDays, setSinceDays] = useState(7);
  const [workspace, setWorkspace] = useState<string>("all");
  const fetchStats = useRpc(tokenGetStats);
  const fetchPricing = useRpc(tokenGetPricing);

  const statsQuery = useQuery({
    queryKey: ["token-stats", sinceDays, workspace],
    queryFn: () => fetchStats({ sinceDays, workspace }),
    refetchInterval: 300_000,  // 5 分钟自动刷新(避免每次都重扫)
    refetchIntervalInBackground: false,
    staleTime: 30_000,        // 30 秒内不重发请求
  });

  const pricingQuery = useQuery({
    queryKey: ["token-pricing"],
    queryFn: () => fetchPricing({}),
    staleTime: 5 * 60_000,
  });

  // 缓存状态(2 秒轮询一次,方便调试感知)
  const fetchCacheStatus = useRpc(tokenGetCacheStatus);
  const fetchClearCache = useRpc(tokenClearCache);
  const fetchRefresh = useRpc(tokenRefresh);
  const queryClient = useQueryClient();
  const cacheStatusQuery = useQuery({
    queryKey: ["token-cache-status"],
    queryFn: () => fetchCacheStatus({}),
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });

  const clearCacheMutation = useMutation({
    mutationFn: () => fetchClearCache({}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["token-stats"] });
      queryClient.invalidateQueries({ queryKey: ["token-cache-status"] });
    },
  });

  // ⭐ 手动刷新:清 statsCache,触发重新聚合(fileRecordCache 仍命中)
  const refreshMutation = useMutation({
    mutationFn: () => fetchRefresh({}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["token-stats"] });
      queryClient.invalidateQueries({ queryKey: ["token-cache-status"] });
    },
  });

  const styles = useMemo(() => {
    const c = theme.colors;
    return {
      screen: { flex: 1, backgroundColor: c.surface0 },
      scroll: { padding: layout.compact ? 16 : 24, gap: layout.compact ? 12 : 16 },
      h1: { color: c.foreground, fontSize: layout.compact ? 20 : 26, fontWeight: "700" as const },
      h2: { color: c.foreground, fontSize: layout.compact ? 15 : 17, fontWeight: "600" as const, marginTop: 12 },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      card: {
        backgroundColor: c.surface1 ?? c.surface0,
        borderRadius: 10,
        padding: layout.compact ? 12 : 16,
        gap: 10,
      },
      big: { color: c.foreground, fontSize: layout.compact ? 28 : 36, fontWeight: "700" as const },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
      btn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surface2 ?? "#00000010" },
      btnActive: { backgroundColor: c.accent },
      btnText: { color: c.foreground, fontSize: 12 },
      btnTextActive: { color: c.accentForeground, fontSize: 12, fontWeight: "600" as const },
      tag: { fontSize: 10, color: c.foregroundMuted },
      warn: { fontSize: 10, color: "#f59e0b" },  // 无定价提醒色
      localTag: { fontSize: 10, color: "#10b981" },  // 本地模型
    };
  }, [theme, layout.compact]);

  const stats: TokenStats | undefined = statsQuery.data;
  const isLoading = statsQuery.isLoading;

  // 派生数据
  const dailyChartData = useMemo(() => {
    if (!stats) return [];
    const days = stats.byDay.slice(-sinceDays);
    return days.map((d) => ({ label: d.date.slice(5), value: d.estimatedCostCNY, color: theme.colors.accent }));
  }, [stats, sinceDays, theme.colors.accent]);

  const dailySparkData = useMemo(() => {
    if (!stats) return [];
    return stats.byDay.map((d) => d.estimatedCostCNY);
  }, [stats]);

  const maxDayCost = useMemo(
    () => (stats ? Math.max(1, ...stats.byDay.map((d) => d.estimatedCostCNY)) : 1),
    [stats],
  );

  // Stacked bar: cost composition across priced models only. Unpriced models
  // are reported as a token count below the bar instead of a made-up ¥
  // segment — an unknown price is not a zero price, and scaling it off the
  // priced total used to invent up to ¥100+ of phantom cost.
  const stackSegments = useMemo(() => {
    if (!stats) return [];
    const segs: { value: number; color: string }[] = [];
    for (const b of stats.byProvider) {
      if (b.hasPricing || b.isLocal) {
        segs.push({ value: b.estimatedCostCNY, color: colorFor(segs.length) });
      }
    }
    return segs;
  }, [stats]);

  // Truthful summary of the pricing gap: tokens and calls with no configured
  // price, plus how much of the window's tokens the ¥ total actually covers.
  const unpricedSummary = useMemo(() => {
    if (!stats) return null;
    const totalTokens = stats.pricedTokens + stats.unpricedTokens;
    const coverage = totalTokens > 0 ? stats.pricedTokens / totalTokens : 1;
    return {
      unpricedTokens: stats.unpricedTokens,
      unpricedCalls: stats.unpricedCalls,
      coverage,
      hasGap: stats.unpricedTokens > 0 || stats.unpricedCalls > 0,
    };
  }, [stats]);

  // Pie chart: priced models only. Unpriced usage is stated in tokens next to
  // the chart (see unpricedSummary) instead of being converted into an
  // invented ¥ slice.
  const donutSegments = useMemo(() => {
    if (!stats) return [];
    const segs: { label: string; value: number; color: string; pct: number }[] = [];
    const totalC = stats.estimatedTotalCostCNY;
    let i = 0;
    for (const b of stats.byProvider) {
      if (b.hasPricing || b.isLocal) {
        const pct = totalC > 0 ? (b.estimatedCostCNY / totalC) * 100 : 0;
        segs.push({
          label: `${b.provider}/${b.model}`,
          value: b.estimatedCostCNY,
          color: colorFor(i++),
          pct,
        });
      }
    }
    return segs;
  }, [stats]);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* 标题 + 当前范围 */}
        <View style={styles.row}>
          <Text style={styles.h1}>Token Tracker</Text>
          <Text style={styles.tag}>
            {workspace === "all" ? "🌐 全局" : `📁 ${workspace}`}
          </Text>
        </View>

        {/* 时间窗口 */}
        <View style={[styles.row, { flexWrap: "wrap" as const, gap: 6 }]}>
          {[1, 7, 30].map((d) => {
            const active = d === sinceDays;
            return (
              <Pressable
                key={d}
                onPress={() => setSinceDays(d)}
                style={[styles.btn, active && styles.btnActive]}
              >
                <Text style={active ? styles.btnTextActive : styles.btnText}>
                  {d === 1 ? "24h" : `${d}d`}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            onPress={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            style={[styles.btn, refreshMutation.isPending && { opacity: 0.5 }]}
          >
            <Text style={styles.btnText}>
              {refreshMutation.isPending ? "⟳ 刷新中..." : "↻ 刷新"}
            </Text>
          </Pressable>
        </View>

        {/* Workspace 过滤器 */}
        {statsQuery.data && statsQuery.data.availableWorkspaces.length > 0 && (
          <View style={{ gap: 4 }}>
            <Text style={styles.muted}>Workspace 范围:</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
              <Pressable
                onPress={() => setWorkspace("all")}
                style={[styles.btn, workspace === "all" && styles.btnActive]}
              >
                <Text style={workspace === "all" ? styles.btnTextActive : styles.btnText}>
                  🌐 全部
                </Text>
              </Pressable>
              {statsQuery.data.availableWorkspaces.map((ws) => (
                <Pressable
                  key={ws}
                  onPress={() => setWorkspace(ws)}
                  style={[styles.btn, workspace === ws && styles.btnActive]}
                >
                  <Text style={workspace === ws ? styles.btnTextActive : styles.btnText}>
                    {ws}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {isLoading && <Text style={styles.muted}>扫描中...</Text>}
        {statsQuery.error && (
          <Text style={[styles.muted, { color: c.statusDanger }]}>错误: {String(statsQuery.error)}</Text>
        )}

        {/* 缓存状态(可点清缓存) */}
        {cacheStatusQuery.data && (
          <View style={[styles.card, { backgroundColor: "transparent", padding: 8 }]}>
            <View style={styles.row}>
              <Text style={[styles.muted, { fontSize: 10 }]}>
                缓存: {cacheStatusQuery.data.memoryEntries} 文件(内存) / {cacheStatusQuery.data.diskEntries} 文件(磁盘,{(cacheStatusQuery.data.diskSizeBytes / 1024).toFixed(0)}KB)
                {refreshMutation.isSuccess && ` · 上次刷新 ${new Date(refreshMutation.data!.scannedAt).toLocaleTimeString("zh-CN")}`}
              </Text>
              <Pressable
                onPress={() => clearCacheMutation.mutate()}
                style={[styles.btn, { paddingVertical: 4, paddingHorizontal: 8 }]}
              >
                <Text style={[styles.btnText, { fontSize: 10 }]}>
                  {clearCacheMutation.isPending ? "..." : "清缓存"}
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {stats && (
          <>
            {/* ===== 总览卡片 ===== */}
            <View style={styles.card}>
              <Text style={styles.muted}>总消耗(最近 {sinceDays} 天)</Text>
              <Text style={styles.big}>{fmtCost(stats.estimatedTotalCostCNY)}</Text>
              {unpricedSummary?.hasGap && (
                <Text style={[styles.muted, { marginTop: 2 }]}>
                  {`仅为已定价部分 · 覆盖 ${(unpricedSummary.coverage * 100).toFixed(0)}% tokens · `}
                  {`未定价 ${fmtTokens(unpricedSummary.unpricedTokens)} tokens / ${unpricedSummary.unpricedCalls} 次调用`}
                </Text>
              )}
              <View style={styles.row}>
                <Text style={styles.muted}>{stats.totalCalls} 次调用</Text>
                <Text style={styles.muted}>
                  {fmtTokens(stats.totalInputTokens)} ↓ / {fmtTokens(stats.totalOutputTokens)} ↑
                </Text>
              </View>
              {(stats.totalCachedTokens > 0 || stats.totalReasoningTokens > 0) && (
                <Text style={styles.muted}>
                  {stats.totalCachedTokens > 0 && `缓存 ${fmtTokens(stats.totalCachedTokens)}  `}
                  {stats.totalReasoningTokens > 0 && `思考 ${fmtTokens(stats.totalReasoningTokens)}`}
                </Text>
              )}

              {/* 堆叠条:成本构成(仅已定价模型;未定价以 token 数列示,不折算金额) */}
              <View style={{ marginTop: 4 }}>
                <StackedBar
                  c={c}
                  segments={stackSegments}
                  total={Math.max(stats.estimatedTotalCostCNY, stackSegments.reduce((s, x) => s + x.value, 0))}
                />
                {unpricedSummary?.hasGap && (
                  <Text style={[styles.muted, { fontSize: 10, marginTop: 2 }]}>
                    {`未定价(不计入金额): ${fmtTokens(unpricedSummary.unpricedTokens)} tokens · ${unpricedSummary.unpricedCalls} 次调用`}
                  </Text>
                )}
              </View>
            </View>

            {/* ===== 每日趋势(柱状图) ===== */}
            {dailyChartData.length > 0 && (
              <>
                <Text style={styles.h2}>每日成本走势</Text>
                <View style={styles.card}>
                  <VBarChart c={c} data={dailyChartData} maxValue={maxDayCost} height={110} />
                  {dailySparkData.length > 2 && (
                    <>
                      <Text style={[styles.muted, { marginTop: 4 }]}>近 {dailySparkData.length} 天 sparkline:</Text>
                      <Sparkline c={c} data={dailySparkData} />
                    </>
                  )}
                </View>
              </>
            )}

            {/* ===== Workspace 拆分(仅在 all 模式下显示) ===== */}
            {workspace === "all" && stats.byWorkspace.length > 1 && (
              <>
                <Text style={styles.h2}>按 Workspace</Text>
                <View style={styles.card}>
                  <VBarChart
                    c={c}
                    data={stats.byWorkspace.map((w, i) => ({
                      label: w.workspace.length > 8 ? w.workspace.slice(0, 7) + "…" : w.workspace,
                      value: w.estimatedCostCNY,
                      color: colorFor(i),
                      highlight: w.estimatedCostCNY > 0,
                    }))}
                    maxValue={Math.max(1, ...stats.byWorkspace.map((w) => w.estimatedCostCNY))}
                    height={100}
                  />
                </View>
              </>
            )}

            {/* ===== Provider / 模型拆分 ===== */}
            {stats.byProvider.length > 0 && (
              <>
                <Text style={styles.h2}>按 Provider / 模型</Text>

                {/* 柱状图(按 token 总数排序) */}
                <View style={styles.card}>
                  <VBarChart
                    c={c}
                    data={stats.byProvider
                      .map((b, i) => ({
                        label: `${b.model.slice(0, 8)}${b.model.length > 8 ? "…" : ""}`,
                        value: b.inputTokens + b.outputTokens,
                        color: colorFor(i),
                        highlight: b.hasPricing || b.isLocal,
                      }))
                      .sort((a, b) => b.value - a.value)
                      .slice(0, 10)}
                    maxValue={Math.max(1, ...stats.byProvider.map((b) => b.inputTokens + b.outputTokens))}
                    height={120}
                  />
                </View>

                {/* 饼图图例(按成本) */}
                {donutSegments.length > 0 && (
                  <View style={styles.card}>
                    <Text style={[styles.muted, { marginBottom: 4 }]}>成本构成(已定价模型)</Text>
                    <DonutLegend c={c} segments={donutSegments} />
                    {unpricedSummary?.hasGap && (
                      <Text style={[styles.muted, { fontSize: 10, marginTop: 4 }]}>
                        {`未定价模型 ${fmtTokens(unpricedSummary.unpricedTokens)} tokens / ${unpricedSummary.unpricedCalls} 次调用未计入(见下方「无定价」标签)`}
                      </Text>
                    )}
                  </View>
                )}

                {/* 详细列表 */}
                <View style={styles.card}>
                  {stats.byProvider.map((b, i) => (
                    <View key={`${b.provider}-${b.model}`} style={{ gap: 4 }}>
                      <View style={styles.row}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: colorFor(i) }} />
                          <Text style={{ color: theme.colors.foreground, fontSize: 13 }} numberOfLines={1}>
                            {b.provider} · {b.model}
                          </Text>
                          {b.isLocal && <Text style={styles.localTag}>本地</Text>}
                          {b.isEstimate && !b.isLocal && <Text style={styles.warn}>估算</Text>}
                          {!b.hasPricing && !b.isLocal && !b.isEstimate && <Text style={styles.warn}>无定价</Text>}
                          {b.completeness === "partial" && <Text style={styles.warn}>⚠️ 部分</Text>}
                        </View>
                        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                          {fmtCost(b.estimatedCostCNY)}
                        </Text>
                      </View>
                      <View style={styles.row}>
                        <Text style={styles.tag}>{b.calls} calls</Text>
                        <Text style={styles.tag}>
                          {fmtTokens(b.inputTokens)} ↓ / {fmtTokens(b.outputTokens)} ↑
                        </Text>
                      </View>
                      {i < stats.byProvider.length - 1 && (
                        <View style={{ height: 1, backgroundColor: c.border, marginVertical: 2 }} />
                      )}
                    </View>
                  ))}
                </View>
              </>
            )}

            <Text style={styles.muted}>
              扫描 {stats.filesScanned} 个日志文件 ·{" "}
              {new Date(stats.lastScannedAt).toLocaleString("zh-CN")}
              {workspace !== "all" && ` · 仅显示 ${workspace} 范围`}
            </Text>
          </>
        )}

        {pricingQuery.data && (
          <Text style={styles.muted}>
            定价表: {Object.keys(pricingQuery.data.pricing).length} 个模型 ·{" "}
            最后更新 {new Date(pricingQuery.data.lastUpdated).toLocaleTimeString("zh-CN")}
            {"\n"}未定价模型可通过 ~/.paseo/config.json 的 plugins.tokenTracker.pricing 补充(¥/1M tokens)
          </Text>
        )}
      </ScrollView>
    </View>
  );
}