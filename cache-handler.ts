/**
 * 本番用エントリポイント。`next.config.ts` の `cacheHandlers.default` から参照される。
 *
 * テスト容易性のため、Redis クライアントの生成と組み立ては `createCacheHandler` に
 * 委譲する。
 */
import Redis from 'ioredis'

import { createCacheHandler } from './create-handler.mts'

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  retryStrategy(times) {
    return Math.min(times * 50, 200)
  },
  lazyConnect: false,
})

let state: 'initial' | 'connected' | 'disconnected' = 'initial'

redis.on('ready', () => {
  if (state === 'disconnected') {
    console.info('[cache-handler] redis reconnected')
  }
  state = 'connected'
})

redis.on('error', () => {
  // ioredis requires an error listener to avoid uncaught exceptions.
})

redis.on('close', () => {
  if (state === 'connected') {
    console.warn('[cache-handler] redis connection lost, falling back to uncached')
  }
  state = 'disconnected'
})

export default createCacheHandler(redis)
