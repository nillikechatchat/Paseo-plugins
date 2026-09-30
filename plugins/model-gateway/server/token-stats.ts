// 服务端:解析 Codex + Claude Code 日志,聚合 token 用量
// 在 daemon 进程内运行,有完整文件系统访问权限

import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import * as path from "node:path";
import { homedir } from "node:os";
import type { TokenStats as Stats, TokenUsageRecord as UsageRecord, TokenProviderBucket as ProviderBucket, TokenDailyBucket as DailyBucket } from "../shared/rpc";

type ModelPricing = {
  inputPerMTokCNY: number;
  outputPerMTokCNY: number;
  cachedInputPerMTokCNY?: number;
  isLocal?: boolean;
  note?: string;
};

// ============================================================
// 性能优化:模块级缓存
// ============================================================

// pricing 缓存(进程内,只 load 一次)
let pricingCache: { data: Record<string, ModelPricing>; ts: number } | null = null;
const PRICING_TTL_MS = 5 * 60 * 1000;

// stats 缓存(按 sinceDays + workspace 索引)
type CacheKey = string;
type CacheEntry = { stats: Stats; records: UsageRecord[]; filesScanned: number; maxMtime: number };
const statsCache = new Map<CacheKey, CacheEntry>();
const STATS_TTL_MS = 60 * 1000;

// 文件 mtime 指纹:跟踪所有被扫过的文件最新 mtime
const fileFingerprint = new Map<string, number>();

// ⭐ 二级优化:per-file 解析缓存
// 路径 → { mtime, records }
// 如果 mtime 没变,直接复用 records,跳过逐行解析
type FileEntry = { mtime: number; records: UsageRecord[] };
const fileRecordCache = new Map<string, FileEntry>();

// ⭐ 二级优化:磁盘持久化缓存
// 写到 ~/.paseo/cache/token-tracker-cache.json
// 包含每文件的 mtime + 预解析的 records
// 插件重启后立即可用
const DISK_CACHE_PATH = path.join(homedir(), ".paseo", "cache", "token-tracker-cache.json");
const DISK_CACHE_VERSION = 1;

// 在 walking 时记录本轮涉及的所有文件的最大 mtime,用于缓存失效判断
let currentMaxMtime = 0;

function cacheKey(sinceDays: number, workspace?: string): CacheKey {
  return `${sinceDays}::${workspace ?? "all"}`;
}

// 默认定价(¥ / 1M tokens)。用户可通过 ~/.paseo/config.json 里的 plugins.tokenTracker.th 覆盖。
// ⚠️ 这些是估算值,实际定价以服务商为准。本地模型 isLocal=true 不计费。
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Minimax 系列(基于 MiniMax Token Plan)
  "MiniMax-M3":     { inputPerMTokCNY: 1.5, outputPerMTokCNY: 6.0,  cachedInputPerMTokCNY: 0.3, note: "1M context,thinking 计费" },
  "Minimax-m3":     { inputPerMTokCNY: 1.5, outputPerMTokCNY: 6.0,  cachedInputPerMTokCNY: 0.3 },
  "MiniMax-M2.7":   { inputPerMTokCNY: 1.2, outputPerMTokCNY: 4.8,  cachedInputPerMTokCNY: 0.24 },
  "MiniMax-M2.5":   { inputPerMTokCNY: 0.8, outputPerMTokCNY: 3.2,  cachedInputPerMTokCNY: 0.16 },
  "MiniMax-M2.5-highspeed": { inputPerMTokCNY: 0.4, outputPerMTokCNY: 1.6, cachedInputPerMTokCNY: 0.08 },
  "MiniMax-M2.7-highspeed": { inputPerMTokCNY: 0.6, outputPerMTokCNY: 2.4, cachedInputPerMTokCNY: 0.12 },
  "MiniMax-M2.1":   { inputPerMTokCNY: 0.5, outputPerMTokCNY: 2.0,  cachedInputPerMTokCNY: 0.10 },
  "MiniMax-M2.1-highspeed": { inputPerMTokCNY: 0.25, outputPerMTokCNY: 1.0, cachedInputPerMTokCNY: 0.05 },
  "MiniMax-M2":     { inputPerMTokCNY: 0.3, outputPerMTokCNY: 1.2,  cachedInputPerMTokCNY: 0.06 },
  // Agnes / older
  "agnes-2.5-flash":{ inputPerMTokCNY: 0.1, outputPerMTokCNY: 0.2,  note: "Flash,极便宜" },
  // Zhipu GLM
  "glm-5.2":        { inputPerMTokCNY: 2.0, outputPerMTokCNY: 8.0,  note: "thinking=max 计费高" },
  "glm-5.1":        { inputPerMTokCNY: 1.8, outputPerMTokCNY: 7.2 },
  "glm-5-turbo":    { inputPerMTokCNY: 0.8, outputPerMTokCNY: 3.2 },
  "glm-4.7":        { inputPerMTokCNY: 1.0, outputPerMTokCNY: 4.0 },
  "glm-4.5-air":    { inputPerMTokCNY: 0.3, outputPerMTokCNY: 1.2 },
  // Pi / OpenAI 兼容
  "openai/gpt-4o":  { inputPerMTokCNY: 18.0, outputPerMTokCNY: 54.0, note: "OpenAI 官方价" },
  "openai/gpt-4o-mini": { inputPerMTokCNY: 1.2, outputPerMTokCNY: 3.6 },
  // 本地模型
  "qwen3-30b-a3b-q4":{ inputPerMTokCNY: 0, outputPerMTokCNY: 0, isLocal: true, note: "exo 本地集群,只算电费" },
  "qwen3.8-27b-q4": { inputPerMTokCNY: 0, outputPerMTokCNY: 0, isLocal: true, note: "旧版 llama-server 远程,已下线" },
  "qwen3-8-27b-q4": { inputPerMTokCNY: 0, outputPerMTokCNY: 0, isLocal: true, note: "拼写错误版,合并到 qwen3.8" },
};

// 在 ~/.paseo/config.json 里持久化用户自定义定价(优先于默认)
async function loadPricingOverride(): Promise<Record<string, ModelPricing>> {
  const cfgPath = path.join(homedir(), ".paseo", "config.json");
  try {
    const raw = await fs.readFile(cfgPath, "utf-8");
    const cfg = JSON.parse(raw);
    return cfg?.plugins?.tokenTracker?.pricing ?? {};
  } catch {
    return {};
  }
}

// 并行处理一批文件(限制并发数),并把每个文件的解析结果写入 fileRecordCache
async function parseFilesBatched<T extends { sessionId?: string }>(
  files: string[],
  parser: (f: string) => AsyncGenerator<T>,
  concurrency = 16,
): Promise<T[]> {
  // 按文件分组的结果(便于写入 fileRecordCache)
  const byFile = new Map<string, T[]>();
  const allResults: T[] = [];
  let i = 0;

  async function worker() {
    while (i < files.length) {
      const idx = i++;
      const f = files[idx];
      const recs: T[] = [];
      try {
        for await (const r of parser(f)) {
          recs.push(r);
          allResults.push(r);
        }
        byFile.set(f, recs);
        // ⭐ 写回 fileRecordCache
        const mtime = fileFingerprint.get(f) ?? 0;
        if (mtime > 0) {
          fileRecordCache.set(f, { mtime, records: recs as unknown as UsageRecord[] });
        }
        if (mtime > currentMaxMtime) currentMaxMtime = mtime;
      } catch (e) {
        console.error(`[token-tracker] parse error for ${f}:`, e);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);
  return allResults;
}

export async function getPricing(): Promise<{
  pricing: Record<string, ModelPricing>;
  lastUpdated: string;
}> {
  // 用缓存:5 分钟内复用,避免每次都读 config.json
  const now = Date.now();
  if (pricingCache && now - pricingCache.ts < PRICING_TTL_MS) {
    return {
      pricing: pricingCache.data,
      lastUpdated: new Date(pricingCache.ts).toISOString(),
    };
  }
  const overrides = await loadPricingOverride();
  const merged = { ...DEFAULT_PRICING, ...overrides };
  pricingCache = { data: merged, ts: now };
  return {
    pricing: merged,
    lastUpdated: new Date(now).toISOString(),
  };
}

// 从 Codex session 文件里抽出 token_count 事件
async function* walkCodexFiles(sinceDays: number): AsyncGenerator<string> {
  const root = path.join(homedir(), ".codex", "sessions");
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  try {
    await fs.access(root);
  } catch {
    return;
  }
  yield* walkDir(root, cutoff);
}

async function* walkDir(dir: string, cutoff: number): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // 并行 stat
  const checks = entries.map(async (e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      return { type: "dir" as const, path: full, mtime: 0 };
    } else if (e.name.endsWith(".jsonl")) {
      try {
        const st = await fs.stat(full);
        fileFingerprint.set(full, st.mtimeMs);
        return { type: "file" as const, path: full, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    }
    return null;
  });
  const results = await Promise.all(checks);
  for (const r of results) {
    if (!r) continue;
    if (r.type === "dir") {
      yield* walkDir(r.path, cutoff);
    } else if (r.mtime >= cutoff) {
      yield r.path;
    }
  }
}

// 从 cwd 推断 workspace 短名(取最后一段)
function workspaceFromCwd(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

// 解析单条 Codex token_count event,产出 per-turn delta
export async function* parseCodexFile(filepath: string) {
  const sessionId = path.basename(filepath, ".jsonl");
  let provider = "codex";
  let model = "unknown";
  let cwd: string | undefined;

  // 一次性读入所有行(后面两遍扫描)
  const lines: any[] = [];
  try {
    const raw = await fs.readFile(filepath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch {}
    }
  } catch { return; }

  // 第一遍:从最稳定的字段拿 provider + model + cwd
  // 优先级:session_meta.model_provider > thread_settings > turn_context
  for (const d of lines) {
    const t = d?.type;

    if (t === "session_meta") {
      cwd = d.payload?.cwd;
      // model_provider 是必填,稳定
      const mp = d.payload?.model_provider;
      if (mp === "minimax") provider = "minimax-codex";
      else if (mp === "minimax-codex") provider = "minimax-codex";
      else if (mp === "openai-compatible") provider = "codex-openai-compat";
      else if (mp === "ollama") provider = "ollama";
      else if (mp) provider = `codex-${mp}`;
    }

    if (t === "event_msg" && d.payload?.type === "thread_settings_applied") {
      const settings = d.payload?.thread_settings ?? d.payload?.settings ?? d.payload;
      if (settings?.model) model = settings.model;
    }

    // turn_context 也有 model 字段(老 session 没 settings 但有 turn_context)
    if (t === "turn_context" && d.payload?.model) {
      model = d.payload.model;
    }
  }

  // 第二遍:yield token_count 记录
  for (const d of lines) {
    const t = d?.type;
    if (t !== "event_msg" || d.payload?.type !== "token_count") continue;

    const info = d.payload.info ?? {};
    const last = info.last_token_usage ?? {};
    const ctx = info.model_context_window ?? 0;

    const input = last.input_tokens ?? 0;
    const cached = (last.cached_input_tokens ?? 0) + (last.cache_write_input_tokens ?? 0);
    const output = last.output_tokens ?? 0;
    const reasoning = last.reasoning_output_tokens ?? 0;

    if (input + output === 0) continue;

    yield {
      source: "codex" as const,
      sessionId,
      timestamp: d.timestamp ?? new Date().toISOString(),
      provider,
      model,
      workspace: workspaceFromCwd(cwd),
      cwd,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      reasoningTokens: reasoning,
      contextWindow: ctx,
    };
  }
}

async function* walkClaudeFiles(sinceDays: number): AsyncGenerator<string> {
  const root = path.join(homedir(), ".claude", "projects");
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  try {
    await fs.access(root);
  } catch {
    return;
  }
  yield* walkDir(root, cutoff);
}

// GLM ACP agent 的 session JSON 没有 usage 字段,但能算出 turn 数(粗略调用次数)
// GLM session 路径:~/.local/state/glm-acp-agent/sessions/*.json
async function* walkGlmAcpFiles(sinceDays: number): AsyncGenerator<string> {
  const root = path.join(homedir(), ".local", "state", "glm-acp-agent", "sessions");
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  try {
    await fs.access(root);
  } catch {
    return;
  }
  const entries = await fs.readdir(root);
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    const full = path.join(root, e);
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs >= cutoff) yield full;
    } catch {}
  }
}

// Pi agent sessions:~/.pi/agent/sessions/--root-<workspace>--/<timestamp>_<uuid>.jsonl
async function* walkPiFiles(sinceDays: number): AsyncGenerator<string> {
  const root = path.join(homedir(), ".pi", "agent", "sessions");
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  try {
    await fs.access(root);
  } catch {
    return;
  }
  yield* walkDir(root, cutoff);
}

// 解析 Pi agent session
// Pi assistant message 有完整 usage 块:{ input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost }
async function* parsePiFile(filepath: string): AsyncGenerator<UsageRecord> {
  const sessionId = path.basename(filepath, ".jsonl");
  let cwd: string | undefined;
  const pathMatch = filepath.match(/--root-(.+?)--/);
  const workspaceFromPath = pathMatch ? pathMatch[1] : undefined;

  const lines: any[] = [];
  try {
    const raw = await fs.readFile(filepath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch {}
    }
  } catch { return; }

  for (const d of lines) {
    if (d?.type !== "message") continue;
    const msg = d.message ?? {};
    if (msg.role !== "assistant") continue;

    const u = msg.usage;
    if (!u) continue;

    const provider = msg.provider ?? "pi";
    const model = msg.model ?? "unknown";
    const input = u.input ?? 0;
    const output = u.output ?? 0;
    const cached = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    const reasoning = u.reasoning ?? 0;

    yield {
      source: "pi" as const,
      sessionId,
      timestamp: d.timestamp ?? new Date().toISOString(),
      provider: `pi-${provider}`,
      model,
      workspace: workspaceFromPath ?? workspaceFromCwd(cwd),
      cwd,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      reasoningTokens: reasoning,
    };
  }
}

// 解析 GLM session:无法拿 token,只能算 message turn 数
// 假设平均每个 turn ~3K input + 500 output(粗估,基于用户输入习惯)
async function* parseGlmAcpFile(filepath: string): AsyncGenerator<UsageRecord> {
  let data: any;
  try {
    const raw = await fs.readFile(filepath, "utf-8");
    data = JSON.parse(raw);
  } catch { return; }

  const sessionId = data.sessionId ?? path.basename(filepath, ".json");
  const cwd: string | undefined = data.cwd;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  // 数 assistant message = turn 数
  const turns = messages.filter((m: any) => m?.role === "assistant").length;
  if (turns === 0) return;

  // 粗估:每次 turn 平均 3K input + 500 output(用户自己也可以覆盖)
  const estInputPerTurn = 3000;
  const estOutputPerTurn = 500;
  yield {
    source: "glm-acp" as const,
    sessionId,
    timestamp: data.createdAt ?? data.updatedAt ?? new Date().toISOString(),
    provider: "glm-acp-agent",
    model: "glm-5.2",
    workspace: workspaceFromCwd(cwd),
    cwd,
    inputTokens: turns * estInputPerTurn,
    outputTokens: turns * estOutputPerTurn,
    cachedTokens: 0,
    reasoningTokens: 0,
    isEstimate: true,  // 标明是估算
  };
}

export async function* parseClaudeFile(filepath: string) {
  const sessionId = path.basename(filepath, ".jsonl");
  let cwdFromSession: string | undefined;

  const lines: any[] = [];
  try {
    const raw = await fs.readFile(filepath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch {}
    }
  } catch { return; }

  for (const d of lines) {
    if (typeof d.cwd === "string" && !cwdFromSession) cwdFromSession = d.cwd;
    if (d.type !== "assistant") continue;
    const msg = d.message ?? {};
    const usage = msg.usage;
    if (!usage) continue;

    const model = msg.model ?? "unknown";
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cached = (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    const reasoning = usage.output_tokens_details?.thinking_tokens ?? 0;

    // ⚠️ 之前过滤 input+output===0 丢了很多 calls(纯 cached 或纯 thinking 的 turn)
    // 现在只要有 usage 数据就 yield(包括 0 token 的 turn)
    // 完全没数据的才跳过

    let provider = "claude";
    if (model.toLowerCase().includes("minimax")) provider = "minimax-claude";
    else if (model.toLowerCase().includes("claude")) provider = "claude";
    else if (model.toLowerCase().includes("synthetic")) provider = "claude";  // <synthetic> 测试标记

    yield {
      source: "claude-code" as const,
      sessionId,
      timestamp: d.timestamp ?? new Date().toISOString(),
      provider,
      model,
      workspace: workspaceFromCwd(cwdFromSession),
      cwd: cwdFromSession,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      reasoningTokens: reasoning,
    };
  }
}

/**
 * CNY cost for one record, or `null` when the model has no configured price.
 * Returning null (instead of 0) is what keeps the panel honest: an unpriced
 * model must read as "unknown", never as "free". Local models are the one
 * deliberate zero — their price is known to be ¥0.
 */
export function estimateCost(model: string, input: number, output: number, cached: number, pricing: Record<string, ModelPricing>): number | null {
  const p = pricing[model] ?? pricing["*"];
  if (!p) return null;
  if (p.isLocal) return 0;
  const inCost = (input / 1_000_000) * p.inputPerMTokCNY;
  const outCost = (output / 1_000_000) * p.outputPerMTokCNY;
  let cachedCost = 0;
  if (p.cachedInputPerMTokCNY != null) {
    cachedCost = (cached / 1_000_000) * p.cachedInputPerMTokCNY;
  }
  return inCost + outCost + cachedCost;
}

export async function aggregateStats(sinceDays: number, workspaceFilter?: string): Promise<{
  stats: Stats;
  records: UsageRecord[];
}> {
  const filter = workspaceFilter && workspaceFilter !== "all" ? workspaceFilter : undefined;
  const key = cacheKey(sinceDays, filter);

  // ====== 内存 stats 缓存命中(60s 内) ======
  const cached = statsCache.get(key);
  if (cached && Date.now() - new Date(cached.stats.lastScannedAt).getTime() < STATS_TTL_MS) {
    return { stats: cached.stats, records: cached.records };
  }

  currentMaxMtime = 0;

  const pricing = (await getPricing()).pricing;
  const allScanned: UsageRecord[] = [];
  let filesScanned = 0;
  currentMaxMtime = 0;

  // ====== 收集所有候选文件(并发 walk) ======
  const codexFiles: string[] = [];
  for await (const f of walkCodexFiles(sinceDays)) codexFiles.push(f);

  const claudeFiles: string[] = [];
  for await (const f of walkClaudeFiles(sinceDays)) claudeFiles.push(f);

  const glmFiles: string[] = [];
  for await (const f of walkGlmAcpFiles(sinceDays)) glmFiles.push(f);

  const piFiles: string[] = [];
  for await (const f of walkPiFiles(sinceDays)) piFiles.push(f);

  // ====== ⭐ 二级优化:per-file mtime 增量解析 ======
  // 对每个文件:如果 in-memory 缓存里有, 且 mtime 没变 → 直接复用 records
  // 只对 mtime 变化或首次见到的文件重新 parse
  const allFiles = [
    ...codexFiles.map((f) => ({ f, parser: parseCodexFile })),
    ...claudeFiles.map((f) => ({ f, parser: parseClaudeFile })),
    ...glmFiles.map((f) => ({ f, parser: parseGlmAcpFile })),
    ...piFiles.map((f) => ({ f, parser: parsePiFile })),
  ];

  const toParse: typeof allFiles = [];
  const reused: UsageRecord[] = [];

  // 先尝试从磁盘缓存加载(可能在 daemon 重启后帮我们填满 fileRecordCache)
  await loadDiskCacheIntoMemory();

  for (const { f, parser } of allFiles) {
    const mtime = fileFingerprint.get(f) ?? 0;
    const cached = fileRecordCache.get(f);
    if (cached && cached.mtime === mtime && cached.records.length > 0) {
      // 命中!直接复用
      reused.push(...cached.records);
      filesScanned++;
      if (mtime > currentMaxMtime) currentMaxMtime = mtime;
    } else {
      toParse.push({ f, parser });
    }
  }

  filesScanned = allFiles.length;

  // 并行解析"未命中"的文件(16 并发)
  const newRecords = await Promise.all([
    parseFilesBatched(toParse.filter((x) => x.parser === parseCodexFile).map((x) => x.f), parseCodexFile),
    parseFilesBatched(toParse.filter((x) => x.parser === parseClaudeFile).map((x) => x.f), parseClaudeFile),
    parseFilesBatched(toParse.filter((x) => x.parser === parseGlmAcpFile).map((x) => x.f), parseGlmAcpFile),
    parseFilesBatched(toParse.filter((x) => x.parser === parsePiFile).map((x) => x.f), parsePiFile),
  ]).then((arrs) => arrs.flat());

  for (const r of reused) allScanned.push(r);
  for (const r of newRecords) allScanned.push(r);

  // 收集所有出现过的 workspace(用于过滤下拉)
  const wsSet = new Set<string>();
  for (const r of allScanned) {
    if (r.workspace) wsSet.add(r.workspace);
  }
  const availableWorkspaces = [...wsSet].sort();

  filesScanned = codexFiles.length + claudeFiles.length + glmFiles.length + piFiles.length;
  // 注意:filesScanned 后面会被覆盖,先记录

  // 应用 workspace 过滤(filter 已在前面定义)
  const filteredRecords = filter
    ? allScanned.filter((r) => r.workspace === filter)
    : allScanned;

  filteredRecords.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // 按 provider+model 聚合
  const providerMap = new Map<string, ProviderBucket>();
  for (const r of filteredRecords) {
    const key = `${r.provider}::${r.model}`;
    let b = providerMap.get(key);
    if (!b) {
      const modelPricing = pricing[r.model];
      b = {
        provider: r.provider,
        model: r.model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        estimatedCostCNY: 0,
        hasPricing: !!modelPricing,
        unpricedCalls: 0,
        unpricedTokens: 0,
        isLocal: modelPricing?.isLocal ?? false,
        isEstimate: r.isEstimate ?? false,
        completeness: r.isEstimate ? "estimate" : "complete",
        missingSessions: 0,
        totalSessions: 0,
      };
      providerMap.set(key, b);
    }
    b.calls++;
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cachedTokens += r.cachedTokens;
    b.reasoningTokens += r.reasoningTokens;
    const cost = estimateCost(r.model, r.inputTokens, r.outputTokens, r.cachedTokens, pricing);
    if (cost == null) {
      b.unpricedCalls++;
      b.unpricedTokens += r.inputTokens + r.outputTokens;
    } else {
      b.estimatedCostCNY += cost;
    }
    if (r.isEstimate) {
      b.isEstimate = true;
      b.completeness = "estimate";
    }
  }

  // 按天聚合
  const dayMap = new Map<string, DailyBucket>();
  for (const r of filteredRecords) {
    const date = r.timestamp.slice(0, 10);
    let d = dayMap.get(date);
    if (!d) {
      d = { date, calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostCNY: 0 };
      dayMap.set(date, d);
    }
    d.calls++;
    d.inputTokens += r.inputTokens;
    d.outputTokens += r.outputTokens;
    d.estimatedCostCNY += estimateCost(r.model, r.inputTokens, r.outputTokens, r.cachedTokens, pricing) ?? 0;
  }

  // 按 workspace 聚合
  const wsMap = new Map<string, { workspace: string; calls: number; inputTokens: number; outputTokens: number; estimatedCostCNY: number }>();
  for (const r of filteredRecords) {
    const ws = r.workspace ?? "(未知)";
    let w = wsMap.get(ws);
    if (!w) {
      w = { workspace: ws, calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostCNY: 0 };
      wsMap.set(ws, w);
    }
    w.calls++;
    w.inputTokens += r.inputTokens;
    w.outputTokens += r.outputTokens;
    w.estimatedCostCNY += estimateCost(r.model, r.inputTokens, r.outputTokens, r.cachedTokens, pricing) ?? 0;
  }

  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const until = new Date().toISOString();

  const stats: Stats = {
    since,
    until,
    scope: filter ?? "all",
    totalCalls: filteredRecords.length,
    totalInputTokens: filteredRecords.reduce((s, r) => s + r.inputTokens, 0),
    totalOutputTokens: filteredRecords.reduce((s, r) => s + r.outputTokens, 0),
    totalCachedTokens: filteredRecords.reduce((s, r) => s + r.cachedTokens, 0),
    totalReasoningTokens: filteredRecords.reduce((s, r) => s + r.reasoningTokens, 0),
    estimatedTotalCostCNY: [...providerMap.values()].reduce((s, b) => s + b.estimatedCostCNY, 0),
    unpricedCalls: [...providerMap.values()].reduce((s, b) => s + b.unpricedCalls, 0),
    unpricedTokens: [...providerMap.values()].reduce((s, b) => s + b.unpricedTokens, 0),
    pricedTokens: Math.max(
      0,
      filteredRecords.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0) -
        [...providerMap.values()].reduce((s, b) => s + b.unpricedTokens, 0),
    ),
    byProvider: [...providerMap.values()].sort((a, b) => b.estimatedCostCNY - a.estimatedCostCNY),
    byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byWorkspace: [...wsMap.values()].sort((a, b) => b.estimatedCostCNY - a.estimatedCostCNY),
    availableWorkspaces,
    recordsScanned: filteredRecords.length,
    filesScanned,
    lastScannedAt: new Date().toISOString(),
  };

  // 缓存结果
  statsCache.set(key, {
    stats,
    records: filteredRecords,
    filesScanned,
    maxMtime: currentMaxMtime,
  });

  // ⭐ 后台持久化(不阻塞返回)
  saveDiskCacheAsync().catch((e) => console.error("[token-tracker] disk cache save error:", e));

  return { stats, records: filteredRecords };
}

// ⭐ 二级优化:磁盘持久化
type DiskCache = {
  version: number;
  entries: Record<string, FileEntry>;  // filepath → {mtime, records}
};

async function loadDiskCacheIntoMemory(): Promise<void> {
  if (fileRecordCache.size > 0) return;  // 已经从其他途径加载过了
  try {
    const raw = await fs.readFile(DISK_CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as DiskCache;
    if (data.version !== DISK_CACHE_VERSION) {
      console.log(`[token-tracker] disk cache version mismatch, ignoring`);
      return;
    }
    for (const [path, entry] of Object.entries(data.entries)) {
      // 验证文件还存在 + mtime 一致才采用
      const expectedMtime = fileFingerprint.get(path);
      if (expectedMtime === undefined) {
        // 还没 stat 过这个文件,接受缓存(下次再 stat 验证)
        fileRecordCache.set(path, entry);
      } else if (expectedMtime === entry.mtime) {
        // mtime 一致,放心用
        fileRecordCache.set(path, entry);
      }
      // mtime 变了的文件:不在这里 set,会被重新 parse
    }
    console.log(`[token-tracker] disk cache loaded: ${fileRecordCache.size} entries`);
  } catch {
    // 文件不存在或损坏,忽略
  }
}

async function saveDiskCacheAsync(): Promise<void> {
  // 把所有 mtime+records 写到磁盘
  const entries: Record<string, FileEntry> = {};
  for (const [k, v] of fileRecordCache.entries()) {
    entries[k] = v;
  }
  const data: DiskCache = { version: DISK_CACHE_VERSION, entries };

  // 写到磁盘(mkdir -p)
  await fs.mkdir(path.dirname(DISK_CACHE_PATH), { recursive: true });
  await fs.writeFile(DISK_CACHE_PATH, JSON.stringify(data));

  console.log(`[token-tracker] disk cache saved: ${Object.keys(entries).length} entries`);
}

// ⭐ 新增 RPC:手动清除缓存(供调试 / UI 按钮)
export async function clearCache(): Promise<{ ok: boolean; cleared: { memory: number; disk: boolean } }> {
  const memCount = statsCache.size + fileRecordCache.size;
  statsCache.clear();
  fileRecordCache.clear();
  let diskOk = false;
  try {
    await fs.unlink(DISK_CACHE_PATH);
    diskOk = true;
  } catch {
    diskOk = false;  // 文件本来就没有
  }
  return { ok: true, cleared: { memory: memCount, disk: diskOk } };
}

// ⭐ 轻量级刷新:只清 statsCache(内存聚合结果),保留 fileRecordCache(文件级)和 disk
// 这样下次 getStats 会重新聚合,但文件级解析还能命中(快)
export async function invalidateStatsCache(): Promise<{ ok: boolean; cleared: number }> {
  const count = statsCache.size;
  statsCache.clear();
  return { ok: true, cleared: count };
}

// ⭐ 新增 RPC:缓存状态(供 UI 显示)
export async function getCacheStatus(): Promise<{
  memoryEntries: number;
  diskEntries: number;
  diskCachePath: string;
  diskSizeBytes: number;
  statsCacheSize: number;
  lastFileMtime: number;
}> {
  let diskSize = 0;
  let diskEntries = 0;
  try {
    const st = await fs.stat(DISK_CACHE_PATH);
    diskSize = st.size;
    const raw = await fs.readFile(DISK_CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as DiskCache;
    diskEntries = Object.keys(data.entries).length;
  } catch {}

  let lastMtime = 0;
  for (const m of fileFingerprint.values()) if (m > lastMtime) lastMtime = m;

  return {
    memoryEntries: fileRecordCache.size,
    diskEntries,
    diskCachePath: DISK_CACHE_PATH,
    diskSizeBytes: diskSize,
    statsCacheSize: statsCache.size,
    lastFileMtime: lastMtime,
  };
}