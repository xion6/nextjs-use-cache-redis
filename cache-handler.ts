import Redis from 'ioredis'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

interface CacheEntry {
  value: ReadableStream<Uint8Array>
  tags: string[]
  stale: number
  timestamp: number
  expire: number
  revalidate: number
}

interface StoredEntry {
  valueBase64: string
  tags: string[]
  stale: number
  timestamp: number
  expire: number
  revalidate: number
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)))
}

function bufferToStream(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer))
      controller.close()
    },
  })
}

export default {
  async get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined> {
    const data = await redis.get(cacheKey)
    if (!data) return undefined
    const stored: StoredEntry = JSON.parse(data)

    const now = Date.now()
    if (now > stored.timestamp + stored.revalidate * 1000) {
      return undefined
    }

    return {
      value: bufferToStream(Buffer.from(stored.valueBase64, 'base64')),
      tags: stored.tags,
      stale: stored.stale,
      timestamp: stored.timestamp,
      expire: stored.expire,
      revalidate: stored.revalidate,
    }
  },

  async set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
    const entry = await pendingEntry
    const buffer = await streamToBuffer(entry.value)
    const stored: StoredEntry = {
      valueBase64: buffer.toString('base64'),
      tags: entry.tags,
      stale: entry.stale,
      timestamp: entry.timestamp,
      expire: entry.expire,
      revalidate: entry.revalidate,
    }
    await redis.set(cacheKey, JSON.stringify(stored), 'EX', entry.expire)
  },

  async refreshTags(): Promise<void> {
    // 単一クラスタ構成のため no-op
  },

  async getExpiration(tags: string[]): Promise<number> {
    return 0
  },

  async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
    // タグベースの無効化が必要な場合はここに実装する
  },
}
