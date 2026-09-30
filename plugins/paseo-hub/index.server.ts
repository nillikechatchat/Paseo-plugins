import type { PluginServerContext } from "@getpaseo/plugin/server";

import {
  latest, hotTopics, dailyLatest,
  listSchedulesRpc, inspectScheduleRpc, controlScheduleRpc,
  getGuardStatusRpc, listBansRpc, banIpRpc, unbanIpRpc, listEventsRpc, topAttackersRpc,
  getDataSecurityStatsRpc, listDataEventsRpc, getSystemSnapshotRpc, getAgentProcsRpc,
} from "./shared/rpc";

import { fetchLatest, fetchHotTopics, fetchDailyLatest } from "./server/aihot";
import { listSchedules, inspectSchedule, controlSchedule } from "./server/schedules";
import {
  getGuardStatus, listBans, banIp, unbanIp, listEvents, topAttackers,
  getDataSecurityStats, listDataEvents, getSystemSnapshot, getAgentProcs,
} from "./server/guard";

export default function contribute(server: PluginServerContext) {
  // ---- AIHOT News ----
  server.handle(latest, async ({ limit, cursor, category }) => fetchLatest(limit, cursor, category));
  server.handle(hotTopics, async () => fetchHotTopics());
  server.handle(dailyLatest, async () => fetchDailyLatest());

  // ---- Schedules (Dashboard) ----
  server.handle(listSchedulesRpc, async () => ({ schedules: await listSchedules() }));
  server.handle(inspectScheduleRpc, async ({ id }) => ({ schedule: await inspectSchedule(id) }));
  server.handle(controlScheduleRpc, async ({ id, action }) => controlSchedule(id, action));

  // ---- Server Guard ----
  server.handle(getGuardStatusRpc, async () => await getGuardStatus());
  server.handle(listBansRpc, async ({ limit, offset }) => await listBans(limit, offset));
  server.handle(banIpRpc, async ({ ip, reason }) => await banIp(ip, reason));
  server.handle(unbanIpRpc, async ({ ip }) => await unbanIp(ip));
  server.handle(listEventsRpc, async ({ limit, attackType }) => await listEvents(limit, attackType));
  server.handle(topAttackersRpc, async ({ sinceHours, limit }) => await topAttackers(sinceHours, limit));

  // ---- Data Security ----
  server.handle(getDataSecurityStatsRpc, async () => await getDataSecurityStats());
  server.handle(listDataEventsRpc, async ({ limit, category }) => await listDataEvents(limit, category));

  // ---- System Monitor ----
  server.handle(getSystemSnapshotRpc, async () => await getSystemSnapshot());
  server.handle(getAgentProcsRpc, async () => await getAgentProcs());


  return async () => {};
}
