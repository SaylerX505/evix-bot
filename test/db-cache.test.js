import test from "node:test";
import assert from "node:assert/strict";
import { MemoryCache, singleFlight } from "../src/db/cache.js";

test("memory cache expires entries and bounds its size without timers", async () => {
  let now = 1_000;
  const cache = new MemoryCache({ maxEntries: 2, ttlMs: 100 });
  cache.now = () => now;

  cache.set("a", { value: 1 });
  cache.set("b", { value: 2 });
  assert.deepEqual(cache.get("a"), { value: 1 });

  now += 101;
  assert.equal(cache.get("a"), undefined);

  cache.set("b", { value: 2 });
  cache.set("c", { value: 3 });
  cache.set("d", { value: 4 });
  assert.equal(cache.size, 2);
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(cache.get("d"), { value: 4 });
});

test("memory cache returns isolated copies and invalidation wins over stale in-flight reads", async () => {
  const cache = new MemoryCache({ maxEntries: 8, ttlMs: 1_000 });
  cache.set("guild", { nested: { value: 1 } });

  const first = cache.get("guild");
  first.nested.value = 99;
  assert.equal(cache.get("guild").nested.value, 1);

  const generation = cache.generation("guild");
  cache.invalidate("guild");
  assert.notEqual(cache.generation("guild"), generation);

  cache.setIfGeneration("guild", { nested: { value: 2 } }, generation);
  assert.equal(cache.get("guild"), undefined);

  cache.set("guild", { nested: { value: 3 } });
  assert.equal(cache.get("guild").nested.value, 3);
});

test("global cache clear invalidates in-flight loads", async () => {
  const cache = new MemoryCache({ maxEntries: 8, ttlMs: 1_000 });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });

  const load = getCached(cache, "guild", async () => {
    await blocked;
    return { value: "stale" };
  });

  cache.clear();
  release();

  assert.deepEqual(await load, { value: "stale" });
  assert.equal(cache.get("guild"), undefined);
});

test("cache invalidation prevents new callers from joining an obsolete flight", async () => {
  const cache = new MemoryCache({ maxEntries: 8, ttlMs: 1_000 });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;

  const first = getCached(cache, "guild", async () => {
    calls += 1;
    await firstGate;
    return { value: "stale" };
  });

  cache.invalidate("guild");

  const second = getCached(cache, "guild", async () => {
    calls += 1;
    return { value: "fresh" };
  });

  assert.deepEqual(await second, { value: "fresh" });
  releaseFirst();
  assert.deepEqual(await first, { value: "stale" });
  assert.equal(calls, 2);
  assert.deepEqual(cache.get("guild"), { value: "fresh" });
});

test("single-flight collapses concurrent identical loads into one operation", async () => {
  let calls = 0;
  const promises = [
    singleFlight("settings:guild", async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true };
    }),
    singleFlight("settings:guild", async () => {
      calls += 1;
      return { ok: false };
    }),
  ];

  const results = await Promise.all(promises);
  assert.equal(calls, 1);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
});
