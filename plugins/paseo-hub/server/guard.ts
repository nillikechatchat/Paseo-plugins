// Reads optional Guard SQLite/systemd state and collects host metrics.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as fssync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { SystemSnapshot } from "../shared/rpc";

const execFileAsync = promisify(execFile);

const GUARD_DB = process.env.HOST_GUARD_DB;
const GUARD_UNIT = process.env.HOST_GUARD_UNIT;
const GUARD_CONTROL = process.env.HOST_GUARD_CONTROL;
const GUARD_CONFIG = process.env.HOST_GUARD_CONFIG;
const GUARD_IPSET = process.env.HOST_GUARD_IPSET;

// ---------- basic tools ----------

interface RunResult { ok: boolean; stdout: string; stderr: string }

async function run(cmd: string, args: string[], timeoutMs = 8000): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e: any) {
    return { ok: false, stdout: e?.stdout ?? "", stderr: e?.stderr ?? String(e?.message ?? e) };
  }
}

function guardEnabled(): boolean {
  return Boolean(GUARD_DB && GUARD_UNIT && GUARD_IPSET);
}

async function readConfig(): Promise<string> {
  return GUARD_CONFIG ? fs.readFile(GUARD_CONFIG, "utf-8").catch(() => "") : "";
}

/** Read-only SQLite query against the configured guard database. */
async function dbAll<T = any>(sql: string, params: (string | number)[] = []): Promise<T[]> {
  if (!GUARD_DB) return [];
  const args = ["-json", "-readonly", GUARD_DB];
  // sqlite3 CLI 不支持参数绑定,手动转义:数字直拼,字符串走 SQL 转义
  let i = 0;
  const finalSql = sql.replace(/\?/g, () => {
    const v = params[i++];
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  args.push(finalSql);
  const r = await run(process.env.SQLITE_BIN ?? "/usr/bin/sqlite3", args);
  if (!r.ok || !r.stdout.trim()) return [];
  try {
    return JSON.parse(r.stdout) as T[];
  } catch {
    return [];
  }
}

// ---------- host guard status ----------

export async function getGuardStatus() {
  const [svc, ipset, dbCount, evCount, cfgText, uptimeRaw] = await Promise.all([
    run("/bin/systemctl", ["is-active", GUARD_UNIT!]),
    guardEnabled() ? run("/sbin/ipset", ["list", GUARD_IPSET!]) : Promise.resolve({ ok: false, stdout: "", stderr: "" }),
    dbAll<{ c: number }>("SELECT COUNT(*) AS c FROM bans"),
    dbAll<{ c: number }>("SELECT COUNT(*) AS c FROM events WHERE ts >= strftime('%s','now') - 86400"),
    readConfig(),
    run("/bin/systemctl", ["show", GUARD_UNIT!, "--property=ActiveEnterTimestamp", "--value"]),
  ]);

  let ipsetEntries = 0;
  const m = ipset.stdout.match(/Number of entries:\s*(\d+)/);
  if (m) ipsetEntries = parseInt(m[1], 10);

  // systemctl show 输出本地时间无时区标记,按本地时区解析
  let uptimeSeconds = 0;
  const tsStr = uptimeRaw.stdout.trim();
  if (tsStr) {
    const t = new Date(tsStr).getTime();
    if (!Number.isNaN(t)) uptimeSeconds = Math.max(0, Math.floor(Date.now() / 1000 - t / 1000));
  }

  return {
    serviceActive: svc.stdout.trim() === "active",
    dryRun: /^\s*dry_run:\s*true/m.test(cfgText),
    ipsetEntries,
    dbBans: dbCount[0]?.c ?? 0,
    firewallAvailable: ipset.ok,
    events24h: evCount[0]?.c ?? 0,
    uptimeSeconds,
  };
}

// ---------- host guard bans ----------

export async function listBans(limit: number, offset: number) {
  const [rows, total] = await Promise.all([
    dbAll(
      "SELECT ip, ts, reason, attack_type AS attackType FROM bans ORDER BY ts DESC LIMIT ? OFFSET ?",
      [limit, offset],
    ),
    dbAll<{ c: number }>("SELECT COUNT(*) AS c FROM bans"),
  ]);
  return { bans: rows ?? [], total: total[0]?.c ?? 0 };
}

export async function banIp(ip: string, reason: string): Promise<{ ok: boolean; message: string }> {
  if (!GUARD_CONTROL || !GUARD_CONFIG) return { ok: false, message: "Guard control is not configured" };
  if (!isValidIp(ip)) return { ok: false, message: `非法 IP: ${ip}` };
  // Writes go through the configured control executable to keep SQLite and the firewall in sync.
  const r = await run(GUARD_CONTROL, ["-c", GUARD_CONFIG, "ban", ip, "--reason", reason]);
  return r.ok
    ? { ok: true, message: `已永久封禁 ${ip}` }
    : { ok: false, message: (r.stderr.trim() || `封禁失败: ${ip}`) };
}

export async function unbanIp(ip: string): Promise<{ ok: boolean; message: string }> {
  if (!GUARD_CONTROL || !GUARD_CONFIG) return { ok: false, message: "Guard control is not configured" };
  if (!isValidIp(ip)) return { ok: false, message: `非法 IP: ${ip}` };
  const r = await run(GUARD_CONTROL, ["-c", GUARD_CONFIG, "unban", ip]);
  if (!r.ok) return { ok: false, message: r.stderr.trim() || `解封失败: ${ip}` };
  return r.stdout.includes("已解封")
    ? { ok: true, message: `已解封 ${ip}` }
    : { ok: false, message: `${ip} 不在黑名单中` };
}

function isValidIp(ip: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.includes(":");
}

// ---------- host guard events ----------

export async function listEvents(limit: number, attackType?: string) {
  const rows = attackType
    ? await dbAll(
        "SELECT ts, ip, attack_type AS attackType, severity, source, detail FROM events WHERE attack_type = ? ORDER BY ts DESC LIMIT ?",
        [attackType, limit],
      )
    : await dbAll(
        "SELECT ts, ip, attack_type AS attackType, severity, source, detail FROM events ORDER BY ts DESC LIMIT ?",
        [limit],
      );
  return { events: rows ?? [] };
}

export async function topAttackers(sinceHours: number, limit: number) {
  const rows = await dbAll(
    "SELECT ip, COUNT(*) AS count, MAX(severity) AS maxSeverity FROM events WHERE ts >= strftime('%s','now') - ? GROUP BY ip ORDER BY count DESC LIMIT ?",
    [sinceHours * 3600, limit],
  );
  return { items: rows ?? [] };
}

// ---------- 系统监控 ----------

function parseLoad(): { min1: number; min5: number; min15: number } {
  try {
    const l = fssync.readFileSync("/proc/loadavg", "utf-8").split(" ");
    return { min1: parseFloat(l[0]), min5: parseFloat(l[1]), min15: parseFloat(l[2]) };
  } catch {
    return { min1: 0, min5: 0, min15: 0 };
  }
}

function parseMeminfo() {
  const lines = fssync.readFileSync("/proc/meminfo", "utf-8").split("\n");
  const get = (k: string) => {
    const l = lines.find((x: string) => x.startsWith(k));
    return l ? parseInt(l.split(/\s+/)[1], 10) * 1024 : 0;
  };
  const total = get("MemTotal");
  const swapTotal = get("SwapTotal");
  return {
    totalBytes: total,
    usedBytes: total - get("MemAvailable"),
    availableBytes: get("MemAvailable"),
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapTotal - get("SwapFree"),
  };
}

function parsePsi(): { ioSome: number; memSome: number; cpuSome: number } | undefined {
  try {
    const read = (f: string) => {
      const t = fssync.readFileSync(`/proc/pressure/${f}`, "utf-8");
      const m = t.match(/some avg10=([\d.]+)/);
      return m ? parseFloat(m[1]) : 0;
    };
    return { ioSome: read("io"), memSome: read("memory"), cpuSome: read("cpu") };
  } catch {
    return undefined; // 内核不支持 PSI
  }
}

function uptimeSeconds(): number {
  try {
    return parseInt(fssync.readFileSync("/proc/uptime", "utf-8").split(" ")[0], 10);
  } catch {
    return 0;
  }
}

async function diskUsage() {
  const r = await run("/bin/df", ["-B1", "--output=target,size,used,pcent", "-x", "tmpfs", "-x", "devtmpfs"]);
  const disks: SystemSnapshot["disks"] = [];
  for (const line of r.stdout.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [mount, size, used, pcent] = parts;
    disks.push({
      mount,
      totalBytes: parseInt(size, 10) || 0,
      usedBytes: parseInt(used, 10) || 0,
      usePercent: parseFloat(pcent) || 0,
    });
  }
  return disks;
}

async function topProcs() {
  const r = await run("/bin/ps", ["-eo", "pid,pcpu,rss,comm", "--sort=-pcpu"]);
  const procs: SystemSnapshot["topProcs"] = [];
  for (const line of r.stdout.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0], 10);
    const cpuPercent = parseFloat(parts[1]);
    const memMb = parseFloat(parts[2]) / 1024;
    const command = parts.slice(3).join(" ");
    if (!Number.isNaN(pid) && procs.length < 10) {
      procs.push({ pid, command, cpuPercent, memMb: Math.round(memMb * 10) / 10 });
    }
  }
  return procs;
}

async function procStates() {
  const r = await run("/bin/ps", ["-eo", "stat", "--no-headers"]);
  let d = 0, z = 0;
  for (const line of r.stdout.split("\n")) {
    const s = line.trim();
    if (s.startsWith("D")) d++;
    else if (s.startsWith("Z")) z++;
  }
  return { dStateCount: d, zombieCount: z };
}

export async function getSystemSnapshot(): Promise<SystemSnapshot> {
  const [disks, procs, states] = await Promise.all([diskUsage(), topProcs(), procStates()]);
  return {
    ts: Math.floor(Date.now() / 1000),
    hostname: os.hostname(),
    uptimeSeconds: uptimeSeconds(),
    cpuCores: os.cpus().length,
    load: parseLoad(),
    memory: parseMeminfo(),
    disks,
    psi: parsePsi(),
    topProcs: procs,
    ...states,
  };
}

// ---------- agent 运行时进程巡检 ----------

// 防 opencode serve 泄漏复发(FAQ 02-#1):按关键字分组统计 agent 运行时进程
const AGENT_PROC_PATTERNS: Array<[string, string]> = [
  ["paseo-daemon", "Paseo Daemon"],
  ["opencode", "opencode serve"],
  ["codex", "codex app-server"],
  ["glm-acp", "glm-acp-agent"],
  ["claude", "claude"],
];

// ---------- 数据安全 ----------

/** 数据安全事件统计:按分类汇总 + 24h 趋势 */
export async function getDataSecurityStats() {
  const [byCategory, total24h, totalAll, recentEvents, fileChanges, fileMetadata] = await Promise.all([
    dbAll<{ category: string; c: number }>(
      "SELECT CASE WHEN attack_type='data_pii' THEN 'pii' " +
      "WHEN attack_type='data_financial' THEN 'financial' " +
      "WHEN attack_type='data_credential' THEN 'credential' " +
      "WHEN attack_type='data_secret' THEN 'secret' " +
      "WHEN attack_type='data_config' THEN 'config' " +
      "WHEN attack_type='data_file_integrity' THEN 'integrity' " +
      "WHEN attack_type='data_file_metadata' THEN 'metadata' " +
      "WHEN attack_type='data_sensitive_access' THEN 'access' " +
      "ELSE 'other' END AS category, COUNT(*) AS c " +
      "FROM events WHERE attack_type LIKE 'data_%' GROUP BY category",
    ),
    dbAll<{ c: number }>(
      "SELECT COUNT(*) AS c FROM events WHERE attack_type LIKE 'data_%' AND ts >= strftime('%s','now') - 86400",
    ),
    dbAll<{ c: number }>(
      "SELECT COUNT(*) AS c FROM events WHERE attack_type LIKE 'data_%'",
    ),
    dbAll<{ ts: number; ip: string; attack_type: string; detail: string }>(
      "SELECT ts, ip, attack_type, detail FROM events WHERE attack_type LIKE 'data_%' ORDER BY ts DESC LIMIT 10",
    ),
    dbAll<{ c: number }>(
      "SELECT COUNT(*) AS c FROM events WHERE attack_type='data_file_integrity'",
    ),
    dbAll<{ c: number }>(
      "SELECT COUNT(*) AS c FROM events WHERE attack_type='data_file_metadata'",
    ),
  ]);

  return {
    total: totalAll[0]?.c ?? 0,
    events24h: total24h[0]?.c ?? 0,
    fileIntegrityChanges: fileChanges[0]?.c ?? 0,
    fileMetadataChanges: fileMetadata[0]?.c ?? 0,
    byCategory: Object.fromEntries((byCategory ?? []).map((r) => [r.category, r.c])),
    recentEvents: (recentEvents ?? []).map((e) => ({
      ts: e.ts,
      ip: e.ip,
      attackType: e.attack_type,
      detail: e.detail,
    })),
  };
}

/** 数据安全事件列表(可按分类过滤) */
export async function listDataEvents(limit: number, category?: string) {
  const typeFilter = category
    ? ` AND attack_type = 'data_${category}'`
    : "";
  const rows = await dbAll(
    "SELECT ts, ip, attack_type AS attackType, severity, source, detail " +
    `FROM events WHERE attack_type LIKE 'data_%'${typeFilter} ORDER BY ts DESC LIMIT ?`,
    [limit],
  );
  return { events: rows ?? [] };
}

export async function getAgentProcs() {
  const r = await run("/bin/ps", ["-eo", "pid,rss,args", "--no-headers"]);
  const groups = AGENT_PROC_PATTERNS.map(([name]) => ({
    name, count: 0, totalMemMb: 0, pids: [] as number[],
  }));
  for (const line of r.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0], 10);
    const rss = parseInt(parts[1], 10);
    const args = parts.slice(2).join(" ");
    for (let i = 0; i < AGENT_PROC_PATTERNS.length; i++) {
      const [name, pattern] = AGENT_PROC_PATTERNS[i];
      // glm-acp-agent 的命令行含 "claude" 关键字时归 glm-acp,避免重复计数
      if (name === "claude" && /glm-acp-agent/.test(args)) continue;
      if (args.includes(pattern)) {
        groups[i].count++;
        groups[i].totalMemMb += Math.round(rss / 1024);
        groups[i].pids.push(pid);
        break;
      }
    }
  }
  return { ts: Math.floor(Date.now() / 1000), groups: groups.filter((g) => g.count > 0) };
}
