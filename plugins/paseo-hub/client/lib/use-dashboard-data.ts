// 集中数据层:workspaces/agents 走 usePaseo() SDK,schedules 走 RPC(调 CLI)。
// 一次 agents.list(includeArchived) 取全量,客户端拆分到 当前/团队/归档 三桶。

import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  controlScheduleRpc,
  inspectScheduleRpc,
  listSchedulesRpc,
  type ScheduleDetail,
  type ScheduleRun,
  type ScheduleSummary,
} from "../../shared/rpc";

// usePaseo() 在本机 @getpaseo/client@0.4.0 下解析为 any(该版本未导出 PaseoApi),
// 故显式定义条目接口(对齐 SDK fetch_agents_response / workspace descriptor 真实字段),
// 在 queryFn 里 cast,避免依赖缺失的导出。
export interface AgentEntry {
  agent: {
    id: string;
    provider: string;
    cwd: string;
    workspaceId?: string;
    model: string | null;
    thinkingOptionId?: string | null;
    createdAt: string;
    updatedAt: string;
    status: "error" | "initializing" | "idle" | "running" | "closed";
    currentModeId: string | null;
    title: string | null;
    labels: Record<string, string>;
    requiresAttention?: boolean;
    attentionReason?: "finished" | "error" | "permission" | null;
    archivedAt?: string | null;
    lastError?: string;
  };
  project: {
    projectKey: string;
    projectName: string;
    workspaceName?: string | null;
  };
}

export interface WorkspaceEntry {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  projectKind: "directory" | "git" | "non_git";
  workspaceKind: "worktree" | "directory" | "checkout" | "local_checkout";
  name: string;
  title?: string | null;
  archivingAt?: string | null;
  status: "running" | "attention" | "needs_input" | "failed" | "done";
  statusEnteredAt?: string | null;
  activityAt: string | null;
  diffStat?: { additions: number; deletions: number } | null;
  gitRuntime?: {
    currentBranch?: string | null;
    remoteUrl?: string | null;
    isDirty?: boolean | null;
  } | null;
}

export type AgentStatus = AgentEntry["agent"]["status"];
export type WsStatus = WorkspaceEntry["status"];

export const SCHEDULE_ID_LABEL = "paseo.schedule-id";

// ---------- query keys ----------
const DASHBOARD = "dashboard" as const;
export const AGENTS_QK = [DASHBOARD, "agents"] as const;
export const WORKSPACES_QK = [DASHBOARD, "workspaces"] as const;
export const SCHEDULES_QK = [DASHBOARD, "schedules"] as const;

// ---------- 读 ----------
export function useAgents() {
  const paseo = usePaseo();
  return useQuery({
    queryKey: AGENTS_QK,
    queryFn: async () => {
      const res = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200 } });
      return res.entries as AgentEntry[];
    },
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

export function useWorkspaces() {
  const paseo = usePaseo();
  return useQuery({
    queryKey: WORKSPACES_QK,
    queryFn: async () => {
      const res = await paseo.workspaces.list({ page: { limit: 200 } });
      return res.entries as WorkspaceEntry[];
    },
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

export function useSchedules() {
  const list = useRpc(listSchedulesRpc);
  return useQuery({
    queryKey: SCHEDULES_QK,
    queryFn: () => list({}),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useScheduleDetail(id: string | null) {
  const inspect = useRpc(inspectScheduleRpc);
  return useQuery({
    queryKey: [DASHBOARD, "schedule", id] as const,
    queryFn: () => inspect({ id: id as string }),
    enabled: !!id,
    staleTime: 10_000,
  });
}

// ---------- 写 ----------
export function useArchiveAgent() {
  const paseo = usePaseo();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => paseo.agents.ref(agentId).archive(),
    onSuccess: () => qc.invalidateQueries({ queryKey: [DASHBOARD] }),
  });
}

export function useArchiveWorkspace() {
  const paseo = usePaseo();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => paseo.workspaces.ref(workspaceId).archive(),
    onSuccess: () => qc.invalidateQueries({ queryKey: [DASHBOARD] }),
  });
}

export function useControlSchedule() {
  const control = useRpc(controlScheduleRpc);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: "pause" | "resume" | "delete" | "run-once" }) =>
      control(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: SCHEDULES_QK }),
  });
}

// ---------- 客户端分组(纯函数) ----------

export interface GroupedAgents {
  current: AgentEntry[]; // 活跃 && 非自动化
  teamAgents: AgentEntry[]; // 活跃 && 带 schedule-id 标签(自动化团队在跑的成员)
  archived: AgentEntry[]; // archivedAt 非空
  attention: AgentEntry[]; // 活跃 && requiresAttention(概览高亮用)
  runningCount: number;
}

function isArchived(e: AgentEntry): boolean {
  return !!e.agent.archivedAt;
}

export function groupAgents(entries: AgentEntry[] | undefined): GroupedAgents {
  const list = entries ?? [];
  const current: AgentEntry[] = [];
  const teamAgents: AgentEntry[] = [];
  const archived: AgentEntry[] = [];
  const attention: AgentEntry[] = [];
  let runningCount = 0;
  for (const e of list) {
    if (isArchived(e)) {
      archived.push(e);
      continue;
    }
    // 活跃
    if (e.agent.status === "running") runningCount++;
    if (e.agent.requiresAttention) attention.push(e);
    if (e.agent.labels?.[SCHEDULE_ID_LABEL]) {
      teamAgents.push(e);
    } else {
      current.push(e);
    }
  }
  // 排序:需处理在前,其次按更新时间倒序
  const byAttention = (a: AgentEntry, b: AgentEntry) => {
    const av = a.agent.requiresAttention ? 1 : 0;
    const bv = b.agent.requiresAttention ? 1 : 0;
    if (av !== bv) return bv - av;
    return (b.agent.updatedAt ?? "").localeCompare(a.agent.updatedAt ?? "");
  };
  current.sort(byAttention);
  teamAgents.sort(byAttention);
  archived.sort((a, b) => (b.agent.archivedAt ?? "").localeCompare(a.agent.archivedAt ?? ""));
  attention.sort((a, b) => (b.agent.updatedAt ?? "").localeCompare(a.agent.updatedAt ?? ""));
  return { current, teamAgents, archived, attention, runningCount };
}

/** team agents 按 schedule-id 分组 */
export function groupTeamBySchedule(
  teamAgents: AgentEntry[],
): { scheduleId: string; agents: AgentEntry[] }[] {
  const map = new Map<string, AgentEntry[]>();
  for (const e of teamAgents) {
    const id = e.agent.labels?.[SCHEDULE_ID_LABEL];
    if (!id) continue;
    const arr = map.get(id) ?? [];
    arr.push(e);
    map.set(id, arr);
  }
  return [...map.entries()].map(([scheduleId, agents]) => ({ scheduleId, agents }));
}

export type { ScheduleSummary, ScheduleDetail, ScheduleRun };
