import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// ⚠️ RPC name regex: /^[a-z][a-z0-9._-]*$/ (all lowercase kebab-case)

// ==================== AIHOT News ====================

const aihotCategory = z.enum(["ai-models", "ai-products", "industry", "paper", "tip"]);

const aihotItem = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  sourceName: z.string().optional(),
  originalUrl: z.string().optional(),
  aihotUrl: z.string().optional(),
  publishedAt: z.string().optional(),
  category: z.string().optional(),
  score: z.number().nullable().optional(),
  selected: z.boolean().optional(),
  reason: z.string().optional(),
});

export const latest = defineRpc({
  name: "aihot.latest",
  input: z.object({
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().optional(),
    category: aihotCategory.optional(),
  }),
  output: z.object({
    items: z.array(aihotItem),
    cursor: z.string().nullable().optional(),
    hasMore: z.boolean().optional(),
  }),
});

const aihotTopic = z.object({
  rank: z.number(),
  title: z.string(),
  sourceName: z.string().optional(),
  originalUrl: z.string().optional(),
  aihotUrl: z.string().optional(),
  storyUrl: z.string().optional(),
  sourceCount: z.number().optional(),
  signalCount: z.number().optional(),
  sourceNames: z.array(z.string()).optional(),
  latestAt: z.string().optional(),
});

export const hotTopics = defineRpc({
  name: "aihot.hot-topics",
  input: z.object({}),
  output: z.object({ items: z.array(aihotTopic) }),
});

const dailySchema = z.object({
  date: z.string(),
  generatedAt: z.string().optional(),
  aihotUrl: z.string().optional(),
  lead: z.string().nullable().optional(),
  sections: z.array(
    z.object({
      label: z.string(),
      items: z.array(z.object({ title: z.string(), summary: z.string().optional() })),
    }),
  ),
});

export const dailyLatest = defineRpc({
  name: "aihot.daily-latest",
  input: z.object({}),
  output: dailySchema,
});

// ==================== Schedules (Dashboard) ====================

export const ScheduleSummary = z.object({
  id: z.string(),
  name: z.string(),
  cadence: z.string(),
  target: z.string(),
  status: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummary>;

const ScheduleRun = z.record(z.string(), z.unknown());
export type ScheduleRun = z.infer<typeof ScheduleRun>;

export const ScheduleDetail = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  cadence: z.object({ type: z.string(), expression: z.string(), timezone: z.string().nullable() }),
  target: z.object({ type: z.string(), config: z.record(z.string(), z.unknown()) }),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxRuns: z.number().int().nullable(),
  runs: z.array(ScheduleRun),
});
export type ScheduleDetail = z.infer<typeof ScheduleDetail>;

export const listSchedulesRpc = defineRpc({
  name: "list-schedules",
  input: z.object({}),
  output: z.object({ schedules: z.array(ScheduleSummary) }),
});

export const inspectScheduleRpc = defineRpc({
  name: "inspect-schedule",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ schedule: ScheduleDetail }),
});

export const controlScheduleRpc = defineRpc({
  name: "control-schedule",
  input: z.object({
    id: z.string().min(1),
    action: z.enum(["pause", "resume", "delete", "run-once"]),
  }),
  output: z.object({ ok: z.boolean(), message: z.string(), schedule: ScheduleSummary.optional() }),
});

// ==================== Server Guard ====================

export const BanRecord = z.object({
  ip: z.string(),
  ts: z.number().int().nonnegative(),
  reason: z.string(),
  attackType: z.string(),
});
export type BanRecord = z.infer<typeof BanRecord>;

export const GuardEvent = z.object({
  ts: z.number().int().nonnegative(),
  ip: z.string(),
  attackType: z.string(),
  severity: z.number().int().nonnegative(),
  source: z.string(),
  detail: z.string(),
});
export type GuardEvent = z.infer<typeof GuardEvent>;

export const GuardStatus = z.object({
  serviceActive: z.boolean(),
  dryRun: z.boolean(),
  ipsetEntries: z.number().int().nonnegative(),
  dbBans: z.number().int().nonnegative(),
  firewallAvailable: z.boolean(),
  events24h: z.number().int().nonnegative(),
  uptimeSeconds: z.number().int().nonnegative(),
});
export type GuardStatus = z.infer<typeof GuardStatus>;

export const getGuardStatusRpc = defineRpc({
  name: "get-guard-status",
  input: z.object({}),
  output: GuardStatus,
});

export const listBansRpc = defineRpc({
  name: "list-bans",
  input: z.object({
    limit: z.number().int().positive().max(1000).default(100),
    offset: z.number().int().nonnegative().default(0),
  }),
  output: z.object({ bans: z.array(BanRecord), total: z.number().int().nonnegative() }),
});

export const banIpRpc = defineRpc({
  name: "ban-ip",
  input: z.object({ ip: z.string().min(1), reason: z.string().default("manual") }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const unbanIpRpc = defineRpc({
  name: "unban-ip",
  input: z.object({ ip: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const listEventsRpc = defineRpc({
  name: "list-events",
  input: z.object({
    limit: z.number().int().positive().max(500).default(50),
    attackType: z.string().optional(),
  }),
  output: z.object({ events: z.array(GuardEvent) }),
});

export const topAttackersRpc = defineRpc({
  name: "top-attackers",
  input: z.object({
    sinceHours: z.number().int().positive().max(720).default(24),
    limit: z.number().int().positive().max(100).default(20),
  }),
  output: z.object({
    items: z.array(z.object({
      ip: z.string(), count: z.number().int().nonnegative(), maxSeverity: z.number().int().nonnegative(),
    })),
  }),
});

export const DataSecurityStats = z.object({
  total: z.number().int().nonnegative(),
  events24h: z.number().int().nonnegative(),
  fileIntegrityChanges: z.number().int().nonnegative(),
  fileMetadataChanges: z.number().int().nonnegative(),
  byCategory: z.record(z.string(), z.number().int().nonnegative()),
  recentEvents: z.array(z.object({
    ts: z.number().int().nonnegative(), ip: z.string(), attackType: z.string(), detail: z.string(),
  })),
});
export type DataSecurityStats = z.infer<typeof DataSecurityStats>;

export const getDataSecurityStatsRpc = defineRpc({
  name: "get-data-security-stats",
  input: z.object({}),
  output: DataSecurityStats,
});

export const listDataEventsRpc = defineRpc({
  name: "list-data-events",
  input: z.object({
    limit: z.number().int().positive().max(500).default(50),
    category: z.string().optional(),
  }),
  output: z.object({ events: z.array(GuardEvent) }),
});

export const SystemSnapshot = z.object({
  ts: z.number().int().nonnegative(),
  hostname: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  cpuCores: z.number().int().positive(),
  load: z.object({ min1: z.number(), min5: z.number(), min15: z.number() }),
  memory: z.object({
    totalBytes: z.number().int().nonnegative(), usedBytes: z.number().int().nonnegative(),
    availableBytes: z.number().int().nonnegative(), swapTotalBytes: z.number().int().nonnegative(),
    swapUsedBytes: z.number().int().nonnegative(),
  }),
  disks: z.array(z.object({
    mount: z.string(), totalBytes: z.number().int().nonnegative(),
    usedBytes: z.number().int().nonnegative(), usePercent: z.number(),
  })),
  psi: z.object({ ioSome: z.number(), memSome: z.number(), cpuSome: z.number() }).optional(),
  topProcs: z.array(z.object({ pid: z.number().int().positive(), command: z.string(), cpuPercent: z.number(), memMb: z.number() })),
  dStateCount: z.number().int().nonnegative(),
  zombieCount: z.number().int().nonnegative(),
});
export type SystemSnapshot = z.infer<typeof SystemSnapshot>;

export const getSystemSnapshotRpc = defineRpc({
  name: "get-system-snapshot",
  input: z.object({}),
  output: SystemSnapshot,
});

export const AgentProcs = z.object({
  ts: z.number().int().nonnegative(),
  groups: z.array(z.object({
    name: z.string(), count: z.number().int().nonnegative(), totalMemMb: z.number(), pids: z.array(z.number().int().positive()),
  })),
});
export type AgentProcs = z.infer<typeof AgentProcs>;

export const getAgentProcsRpc = defineRpc({
  name: "get-agent-procs",
  input: z.object({}),
  output: AgentProcs,
});
