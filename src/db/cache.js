export class MemoryCache {
  constructor({ maxEntries = 256, ttlMs = 15_000, name = "cache" } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer.");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("ttlMs must be a positive number.");
    }

    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.name = name;
    this.entries = new Map();
    this.generations = new Map();
    this.now = () => Date.now();
  }

  get(key) {
    const record = this.entries.get(String(key));
    if (!record) return undefined;

    if (record.expiresAt <= this.now()) {
      this.entries.delete(String(key));
      return undefined;
    }

    return structuredClone(record.value);
  }

  set(key, value, ttlMs = this.ttlMs) {
    const normalizedKey = String(key);
    const generation = (this.generations.get(normalizedKey) ?? 0) + 1;
    this.generations.set(normalizedKey, generation);
    this.entries.delete(normalizedKey);
    this.entries.set(normalizedKey, {
      value: structuredClone(value),
      expiresAt: this.now() + ttlMs,
    });
    this.evict();
    return structuredClone(value);
  }

  setIfGeneration(key, value, expectedGeneration, ttlMs = this.ttlMs) {
    const normalizedKey = String(key);
    if ((this.generations.get(normalizedKey) ?? 0) !== expectedGeneration) {
      return false;
    }
    this.set(normalizedKey, value, ttlMs);
    return true;
  }

  invalidate(key) {
    const normalizedKey = String(key);
    this.generations.set(normalizedKey, (this.generations.get(normalizedKey) ?? 0) + 1);
    this.entries.delete(normalizedKey);
  }

  deleteWhere(predicate) {
    for (const [key, record] of this.entries) {
      if (!predicate(record.value, key)) continue;
      this.invalidate(key);
    }
  }

  generation(key) {
    return this.generations.get(String(key)) ?? 0;
  }

  clear() {
    this.entries.clear();
    this.generations.clear();
  }

  get size() {
    this.pruneExpired();
    return this.entries.size;
  }

  pruneExpired() {
    const now = this.now();
    for (const [key, record] of this.entries) {
      if (record.expiresAt <= now) this.entries.delete(key);
    }
  }

  evict() {
    this.pruneExpired();
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
  }
}

const flights = new Map();

export function singleFlight(key, loader) {
  const normalizedKey = String(key);
  const existing = flights.get(normalizedKey);
  if (existing) return existing;

  const promise = Promise.resolve().then(loader);
  flights.set(normalizedKey, promise);

  return promise.finally(() => {
    if (flights.get(normalizedKey) === promise) flights.delete(normalizedKey);
  });
}

export async function getCached(cache, key, loader) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  return singleFlight(cache.name + ":" + key, async () => {
    const secondHit = cache.get(key);
    if (secondHit !== undefined) return secondHit;

    const generation = cache.generation(key);
    const value = await loader();
    cache.setIfGeneration(key, value, generation);
    return structuredClone(value);
  });
}
