// AIHOT REST v1 anonymous read-only API with a 60-second cache throttle.

const BASE = process.env.AIHOT_BASE_URL;
const ACTOR = process.env.AIHOT_ACTOR || "";
const UA = `aihot-api/1.0${ACTOR ? ` aihot-actor/${ACTOR}` : ""}`;
const CACHE_TTL = 60_000;

type CacheEntry = { t: number; data: unknown };
const cache = new Map<string, CacheEntry>();

async function aihotGet<T>(path: string): Promise<T> {
  if (!BASE) throw new Error("AIHOT_BASE_URL is not configured");
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.t < CACHE_TTL) return hit.data as T;

  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    throw new Error(`AIHOT 限流，请在 ${ra ?? "60"}s 后重试`);
  }
  if (!res.ok) throw new Error(`AIHOT 请求失败：${res.status}`);

  const data = (await res.json()) as T;
  cache.set(path, { t: now, data });
  return data;
}

// v1 raw field types
type V1Item = {
  id: string; title: string; summary?: string;
  source?: { name?: string };
  links?: { aihot?: string; original?: string };
  publishedAt?: string; category?: string;
  score?: number | null; selected?: boolean; reason?: string;
};
type V1ItemsResp = { items?: V1Item[]; page?: { hasMore?: boolean; nextCursor?: string; cursor?: string; hasNext?: boolean } };
type V1HotResp = { items?: Array<{
  rank: number; title: string; source?: { name?: string };
  links?: { aihot?: string; original?: string; story?: string };
  sourceCount?: number; signalCount?: number; sourceNames?: string[]; latestAt?: string;
}> };
type V1DailyResp = { report?: {
  date: string; generatedAt?: string; links?: { aihot?: string };
  lead?: string | null;
  sections?: Array<{ label: string; items?: Array<{ title: string; summary?: string }> }>;
} };

export async function fetchLatest(limit: number | undefined, cursor: string | undefined, category: string | undefined) {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const r = await aihotGet<V1ItemsResp>(`/api/v1/items${qs}`);
  const items = (r.items ?? []).map((it) => ({
    id: it.id, title: it.title, summary: it.summary,
    sourceName: it.source?.name, originalUrl: it.links?.original,
    aihotUrl: it.links?.aihot, publishedAt: it.publishedAt,
    category: it.category, score: it.score ?? null,
    selected: it.selected, reason: it.reason,
  }));
  const lim = limit ?? 20;
  const page = r.page ?? {};
  const nextCursor = page.nextCursor ?? page.cursor ?? null;
  const hasMore = items.length <= lim && !!(page.hasMore ?? page.hasNext);
  return { items: items.slice(0, lim), cursor: nextCursor, hasMore };
}

export async function fetchHotTopics() {
  const r = await aihotGet<V1HotResp>(`/api/v1/hot-topics`);
  const items = (r.items ?? []).map((t) => ({
    rank: t.rank, title: t.title, sourceName: t.source?.name,
    originalUrl: t.links?.original, aihotUrl: t.links?.aihot,
    storyUrl: t.links?.story, sourceCount: t.sourceCount,
    signalCount: t.signalCount, sourceNames: t.sourceNames,
    latestAt: t.latestAt,
  }));
  return { items };
}

export async function fetchDailyLatest() {
  const r = await aihotGet<V1DailyResp>(`/api/v1/dailies/latest`);
  const rep = r.report;
  if (!rep) throw new Error("AIHOT 日报暂不可用");
  return {
    date: rep.date, generatedAt: rep.generatedAt,
    aihotUrl: rep.links?.aihot, lead: rep.lead ?? null,
    sections: (rep.sections ?? []).map((s) => ({
      label: s.label,
      items: (s.items ?? []).map((it) => ({ title: it.title, summary: it.summary })),
    })),
  };
}
