import { openStore, type Store } from "../../lib/artifacts/store.ts";

// One pooled connection per serverless instance.
let store: Store | null = null;
let ready: Promise<void> | null = null;

export async function getStore(): Promise<Store> {
  if (!store) {
    store = openStore();
    ready = store.init();
  }
  await ready;
  return store;
}

export const noStore = { "Cache-Control": "no-store" };
