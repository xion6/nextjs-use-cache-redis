/**
 * Next.js 16 `cacheHandlers` 用のカスタムハンドラ実装。
 *
 * - `"use cache"` で生成されるエントリを Redis / Valkey に保存し、複数の
 *   Next.js インスタンス（Fargate 複数タスク）で共有する。
 * - `revalidateTag` / `revalidatePath` の伝播は timestamp ベースの遅延無効化で行う。
 *   `updateTags` で書いた tag タイムスタンプを `getExpiration` / `get` が読み、
 *   エントリ作成より後に無効化されたタグがあれば miss 扱いにする。
 */

export const ENTRY_PREFIX = 'next-cache:entry:'
export const TAG_TS_PREFIX = 'next-cache:tag:'
export const REVALIDATED_TAGS_SET = 'next-cache:revalidated-tags'

export interface CacheEntry {
  value: ReadableStream<Uint8Array>
  tags: string[]
  stale: number
  timestamp: number
  expire: number
  revalidate: number
}

export interface CacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>
  refreshTags(): Promise<void>
  getExpiration(tags: string[]): Promise<number>
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>
}

export interface RedisPipeline {
  set(key: string, value: string, mode: 'EX', seconds: number): RedisPipeline
  sadd(key: string, member: string): RedisPipeline
  exec(): Promise<unknown>
}

/**
 * ハンドラが必要とする Redis クライアントの最小インターフェース。
 * ioredis の `Redis` クラスはこれに構造的に互換。
 */
export interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
  mget(...keys: string[]): Promise<(string | null)[]>
  smembers(key: string): Promise<string[]>
  multi(): RedisPipeline
}

interface StoredEntry {
  value: string
  tags: string[]
  stale: number
  timestamp: number
  expire: number
  revalidate: number
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

function bufferToStream(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer))
      controller.close()
    },
  })
}

function createOnceWarn() {
  const fired = new Set<string>()

  return {
    warn(category: string, message: string) {
      if (fired.has(category)) return
      fired.add(category)
      console.warn(`[cache-handler] ${category}: ${message}`)
    },
    reset() {
      fired.clear()
    },
  }
}

export function createCacheHandler(redis: RedisLike): CacheHandler {
  const { warn, reset: resetWarnings } = createOnceWarn()

  const localTagTimestamps = new Map<string, number>()

  const pendingSets = new Map<string, Promise<void>>()

  const maxTagTimestamp = (tags: readonly string[]): number => {
    let max = 0
    for (const tag of tags) {
      const ts = localTagTimestamps.get(tag) ?? 0
      if (ts > max) max = ts
    }
    return max
  }

  return {
    async get(cacheKey, softTags) {
      try {
        const pending = pendingSets.get(cacheKey)
        if (pending) await pending

        const raw = await redis.get(ENTRY_PREFIX + cacheKey)
        resetWarnings()
        if (!raw) return undefined

        const stored = JSON.parse(raw) as StoredEntry
        const now = Date.now()

        if (now > stored.timestamp + stored.revalidate * 1000) {
          return undefined
        }

        if (maxTagTimestamp(stored.tags) > stored.timestamp) {
          return undefined
        }

        if (maxTagTimestamp(softTags) > stored.timestamp) {
          return undefined
        }

        return {
          value: bufferToStream(Buffer.from(stored.value, 'base64')),
          tags: stored.tags,
          stale: stored.stale,
          timestamp: stored.timestamp,
          expire: stored.expire,
          revalidate: stored.revalidate,
        }
      } catch (err) {
        warn('get miss', (err as Error).message)
        return undefined
      }
    },

    async set(cacheKey, pendingEntry) {
      let resolveTracker!: () => void
      const tracker = new Promise<void>((res) => {
        resolveTracker = res
      })
      pendingSets.set(cacheKey, tracker)

      try {
        const entry = await pendingEntry
        const buffer = await streamToBuffer(entry.value)

        const stored: StoredEntry = {
          value: buffer.toString('base64'),
          tags: entry.tags,
          stale: entry.stale,
          timestamp: entry.timestamp,
          expire: entry.expire,
          revalidate: entry.revalidate,
        }

        await redis.set(
          ENTRY_PREFIX + cacheKey,
          JSON.stringify(stored),
          'EX',
          Math.max(entry.expire, 1),
        )
        resetWarnings()
      } catch (err) {
        warn('set failed', (err as Error).message)
      } finally {
        resolveTracker()
        pendingSets.delete(cacheKey)
      }
    },

    async refreshTags() {
      try {
        const tagNames = await redis.smembers(REVALIDATED_TAGS_SET)
        resetWarnings()
        if (tagNames.length === 0) return

        const values = await redis.mget(...tagNames.map((t) => TAG_TS_PREFIX + t))
        for (let i = 0; i < tagNames.length; i++) {
          const name = tagNames[i]
          const raw = values[i]
          if (name === undefined || raw == null) continue
          const ts = Number(raw)
          if (Number.isFinite(ts) && ts > 0) {
            localTagTimestamps.set(name, ts)
          }
        }
      } catch (err) {
        warn('refreshTags failed', (err as Error).message)
      }
    },

    async getExpiration(tags) {
      return maxTagTimestamp(tags)
    },

    async updateTags(tags, _durations) {
      try {
        const now = Date.now()
        const pipeline = redis.multi()
        for (const tag of tags) {
          pipeline.set(TAG_TS_PREFIX + tag, String(now), 'EX', 60 * 60 * 24 * 7)
          pipeline.sadd(REVALIDATED_TAGS_SET, tag)
        }
        await pipeline.exec()
        resetWarnings()

        for (const tag of tags) {
          localTagTimestamps.set(tag, now)
        }
      } catch (err) {
        warn('updateTags failed', (err as Error).message)
      }
    },
  }
}
