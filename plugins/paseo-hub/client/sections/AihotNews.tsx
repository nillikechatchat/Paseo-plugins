import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View, type TextStyle } from "react-native";
import { dailyLatest, hotTopics, latest } from "../../shared/rpc";

type Category = "ai-models" | "ai-products" | "industry" | "paper" | "tip";

const CATEGORIES: { key: Category; label: string }[] = [
  { key: "ai-models", label: "模型" },
  { key: "ai-products", label: "产品" },
  { key: "industry", label: "行业" },
  { key: "paper", label: "论文" },
  { key: "tip", label: "技巧" },
];

const TABS = [
  { key: "latest", label: "最新" },
  { key: "hot", label: "热点" },
  { key: "daily", label: "日报" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function timeAgo(iso?: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function openUrl(url?: string) {
  if (url) void Linking.openURL(url);
}

export function AihotNews({ theme, layout }: PluginSurfaceProps) {
  const [tab, setTab] = useState<TabKey>("latest");
  const [category, setCategory] = useState<Category | undefined>(undefined);
  const compact = layout.compact;
  const pad = compact ? 12 : 20;
  const gap = compact ? 8 : 12;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: pad, gap, paddingBottom: 32 },
      tabs: { flexDirection: "row" as const, gap: 4, flexWrap: "wrap" as const },
      tab: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 },
      tabActive: { backgroundColor: theme.colors.accent },
      chips: { flexDirection: "row" as const, gap: 6, flexWrap: "wrap" as const },
      chip: {
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      chipActive: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.foreground },
      card: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        gap: 6,
      },
      cardRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      rank: {
        width: 22,
        height: 22,
        borderRadius: 11,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.accent,
      },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      summary: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      reason: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 16,
        fontStyle: "italic" as const,
      },
      footer: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 15 },
      btn: {
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        alignItems: "center" as const,
      },
      btnText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      empty: { color: theme.colors.foregroundMuted, fontSize: 12, paddingVertical: 8 },
      error: { color: theme.colors.statusDanger, fontSize: 12, paddingVertical: 8 },
    }),
    [theme, pad, gap],
  );

  // hooks 必须无条件调用，三个 tab 的数据在此统一拉取
  const fetchLatest = useRpc(latest);
  const fetchHot = useRpc(hotTopics);
  const fetchDaily = useRpc(dailyLatest);

  const latestQ = useInfiniteQuery({
    queryKey: ["aihot", "latest", category ?? "all"] as const,
    queryFn: ({ pageParam }) => fetchLatest({ limit: 20, category, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore && last.cursor ? last.cursor : undefined),
    staleTime: 60_000,
  });
  const hotQ = useQuery({
    queryKey: ["aihot", "hot"] as const,
    queryFn: () => fetchHot({}),
    staleTime: 60_000,
  });
  const dailyQ = useQuery({
    queryKey: ["aihot", "daily"] as const,
    queryFn: () => fetchDaily({}),
    staleTime: 60_000,
  });

  const latestItems = latestQ.data?.pages.flatMap((p) => p.items) ?? [];
  const hotItems = hotQ.data?.items ?? [];
  const daily = dailyQ.data;

  const accentText = (active: boolean): TextStyle => ({
    color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted,
    fontSize: 13,
    fontWeight: active ? "700" : "600",
  });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            accessibilityRole="button"
            onPress={() => setTab(t.key)}
            style={[styles.tab, tab === t.key ? styles.tabActive : null]}
          >
            <Text style={accentText(tab === t.key)}>{t.label}</Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (tab === "latest") latestQ.refetch();
            else if (tab === "hot") hotQ.refetch();
            else dailyQ.refetch();
          }}
          style={styles.tab}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>↻</Text>
        </Pressable>
      </View>

      {tab === "latest" && (
        <View style={{ gap }}>
          <View style={styles.chips}>
            <Pressable
              onPress={() => setCategory(undefined)}
              style={[styles.chip, category === undefined ? styles.chipActive : null]}
            >
              <Text style={accentText(category === undefined)}>全部</Text>
            </Pressable>
            {CATEGORIES.map((c) => (
              <Pressable
                key={c.key}
                onPress={() => setCategory(c.key)}
                style={[styles.chip, category === c.key ? styles.chipActive : null]}
              >
                <Text style={accentText(category === c.key)}>{c.label}</Text>
              </Pressable>
            ))}
          </View>

          {latestQ.isPending && <ActivityIndicator color={theme.colors.accent} />}
          {latestQ.error && (
            <Text style={styles.error}>加载失败：{latestQ.error.message}</Text>
          )}

          {latestItems.map((it) => (
            <Pressable key={it.id} style={styles.card} onPress={() => openUrl(it.originalUrl ?? it.aihotUrl)}>
              <Text style={styles.title}>{it.title}</Text>
              {it.summary ? <Text style={styles.summary} numberOfLines={4}>{it.summary}</Text> : null}
              {it.reason ? <Text style={styles.reason} numberOfLines={2}>{it.reason}</Text> : null}
              <View style={styles.cardRow}>
                {it.score != null && (
                  <Text style={styles.meta}>★ {it.score}</Text>
                )}
                {it.sourceName && (
                  <Text style={styles.meta} numberOfLines={1}>{it.sourceName}</Text>
                )}
                {timeAgo(it.publishedAt) && (
                  <Text style={styles.meta}>{timeAgo(it.publishedAt)}</Text>
                )}
              </View>
            </Pressable>
          ))}

          {latestItems.length === 0 && !latestQ.isPending && !latestQ.error && (
            <Text style={styles.empty}>暂无内容</Text>
          )}

          {latestQ.hasNextPage && (
            <Pressable
              onPress={() => latestQ.fetchNextPage()}
              disabled={latestQ.isFetchingNextPage}
              style={styles.btn}
            >
              {latestQ.isFetchingNextPage ? (
                <ActivityIndicator color={theme.colors.foreground} />
              ) : (
                <Text style={styles.btnText}>加载更多</Text>
              )}
            </Pressable>
          )}
        </View>
      )}

      {tab === "hot" && (
        <View style={{ gap }}>
          {hotQ.isPending && <ActivityIndicator color={theme.colors.accent} />}
          {hotQ.error && <Text style={styles.error}>加载失败：{hotQ.error.message}</Text>}
          {hotItems.map((t) => (
            <Pressable key={t.rank} style={styles.card} onPress={() => openUrl(t.originalUrl ?? t.aihotUrl)}>
              <View style={styles.cardRow}>
                <View style={styles.rank}>
                  <Text style={styles.btnText}>{t.rank}</Text>
                </View>
                <Text style={[styles.title, { flex: 1 }]}>{t.title}</Text>
              </View>
              <View style={styles.cardRow}>
                {t.sourceCount != null && <Text style={styles.meta}>{t.sourceCount} 源</Text>}
                {t.signalCount != null && <Text style={styles.meta}>{t.signalCount} 信号</Text>}
                {timeAgo(t.latestAt) && <Text style={styles.meta}>{timeAgo(t.latestAt)}</Text>}
              </View>
              {t.sourceNames && t.sourceNames.length > 0 && (
                <Text style={styles.summary} numberOfLines={2}>{t.sourceNames.join(" · ")}</Text>
              )}
            </Pressable>
          ))}
          {hotItems.length === 0 && !hotQ.isPending && !hotQ.error && (
            <Text style={styles.empty}>暂无内容</Text>
          )}
        </View>
      )}

      {tab === "daily" && (
        <View style={{ gap }}>
          {dailyQ.isPending && <ActivityIndicator color={theme.colors.accent} />}
          {dailyQ.error && <Text style={styles.error}>加载失败：{dailyQ.error.message}</Text>}
          {daily && (
            <View style={{ gap }}>
              <Pressable style={styles.card} onPress={() => openUrl(daily.aihotUrl)}>
                <Text style={styles.meta}>{daily.date} · AIHOT 日报</Text>
                {daily.lead ? <Text style={styles.title}>{daily.lead}</Text> : null}
              </Pressable>
              {daily.sections.map((s, si) => (
                <View key={si} style={styles.card}>
                  <Text style={[styles.title, { fontSize: 13 }]}>{s.label}</Text>
                  {s.items.map((it, ii) => (
                    <View key={ii} style={{ gap: 2 }}>
                      <Text style={styles.summary}>{it.title}</Text>
                      {it.summary ? (
                        <Text style={styles.summary} numberOfLines={3}>{it.summary}</Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              ))}
            </View>
          )}
          {!daily && !dailyQ.isPending && !dailyQ.error && (
            <Text style={styles.empty}>暂无日报</Text>
          )}
        </View>
      )}

      <Text style={styles.footer}>
        摘要由 AI 生成，引用数字/政策/原话前请用原文 URL 复核 · 数据来自 AIHOT（卡兹克）
      </Text>
    </ScrollView>
  );
}
