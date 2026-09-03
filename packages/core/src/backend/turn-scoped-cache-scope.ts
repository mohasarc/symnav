export interface TurnScopedCache<Key, Value> {
  getOrCreate(key: Key, createValue: () => Value): Value;
}

interface ClearableTurnScopedCache {
  clear(): void;
}

class TurnScopedCacheHandle<Key, Value>
  implements TurnScopedCache<Key, Value>, ClearableTurnScopedCache
{
  private readonly values = new Map<Key, Value>();

  getOrCreate(key: Key, createValue: () => Value): Value {
    if (this.values.has(key)) return this.values.get(key) as Value;
    const value = createValue();
    this.values.set(key, value);
    return value;
  }

  clear(): void {
    this.values.clear();
  }
}

export class TurnScopedCacheScope {
  private readonly caches: ClearableTurnScopedCache[] = [];

  createCache<Key, Value>(): TurnScopedCache<Key, Value> {
    const cache = new TurnScopedCacheHandle<Key, Value>();
    this.caches.push(cache);
    return cache;
  }

  beginTurn(): void {
    this.clear();
  }

  releaseTransientResources(): void {
    this.clear();
  }

  private clear(): void {
    for (const cache of this.caches) cache.clear();
  }
}
