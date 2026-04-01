import Redis from 'ioredis'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

interface CacheEntry {
  value: ReadableStream
  timestamp: number
  revalidate: number
  expire: number
  stale: number
  tags: string[]
}

interface StoredEntry {
  valueBase64: string
  timestamp: number
  revalidate: number
  expire: number
  stale: number
  tags: string[]
}

async function streamToBuffer(stream: ReadableStream): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)))
}

function bufferToStream(buffer: Buffer): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer))
      controller.close()
    },
  })
}

export default {
  async get(key: string): Promise<CacheEntry | undefined> {
    const data = await redis.get(key)
    if (!data) return undefined
    const stored: StoredEntry = JSON.parse(data)
    return {
      ...stored,
      value: bufferToStream(Buffer.from(stored.valueBase64, 'base64')),
    }
  },

  async set(key: string, value: Promise<CacheEntry> | CacheEntry, ttl?: number) {
    const entry = await value
    const buffer = await streamToBuffer(entry.value)
    const stored: StoredEntry = {
      ...entry,
      valueBase64: buffer.toString('base64'),
    }
    const serialized = JSON.stringify(stored)
    if (ttl) {
      await redis.set(key, serialized, 'EX', ttl)
    } else {
      await redis.set(key, serialized)
    }
  },

  async delete(key: string) {
    await redis.del(key)
  },
}
