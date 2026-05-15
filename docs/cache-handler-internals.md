# Cache Handler の内部構造

`create-handler.mts` が Redis 上にどんなデータを置き、`refreshTags()` がそれをどう扱っているかを、実際のキー・値の例とともに説明する。

## Redis 上のデータ構造

ハンドラが使う Redis のキーは3種類。

### ① エントリ本体（`next-cache:entry:*`）

`"use cache"` で生成されたキャッシュデータ本体。キー名は Next.js が決めるハッシュ値。

```
KEY:   next-cache:entry:abc123def456
VALUE: {"value":"<base64エンコードされたHTML/RSCペイロード>",
        "tags":["posts","user:42"],
        "stale":300,
        "timestamp":1715750000000,
        "expire":3600,
        "revalidate":60}
TTL:   3600秒
```

### ② タグのタイムスタンプ（`next-cache:tag:*`）

「このタグがいつ無効化されたか」を表す単一の数値（ミリ秒）。`updateTags` で書かれる。

```
KEY:   next-cache:tag:posts
VALUE: "1715750123456"
TTL:   604800秒（7日）

KEY:   next-cache:tag:user:42
VALUE: "1715750200000"
TTL:   604800秒
```

### ③ 無効化されたタグの一覧（`next-cache:revalidated-tags`）

Redis の Set 型。②のキーの「タグ名」だけを集めたインデックス。これがないと「どのタグが無効化されているか」を全件スキャンする必要がある。

```
KEY:   next-cache:revalidated-tags  (型: SET)
VALUE: {"posts", "user:42", "products", "old-tag-already-expired"}
```

## 全体の設計：タイムスタンプ方式での無効化

- `updateTags(tag)` が呼ばれると、Redis に「このタグは時刻 T に無効化された」というタイムスタンプを書き込む
- `get` のとき、エントリの作成時刻より新しいタグタイムスタンプがあれば miss 扱いにする
- 各プロセスは「タグ → 最終無効化時刻」のローカルマップ (`localTagTimestamps`) を持つ
- 別の Next.js タスク（Fargate の別コンテナなど）が `revalidateTag` を呼ぶとローカルマップが古くなるので、定期的に `refreshTags()` で Redis から最新状態を引き直す

## refreshTags の流れ

### ① スナップショット

```ts
const snapshot = new Set(localTagTimestamps.keys())
```

EVAL を呼ぶ前にローカルマップが持っていたキーを覚えておく。後段のトリム処理で使う伏線。

### ② Lua スクリプトで Redis を atomic に処理

`REVALIDATED_TAGS_SET` を見て、各タグについて：

- タイムスタンプキーがまだ生きていれば `[name, ts]` を結果に追加
- タイムスタンプが TTL で消えていれば、Set からそのタグ名も `SREM` で除去

「SMEMBERS してから個別に GET」だと、その隙に `updateTags` が走ってタイムスタンプを書いた瞬間に「消えている」と誤判定してしまうため、Lua で atomic に実行する。

### ③ 結果をローカルマップに反映

Lua の戻り値は `[name1, ts1, name2, ts2, ...]` というフラット配列なので、2個ずつ読んで `localTagTimestamps` を更新。同時に「今回 Redis 側で生きていたタグ」を `seen` に記録する。

### ④ 古くなったキーを掃除

```ts
for (const name of snapshot) {
  if (!seen.has(name)) {
    localTagTimestamps.delete(name)
  }
}
```

- `snapshot` に入っていた = EVAL 前からローカルにあったキー
- `seen` に入っていない = Redis から消えていたキー

両方を満たすキーだけ削除する。

**なぜ「現在のローカルマップ」ではなく「スナップショット」と比較するのか**

`await redis.eval(...)` で待っている間に、別の処理が `updateTags(['new-tag'])` を呼んで `localTagTimestamps.set('new-tag', now)` をしている可能性がある。もし「現在のローカルマップ全部」を `seen` と比較してしまうと、その新しいタグまで「Redis にいなかった」と誤判定して消してしまう。スナップショットに固定しておけば、EVAL 中に追加された新顔は削除対象から外れる。

## 具体的なシーケンスで追ってみる

### T=0：`revalidateTag('posts')` がタスク A で呼ばれる

`updateTags(['posts'])` が走る。

```
SET next-cache:tag:posts "1715750000000" EX 604800
SADD next-cache:revalidated-tags "posts"
```

Redis の状態：

```
next-cache:tag:posts        = "1715750000000"
next-cache:revalidated-tags = {"posts"}
```

各プロセスのローカルマップ：

- タスク A: `localTagTimestamps = { posts: 1715750000000 }`
- タスク B: `localTagTimestamps = {}` ← **まだ知らない**

### T=1：タスク B で `refreshTags()` が呼ばれる

①スナップショット: `snapshot = new Set()` （空）

②Lua の動き（`tag_prefix = "next-cache:tag:"`）：

```
members = SMEMBERS next-cache:revalidated-tags
        = ["posts"]

i=1: member = "posts"
     ts = GET next-cache:tag:posts
        = "1715750000000"   ← 生きてる
     result に "posts", "1715750000000" を追加
```

戻り値：`["posts", "1715750000000"]`

③反映：`localTagTimestamps.set("posts", 1715750000000)` → `seen = {"posts"}`

④掃除：`snapshot` が空なのでループは何もしない

タスク B のローカル：`localTagTimestamps = { posts: 1715750000000 }` ✅

### T=2（7日後）：タイムスタンプの TTL 切れ

`next-cache:tag:posts` の TTL が切れて消える。しかし `revalidated-tags` Set には `"posts"` が残ったまま（Set 自体には TTL がない）。

```
next-cache:tag:posts        = (なし、TTL 切れ)
next-cache:revalidated-tags = {"posts"}  ← ゴミが残っている
```

### T=3：誰かが `refreshTags()` を呼ぶ

②Lua の動き：

```
members = SMEMBERS next-cache:revalidated-tags
        = ["posts"]

i=1: member = "posts"
     ts = GET next-cache:tag:posts
        = nil   ← 消えてる
     SREM next-cache:revalidated-tags "posts"   ← Set からも消す
```

戻り値：`[]`

Redis の状態（Lua 実行後）：

```
next-cache:revalidated-tags = {}   ← ゴミが掃除された
```

④の掃除ループ：`snapshot = {"posts"}`, `seen = {}` なので `localTagTimestamps.delete("posts")` → ローカルも一致。

### スナップショットの存在意義が際立つケース

T=3 の Lua 実行中に、並行して別の `updateTags(['breaking-news'])` が走ったとする。

- ローカルマップに `breaking-news: <now>` がセットされる
- Redis にも `next-cache:tag:breaking-news` と Set への追加が走る

`refreshTags()` 視点：

- `snapshot` = `{"posts"}` （EVAL を呼ぶ前に固定済み。`breaking-news` は含まれない）
- `seen` = `{}` （Lua は posts しか見ていない＝`breaking-news` は Lua にとっては「Set にまだ無い or 取得タイミング外」）

もし④で `localTagTimestamps` の全キーを `seen` と比較していたら、せっかく `updateTags` が書いた `breaking-news` を「Redis に居ない」と誤判定して削除してしまう。スナップショットに固定することで、掃除の対象は「EVAL 前から知っていたタグ」だけに絞られ、並行更新を巻き込まない。
