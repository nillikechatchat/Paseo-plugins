// 格式化与状态色工具。色值一律取自 theme.colors,不硬编码前景色。
import type { PluginTheme } from "@getpaseo/plugin";

type AgentStatus = "initializing" | "idle" | "running" | "error" | "closed";
type WsStatus = "running" | "attention" | "needs_input" | "failed" | "done";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 相对时间:"3 分钟前" / "刚刚" / "2 天前" */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) return "即将";
  if (diff < MIN) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

/** 绝对短时间:"09-04 20:02" */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** agent 状态 → 主题色 */
export function agentStatusColor(status: AgentStatus, c: PluginTheme["colors"]): string {
  switch (status) {
    case "running":
      return c.accent;
    case "idle":
      return c.foregroundMuted;
    case "initializing":
      return c.statusWarning;
    case "error":
      return c.statusDanger;
    case "closed":
      return c.foregroundMuted;
  }
}

/** agent 状态中文标签 */
export function agentStatusLabel(status: AgentStatus): string {
  return { running: "运行中", idle: "空闲", initializing: "启动中", error: "错误", closed: "已结束" }[status];
}

/** workspace 状态 → 主题色 */
export function wsStatusColor(status: WsStatus, c: PluginTheme["colors"]): string {
  switch (status) {
    case "running":
      return c.accent;
    case "attention":
      return c.statusWarning;
    case "needs_input":
      return c.statusWarning;
    case "failed":
      return c.statusDanger;
    case "done":
      return c.statusSuccess;
  }
}

export function wsStatusLabel(status: WsStatus): string {
  return { running: "运行", attention: "待处理", needs_input: "需输入", failed: "失败", done: "完成" }[status];
}

/** attentionReason 中文 */
export function attentionLabel(reason: string | null | undefined): string {
  if (!reason) return "需处理";
  return { finished: "已完成", error: "出错", permission: "待授权" }[reason] ?? "需处理";
}

/** provider/model 简写:codex/gpt-5.4 → "gpt-5.4" */
export function shortModel(provider: string, model: string | null): string {
  if (!model) return provider;
  return model;
}

/** workspaceKind 中文 */
export function wsKindLabel(kind: string): string {
  return ({ worktree: "worktree", directory: "目录", checkout: "checkout", local_checkout: "本地检出" } as Record<string, string>)[kind] ?? kind;
}

/** diffStat 简写 */
export function diffStat(d: { additions: number; deletions: number } | null | undefined): string {
  if (!d) return "—";
  return `+${d.additions} / -${d.deletions}`;
}
