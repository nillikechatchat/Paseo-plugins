// 共享样式:全部颜色取自 theme.colors,间距取自 layout.compact。
// 复刻 token-tracker 的样式约定。
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import type { TextStyle, ViewStyle } from "react-native";

export interface DashStyles {
  screen: ViewStyle;
  scroll: ViewStyle;
  h1: TextStyle;
  h2: TextStyle;
  muted: TextStyle;
  card: ViewStyle;
  row: ViewStyle;
  col: ViewStyle;
  btn: ViewStyle;
  btnActive: ViewStyle;
  btnDanger: ViewStyle;
  btnText: TextStyle;
  btnTextActive: TextStyle;
  chip: ViewStyle;
  chipActive: ViewStyle;
  chipText: TextStyle;
  chipTextActive: TextStyle;
  badge: TextStyle;
  divider: ViewStyle;
  tabBar: ViewStyle;
  tab: ViewStyle;
  tabActive: ViewStyle;
  tabText: TextStyle;
  tabTextActive: TextStyle;
  kpi: ViewStyle;
  kpiNum: TextStyle;
  kpiLabel: TextStyle;
  title: TextStyle;
  subtitle: TextStyle;
}

export function useDashStyles({ theme, layout }: Pick<PluginSurfaceProps, "theme" | "layout">): DashStyles {
  const c = theme.colors;
  const compact = layout.compact;
  return useMemo<DashStyles>(() => {
    const surface2 = c.surface2 ?? "#00000015";
    return {
      screen: { flex: 1, backgroundColor: c.surface0 },
      scroll: { padding: compact ? 16 : 24, gap: compact ? 12 : 16 },
      h1: { color: c.foreground, fontSize: compact ? 20 : 26, fontWeight: "700" as const },
      h2: { color: c.foreground, fontSize: compact ? 15 : 17, fontWeight: "600" as const, marginTop: 12 },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      card: { backgroundColor: c.surface1 ?? c.surface0, borderRadius: 10, padding: compact ? 12 : 16, gap: 10 },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
      col: { flexDirection: "column" as const },
      btn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: surface2 },
      btnActive: { backgroundColor: c.accent },
      btnDanger: { backgroundColor: c.statusDanger },
      btnText: { color: c.foreground, fontSize: 12 },
      btnTextActive: { color: c.accentForeground, fontSize: 12, fontWeight: "600" as const },
      chip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999, backgroundColor: surface2 },
      chipActive: { backgroundColor: c.accent },
      chipText: { color: c.foregroundMuted, fontSize: 11 },
      chipTextActive: { color: c.accentForeground, fontSize: 11, fontWeight: "600" as const },
      badge: { fontSize: 10, color: c.statusWarning, fontWeight: "600" as const },
      divider: { height: 1, backgroundColor: c.border ?? surface2, marginVertical: 2 },
      tabBar: { flexDirection: "row" as const, gap: 4, paddingHorizontal: compact ? 12 : 20, paddingVertical: 8, backgroundColor: c.surface1 ?? c.surface0, borderBottomWidth: 1, borderBottomColor: c.border ?? surface2 } as ViewStyle,
      tab: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8 },
      tabActive: { backgroundColor: c.accent },
      tabText: { color: c.foregroundMuted, fontSize: 12 },
      tabTextActive: { color: c.accentForeground, fontSize: 12, fontWeight: "600" as const },
      kpi: { backgroundColor: c.surface1 ?? c.surface0, borderRadius: 10, padding: compact ? 10 : 14, gap: 4, flex: 1 } as ViewStyle,
      kpiNum: { color: c.foreground, fontSize: compact ? 22 : 28, fontWeight: "700" as const, fontVariant: ["tabular-nums"] as const },
      kpiLabel: { color: c.foregroundMuted, fontSize: 11 },
      title: { color: c.foreground, fontSize: 13, flex: 1 },
      subtitle: { color: c.foregroundMuted, fontSize: 11 },
    };
  }, [c, compact]);
}
