/**
 * Artifact + state persistence.
 *   DATABASE_URL set → Postgres (Supabase). Used by the Render worker and the Vercel dashboard.
 *   unset            → local JSONL in ./data (dev / dry runs).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import type { Artifact } from "./artifact.ts";

export interface Store {
  init(): Promise<void>;
  append(a: Artifact): Promise<void>;
  last(): Promise<Artifact | null>;
  list(opts?: { limit?: number; kind?: string; beforeSeq?: number }): Promise<Artifact[]>;
  getState<T>(key: string): Promise<T | null>;
  setState(key: string, value: unknown): Promise<void>;
  close(): Promise<void>;
}

export const SCHEMA_SQL = `
create table if not exists artifacts (
  seq        bigint primary key,
  kind       text not null,
  symbol     text,
  verdict    text,
  created_at timestamptz not null,
  hash       text not null unique,
  prev_hash  text not null,
  doc        jsonb not null
);
create index if not exists artifacts_kind_seq on artifacts (kind, seq desc);
create table if not exists agent_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);`;

class PgStore implements Store {
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 3, ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false } });
  }
  async init() {
    await this.pool.query(SCHEMA_SQL);
  }
  async append(a: Artifact) {
    await this.pool.query(
      "insert into artifacts (seq, kind, symbol, verdict, created_at, hash, prev_hash, doc) values ($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7,$8)",
      [a.seq, a.kind, a.symbol ?? null, a.verdict ?? null, a.createdAt, a.hash, a.prevHash, a]
    );
  }
  async last() {
    const r = await this.pool.query("select doc from artifacts order by seq desc limit 1");
    return (r.rows[0]?.doc as Artifact) ?? null;
  }
  async list({ limit = 50, kind, beforeSeq }: { limit?: number; kind?: string; beforeSeq?: number } = {}) {
    const args: unknown[] = [];
    const where: string[] = [];
    if (kind) where.push(`kind = $${args.push(kind)}`);
    if (beforeSeq) where.push(`seq < $${args.push(beforeSeq)}`);
    const r = await this.pool.query(
      `select doc from artifacts ${where.length ? "where " + where.join(" and ") : ""} order by seq desc limit $${args.push(Math.min(limit, 500))}`,
      args
    );
    return r.rows.map((x) => x.doc as Artifact);
  }
  async getState<T>(key: string) {
    const r = await this.pool.query("select value from agent_state where key = $1", [key]);
    return (r.rows[0]?.value as T) ?? null;
  }
  async setState(key: string, value: unknown) {
    await this.pool.query(
      "insert into agent_state (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()",
      [key, JSON.stringify(value)]
    );
  }
  async close() {
    await this.pool.end();
  }
}

class FileStore implements Store {
  private dir = "data";
  private file = "data/artifacts.jsonl";
  private stateFile = "data/state.json";
  async init() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }
  private all(): Artifact[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  async append(a: Artifact) {
    appendFileSync(this.file, JSON.stringify(a) + "\n");
  }
  async last() {
    return this.all().at(-1) ?? null;
  }
  async list({ limit = 50, kind, beforeSeq }: { limit?: number; kind?: string; beforeSeq?: number } = {}) {
    return this.all()
      .filter((a) => (!kind || a.kind === kind) && (!beforeSeq || a.seq < beforeSeq))
      .reverse()
      .slice(0, limit);
  }
  private state(): Record<string, unknown> {
    return existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, "utf8")) : {};
  }
  async getState<T>(key: string) {
    return (this.state()[key] as T) ?? null;
  }
  async setState(key: string, value: unknown) {
    const s = this.state();
    s[key] = value;
    writeFileSync(this.stateFile, JSON.stringify(s, null, 2));
  }
  async close() {}
}

export function openStore(): Store {
  const url = process.env.DATABASE_URL?.trim();
  return url ? new PgStore(url) : new FileStore();
}
