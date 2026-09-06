// ============================================================
// AheadSub — Subtitle Cache (IndexedDB)
// Stores generated subtitles for reuse across sessions.
// ============================================================

import { openDB, type IDBPDatabase } from 'idb';
import type { CacheEntry, CacheKey, TranscriptionResult } from '../types';
import { CACHE_DB_NAME, CACHE_DB_VERSION, CACHE_STORE_NAME, MAX_CACHE_ENTRIES } from '../constants';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(CACHE_DB_NAME, CACHE_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          const store = db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'id' });
          store.createIndex('cacheKey', 'cacheKey', { unique: true });
          store.createIndex('createdAt', 'createdAt');
          store.createIndex('accessedAt', 'accessedAt');
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Generate a cache key from the identifying parameters.
 */
export function generateCacheKey(key: CacheKey): string {
  const parts = [
    key.mediaUrl || key.pageUrl,
    Math.round(key.duration).toString(),
    key.spokenLanguage,
    key.subtitleLanguage,
    key.modelId,
  ];
  return parts.join('|');
}

/**
 * Look up cached subtitles.
 */
export async function getCachedResult(key: CacheKey): Promise<TranscriptionResult | null> {
  try {
    const db = await getDB();
    const cacheKey = generateCacheKey(key);
    const entry = await db.getFromIndex(CACHE_STORE_NAME, 'cacheKey', cacheKey);

    if (entry) {
      // Update access time
      entry.accessedAt = Date.now();
      await db.put(CACHE_STORE_NAME, entry);
      return (entry as CacheEntry).result;
    }

    return null;
  } catch (error) {
    console.error('[AheadSub Cache] Get error:', error);
    return null;
  }
}

/**
 * Store a transcription result in the cache.
 */
export async function cacheResult(
  key: CacheKey,
  result: TranscriptionResult
): Promise<void> {
  try {
    const db = await getDB();
    const cacheKey = generateCacheKey(key);
    const now = Date.now();

    const entry: CacheEntry = {
      id: `cache-${now}-${Math.random().toString(36).substring(2, 8)}`,
      cacheKey,
      result,
      mediaUrl: key.mediaUrl,
      pageUrl: key.pageUrl,
      duration: key.duration,
      spokenLanguage: key.spokenLanguage,
      subtitleLanguage: key.subtitleLanguage,
      modelId: key.modelId,
      createdAt: now,
      accessedAt: now,
      sizeBytesEstimate: JSON.stringify(result).length * 2,
    };

    // Check if we need to evict old entries
    const count = await db.count(CACHE_STORE_NAME);
    if (count >= MAX_CACHE_ENTRIES) {
      await evictOldest(db);
    }

    await db.put(CACHE_STORE_NAME, entry);
    console.log(`[AheadSub Cache] Stored: ${cacheKey}`);
  } catch (error) {
    console.error('[AheadSub Cache] Store error:', error);
  }
}

/**
 * Clear all cached subtitles.
 */
export async function clearCache(): Promise<void> {
  try {
    const db = await getDB();
    await db.clear(CACHE_STORE_NAME);
    console.log('[AheadSub Cache] Cleared');
  } catch (error) {
    console.error('[AheadSub Cache] Clear error:', error);
  }
}

/**
 * Delete a specific cache entry.
 */
export async function deleteCacheEntry(id: string): Promise<void> {
  try {
    const db = await getDB();
    await db.delete(CACHE_STORE_NAME, id);
  } catch (error) {
    console.error('[AheadSub Cache] Delete error:', error);
  }
}

/**
 * Get all cache entries (for display in options page).
 */
export async function getAllCacheEntries(): Promise<CacheEntry[]> {
  try {
    const db = await getDB();
    return (await db.getAll(CACHE_STORE_NAME)) as CacheEntry[];
  } catch (error) {
    console.error('[AheadSub Cache] GetAll error:', error);
    return [];
  }
}

/**
 * Get total cache size estimate.
 */
export async function getCacheSize(): Promise<{ entries: number; sizeBytes: number }> {
  try {
    const db = await getDB();
    const entries = (await db.getAll(CACHE_STORE_NAME)) as CacheEntry[];
    const sizeBytes = entries.reduce((sum, e) => sum + (e.sizeBytesEstimate || 0), 0);
    return { entries: entries.length, sizeBytes };
  } catch {
    return { entries: 0, sizeBytes: 0 };
  }
}

/**
 * Evict the oldest cache entries to make room.
 */
async function evictOldest(db: IDBPDatabase, count: number = 10): Promise<void> {
  const tx = db.transaction(CACHE_STORE_NAME, 'readwrite');
  const index = tx.store.index('accessedAt');
  let cursor = await index.openCursor();
  let evicted = 0;

  while (cursor && evicted < count) {
    await cursor.delete();
    cursor = await cursor.continue();
    evicted++;
  }

  await tx.done;
  console.log(`[AheadSub Cache] Evicted ${evicted} entries`);
}
