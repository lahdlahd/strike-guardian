/**
 * Canonical JSON: sorted keys, no whitespace, finite numbers only.
 * The same object always serialises to the same bytes, so hashes and
 * signatures over it are reproducible by anyone (including the browser verifier).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    return v;
  }
  if (Array.isArray(v)) return v.map(sortDeep);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).sort()) {
    const val = (v as Record<string, unknown>)[k];
    if (val !== undefined) out[k] = sortDeep(val);
  }
  return out;
}
