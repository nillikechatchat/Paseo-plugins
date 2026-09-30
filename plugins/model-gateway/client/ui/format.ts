// Shared formatting helpers. Keep them dependency-free so they survive React
// Native's strict bundler rules.

import type { PluginTheme } from "@getpaseo/plugin";

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + "k";
  if (Math.abs(n) < 1) return n.toFixed(3);
  return Math.round(n).toLocaleString();
}

export function formatPercent(p: number): string {
  if (!Number.isFinite(p)) return "—";
  return (p * 100).toFixed(1) + "%";
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1) return ms.toFixed(2) + " ms";
  if (ms < 1000) return ms.toFixed(0) + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

export function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(n < 10 ? 2 : 1) + " " + units[i];
}

export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 1000) return "刚刚";
  if (diff < 60_000) return Math.floor(diff / 1000) + " 秒前";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + " 分钟前";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " 小时前";
  return Math.floor(diff / 86_400_000) + " 天前";
}

export function formatAbsoluteTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function sparklineBars(values: number[], max: number, count: number, theme: PluginTheme): { bar: string; color: string }[] {
  if (values.length === 0) return [];
  const buckets: number[] = new Array(count).fill(0);
  const step = values.length / count;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = start; j < end && j < values.length; j++) sum += values[j];
    buckets[i] = sum;
  }
  const peak = Math.max(max, 1);
  return buckets.map((v) => {
    const ratio = Math.min(1, v / peak);
    const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const idx = Math.min(blocks.length - 1, Math.floor(ratio * blocks.length));
    return { bar: blocks[idx], color: ratio > 0.8 ? theme.colors.statusDanger : ratio > 0.5 ? theme.colors.statusWarning : theme.colors.statusSuccess };
  });
}
