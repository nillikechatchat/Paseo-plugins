// Runs inside the daemon subprocess. execFile uses an argv array and never a shell.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ScheduleSummary, ScheduleDetail } from "../shared/rpc";

const execFileAsync = promisify(execFile);
const PASEO_BIN = process.env.PASEO_BIN ?? "paseo";
const DAEMON_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "PASEO_PASSWORD"),
);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

async function run(args: string[], timeoutMs = 15000): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(PASEO_BIN, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: DAEMON_ENV,
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (e: any) {
    return {
      ok: false,
      stdout: e?.stdout ?? "",
      stderr: e?.stderr ?? String(e?.message ?? e),
      code: e?.code ?? null,
    };
  }
}

function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`invalid schedule id: ${id}`);
}

/** paseo schedule ls --json */
export async function listSchedules(): Promise<ScheduleSummary[]> {
  const r = await run(["schedule", "ls", "--json"]);
  if (!r.ok) throw new Error(`schedule ls failed: ${r.stderr || r.stdout}`);
  const parsed = JSON.parse(r.stdout || "[]");
  if (!Array.isArray(parsed)) return [];
  return parsed as ScheduleSummary[];
}

/** paseo schedule inspect <id> --json */
export async function inspectSchedule(id: string): Promise<ScheduleDetail> {
  assertId(id);
  const r = await run(["schedule", "inspect", id, "--json"]);
  if (!r.ok) throw new Error(`schedule inspect failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout) as ScheduleDetail;
}

/** paseo schedule pause|resume|delete|run-once <id> */
export async function controlSchedule(
  id: string,
  action: "pause" | "resume" | "delete" | "run-once",
): Promise<{ ok: boolean; message: string; schedule?: ScheduleSummary }> {
  assertId(id);
  const r = await run(["schedule", action, id], action === "run-once" ? 30000 : 15000);
  if (!r.ok) {
    return { ok: false, message: r.stderr?.trim() || r.stdout?.trim() || `${action} failed` };
  }
  // delete 不再可查;其余动作回查一次摘要带回最新状态
  if (action === "delete") {
    return { ok: true, message: `deleted ${id}` };
  }
  let schedule: ScheduleSummary | undefined;
  try {
    const all = await listSchedules();
    schedule = all.find((s) => s.id === id);
  } catch {
    /* 回查失败不影响整体结果 */
  }
  return {
    ok: true,
    message: `${action} ${id}: ${r.stdout?.trim() || "ok"}`,
    schedule,
  };
}
