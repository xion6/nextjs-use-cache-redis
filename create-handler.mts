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

/**
 * ハンドラの不変条件: エントリの寿命 (`expire`) < タグタイムスタンプの TTL
 *
 * タグタイムスタンプが先に TTL 切れで消えると、まだ生きているエントリに対し
 * 「無効化されていない」と誤判定して古いデータを hit として返してしまう。
 * それを防ぐため、エントリの expire を MAX_ENTRY_EXPIRE_SECONDS でクランプし、
 * タグの TTL を TAG_TTL_SECONDS（= クランプ値 + バッファ）に揃える。
 *
 * MAX を伸ばすほど長期キャッシュができるが、`next-cache:revalidated-tags` Set に
 * その期間分のタグ名が滫留し、refreshTags の Lua スクリプトの処理量も伸びる。
 * 高カーディナリティなタグ（user:<id>等）を多用するアプリでは短めにしてコストを押さえる。
 */
export const MAX_ENTRY_EXPIRE_SECONDS = 60 * 60 * 24 * 30 // 30日
export const TAG_TTL_SECONDS = MAX_ENTRY_EXPIRE_SECONDS + 60 * 60 * 24 // +1日のバッファ

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
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

interface StoredEntry {
  value: string
  tags: string[]
  stale: number
  timestamp: number
  expire: number
  revalidate: number
}

/**
 * SET 内の各メンバーについて、対応するタイムスタンプ key が消えていれば
 * SREM し、生きていれば [name, ts, ...] を返す。SREM とタイムスタンプ確認を
 * サーバー側で atomic に行うため、updateTags との競合で生存中のタグを
 * 取り違えて削除することがない。
 */
const REFRESH_TAGS_LUA = `
local set_key = KEYS[1]
local tag_prefix = ARGV[1]
local members = redis.call('SMEMBERS', set_key)
local result = {}
for i = 1, #members do
  local member = members[i]
  local ts = redis.call('GET', tag_prefix .. member)
  if ts then
    table.insert(result, member)
    table.insert(result, ts)
  else
    redis.call('SREM', set_key, member)
  end
end
return result
`

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

  // タグの OR セマンティクス: 1つのエントリは複数タグに紐づき、そのうち1つでも
  // エントリ作成より後に revalidate されていれば miss とする。
  // max > timestamp の単一比較でその「いずれかが新しい」を表現する。
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

        // タグタイムスタンプの TTL を超える expire を許すと、タグ記録が先に消えて
        // 古いエントリを hit として返してしまうため、上限でクランプする。
        // クランプが起きた場合は warn して运用者が気づけるようにする。
        const requestedExpire = entry.expire
        const clampedExpire = Math.min(
          Math.max(requestedExpire, 1),
          MAX_ENTRY_EXPIRE_SECONDS,
        )
        if (requestedExpire > MAX_ENTRY_EXPIRE_SECONDS) {
          warn(
            'expire clamped',
            `entry.expire=${requestedExpire}s exceeds MAX_ENTRY_EXPIRE_SECONDS=${MAX_ENTRY_EXPIRE_SECONDS}s; clamped to keep tag-timestamp TTL invariant.`,
          )
        }

        const stored: StoredEntry = {
          value: buffer.toString('base64'),
          tags: entry.tags,
          stale: entry.stale,
          timestamp: entry.timestamp,
          expire: clampedExpire,
          revalidate: entry.revalidate,
        }

        await redis.set(
          ENTRY_PREFIX + cacheKey,
          JSON.stringify(stored),
          'EX',
          clampedExpire,
        )
        resetWarnings()
      } catch (err) {
        warn('set failed', (err as Error).message)
      } finally {
        resolveTracker()
        pendingSets.delete(cacheKey)
      }
    },

    // Next.js が新しいリクエストを処理する前に定期的に呼ぶ。
    // 別プロセス（別 Fargate タスクなど）が updateTags した結果を Redis から引き直し、
    // ローカルマップ localTagTimestamps を最新状態にそろえる役割。プル型同期の入口。
    async refreshTags() {
      try {
        // EVAL を呼ぶ前の局所状態をスナップショット。EVAL 実行中に updateTags が
        // 新たに書き込んだエントリを誤って削除しないため、トリム対象は
        // この時点で既に存在していたキーに限定する。
        const snapshot = new Set(localTagTimestamps.keys())

        const tagPairsFlat = (await redis.eval(
          REFRESH_TAGS_LUA,
          1,
          REVALIDATED_TAGS_SET,
          TAG_TS_PREFIX,
        )) as string[]
        resetWarnings()

        const liveTagNames = new Set<string>()
        for (let i = 0; i + 1 < tagPairsFlat.length; i += 2) {
          const tagName = tagPairsFlat[i]
          const tsRaw = tagPairsFlat[i + 1]
          if (tagName === undefined || tsRaw == null) continue
          const ts = Number(tsRaw)
          if (Number.isFinite(ts) && ts > 0) {
            localTagTimestamps.set(tagName, ts)
            liveTagNames.add(tagName)
          }
        }

        for (const tagName of snapshot) {
          if (!liveTagNames.has(tagName)) {
            localTagTimestamps.delete(tagName)
          }
        }
      } catch (err) {
        warn('refreshTags failed', (err as Error).message)
      }
    },

    // Next.js がリクエスト入口で「このタグ群は最近 revalidate されたか？」を
    // 安価に判定したいときに呼ぶ。get と違ってエントリ本体は触らずタグ鮮度のみ返す。
    // Infinity を返せば「soft tag の判定は get に委ねる」というオプトアウトになるが、
    // ここでは実値を返し、get 側でも二重チェックする防御寄りの構成。
    async getExpiration(tags) {
      return maxTagTimestamp(tags)
    },

    // ユーザコードが revalidateTag / revalidatePath / updateTag を呼んだとき、
    // Next.js が該当タグを引数に渡して呼んでくる。Redis に「このタグは今この時刻に
    // 無効化された」というタイムスタンプを書き込み、全プロセスから参照可能にする。
    async updateTags(tags, _durations) {
      try {
        const now = Date.now()
        // 複数タグ × 2 コマンドを 1 往復・atomic に書き込む。
        // 片方だけが書かれた中途半端な状態を他プロセスに見せないため。
        const pipeline = redis.multi()
        for (const tag of tags) {
          // ① 無効化時刻の本体。get の鮮度判定で読まれる正本データ。
          // TTL は set 側でクランプしているエントリ expire 上限より長いことが
          // 定数で保証されている。これにより「タグ記録が先に消えて
          // 生きているエントリを誤って hit として返す」状態が構造的に起きない。
          pipeline.set(TAG_TS_PREFIX + tag, String(now), 'EX', TAG_TTL_SECONDS)
          // ② refreshTags が SMEMBERS で列挙するための索引。
          // これがないと「いま無効化中の全タグ」を引くのに KEYS スキャンが必要になる。
          pipeline.sadd(REVALIDATED_TAGS_SET, tag)
        }
        await pipeline.exec()
        resetWarnings()

        // 自プロセスは refreshTags の往復を待たず即時にローカルへも反映する。
        for (const tag of tags) {
          localTagTimestamps.set(tag, now)
        }
      } catch (err) {
        warn('updateTags failed', (err as Error).message)
      }
    },
  }
}
