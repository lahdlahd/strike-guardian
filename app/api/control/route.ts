import { timingSafeEqual } from "node:crypto";
import { getStore, noStore } from "../_store.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/control { action: "kill" | "pause" | "resume" }
 * Requires Authorization: Bearer <ADMIN_TOKEN>. Without ADMIN_TOKEN configured, control is disabled.
 * The dashboard never holds Strike keys: it only sets a flag the agent obeys on its next cycle.
 */
export async function POST(req: Request) {
  const expected = process.env.ADMIN_TOKEN ?? "";
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok = expected.length >= 16 && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  if (!ok) return Response.json({ error: "Wrong or missing admin token." }, { status: 401, headers: noStore });

  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  const next =
    action === "kill" ? { paused: true, kill: true } : action === "pause" ? { paused: true, kill: false } : action === "resume" ? { paused: false, kill: false } : null;
  if (!next) return Response.json({ error: 'action must be "kill", "pause" or "resume"' }, { status: 400, headers: noStore });

  const store = await getStore();
  await store.setState("control", next);
  return Response.json({ ok: true, control: next }, { headers: noStore });
}
