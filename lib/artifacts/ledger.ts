/** Ledger: appends signed artifacts to the store, maintaining seq + prevHash. Single writer (the agent). */

import { GENESIS, signArtifact, type Artifact, type ArtifactKind } from "./artifact.ts";
import type { Store } from "./store.ts";

export class Ledger {
  private seq = 0;
  private prevHash = GENESIS;

  constructor(
    private store: Store,
    private attestPrivateKey: string,
    readonly attestPubKey: string,
    private network: string
  ) {}

  async init() {
    await this.store.init();
    const last = await this.store.last();
    if (last) {
      this.seq = last.seq;
      this.prevHash = last.hash;
    }
  }

  async write(
    kind: ArtifactKind,
    body: Record<string, unknown>,
    meta: { symbol?: string; verdict?: string; strike?: Artifact["strike"]; now?: number } = {}
  ): Promise<Artifact> {
    const unsigned = {
      v: 1 as const,
      kind,
      seq: this.seq + 1,
      prevHash: this.prevHash,
      createdAt: meta.now ?? Date.now(),
      network: this.network,
      attestPubKey: this.attestPubKey,
      ...(meta.symbol ? { symbol: meta.symbol } : {}),
      ...(meta.verdict ? { verdict: meta.verdict } : {}),
      body,
      ...(meta.strike ? { strike: meta.strike } : {}),
    };
    const a = signArtifact(unsigned, this.attestPrivateKey);
    await this.store.append(a);
    this.seq = a.seq;
    this.prevHash = a.hash;
    return a;
  }
}
