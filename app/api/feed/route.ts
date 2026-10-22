import { getStore, noStore } from "../_store.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/feed?limit=40&before=<seq>&kind=decision — newest first. Public, read-only. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const limit = Math.min(Number(u.searchParams.get("limit") ?? 40) || 40, 200);
  const before = Number(u.searchParams.get("before")) || undefined;
  const kind = u.searchParams.get("kind") || undefined;
  const store = await getStore();
  const items = await store.list({ limit, beforeSeq: before, kind });
  return Response.json({ items }, { headers: noStore });
}
