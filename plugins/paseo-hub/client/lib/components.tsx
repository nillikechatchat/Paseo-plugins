// 小型共享组件。色值均来自调用方传入的 theme/样式。
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { DashStyles } from "./styles";

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
  );
}

export function Empty({ styles, text }: { styles: DashStyles; text: string }) {
  return <Text style={[styles.muted, { textAlign: "center" as const, paddingVertical: 16 }]}>{text}</Text>;
}

export function Pill({
  styles,
  active,
  label,
  onPress,
}: {
  styles: DashStyles;
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={active ? styles.chipTextActive : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

export function SectionHeader({ styles, title, right }: { styles: DashStyles; title: string; right?: ReactNode }) {
  return (
    <View style={[styles.row, { marginTop: 4 }]}>
      <Text style={styles.h2}>{title}</Text>
      {right}
    </View>
  );
}
