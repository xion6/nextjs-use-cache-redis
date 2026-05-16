# Cache Handler の内部構造

`create-handler.mts` が Redis 上にどんなデータを置き、`refreshTags()` がそれをどう扱っているかを、実際のキー・値の例とともに説明する。

## Redis 上のデータ構造

ハンドラが使う Redis のキーは3種類。

### ① エントリ本体（`next-cache:entry:*`）

`"use cache"` で生成されたエントリ本体。キー名は Next.js が決めるハッシュ値。

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
TTL:   2678400秒（31日）

KEY:   next-cache:tag:user:42
VALUE: "1715750200000"
TTL:   2678400秒
```

> TTL は「このタグを参照しうる全エントリの expire 上限」より長くする必要がある。
> タグタイムスタンプが先に消えると、まだ生きているエントリに対して「無効化されていない」と誤判定してしまうため。
> 本ハンドラではエントリの expire を `MAX_ENTRY_EXPIRE_SECONDS`（30日）でクランプし、
> タグ TTL を `TAG_TTL_SECONDS`（= 30日 + 1日バッファ = 31日）にすることでこの不等式を定数で担保する。

### ③ 無効化されたタグの一覧（`next-cache:revalidated-tags`）

Redis の Set 型。②のキーの「タグ名」だけを集めたインデックス。これがないと「どのタグが無効化されているか」を全件スキャンする必要がある。

```
KEY:   next-cache:revalidated-tags  (型: SET)
VALUE: {"posts", "user:42", "products", "old-tag-already-expired"}
```

## 全体の設計：タイムスタンプ方式での無効化

このハンドラの肝は「タグが無効化されたとき、該当するエントリを **削除しない**」という設計判断にある。代わりに「タグが無効化された時刻」だけを記録しておき、エントリを読み出すときに比較する。なぜそうするのかを順に説明する。

### ① 削除ではなくタイムスタンプを書く

`updateTags(tag)` が呼ばれたとき、素直な発想は「そのタグを持つエントリを Redis から全部消す」だが、これには `next-cache:entry:*` を全件スキャンして tags フィールドを調べる必要があり、エントリ数が増えるほど重くなる。

そこで「このタグは時刻 T に無効化された」というタイムスタンプを `next-cache:tag:<tag>` に1つ書くだけで済ませる。**1タグの無効化が O(1) の書き込み**で終わるのが大きな利点。エントリ本体は TTL で自然消滅するまで残しておく（読まれた時点で miss 扱いされるので結果は同じ）。

### ② 読み出し時に「作成時刻 vs 無効化時刻」を比較する

`get` で取り出したエントリには `timestamp`（作成時刻）が入っている。そのエントリに紐づくタグのタイムスタンプを引いて、**1つでも `timestamp` より新しい無効化時刻があれば miss として扱う**。「無効化された後に作られたエントリならまだ有効」「無効化される前に作られたエントリは古い」という単純な大小比較で判定できる。

この遅延無効化の方式は、無効化のコストを「書き込み時」から「読み出し時」に移している、と言い換えてもよい。

### ③ タグタイムスタンプはプロセスごとにローカルキャッシュする

`get` のたびに Redis からタグタイムスタンプを引いていると、エントリ取得 1 回につき追加で N 回（タグの数だけ）の往復が発生してしまう。これを避けるため、各プロセスは「タグ → 最終無効化時刻」のマップ（以下「ローカルマップ」と呼ぶ）をメモリに持ち、`get` 中の判定はこのローカルマップだけで完結させる。

### ④ ローカルキャッシュは `refreshTags()` で同期する

問題は、Fargate の別タスクや別プロセスが `revalidateTag` を呼んだ場合、自分のローカルマップにはその更新が反映されないこと。Redis 側のタイムスタンプは最新でも、自分のプロセスは古いマップを見続けてしまい、本来 miss すべきリクエストに hit を返してしまう。

そこで Next.js は適切なタイミングで `refreshTags()` を呼び、ハンドラ側は Redis の `next-cache:revalidated-tags` Set を引き直してローカルマップを最新状態にそろえる。「無効化を書いた側がすべてのプロセスに通知する」プッシュ型ではなく、「読む側が必要なときに引き直す」プル型なので、プロセス間通信や Pub/Sub を必要としない。

### ⑤ 起動直後はゲートで強制 miss にする

③④ の仕組みは「ローカルマップが Redis と同期できている」前提に立っている。プロセス起動直後はローカルマップが空で、その状態で `get` が走ると `maxTagTimestamp = 0` となり、Redis 上には残っている revalidate 済みエントリを「無効化されていない」と誤判定して hit を返してしまう。

そこで `tagsBootstrapped` フラグを持ち、初回 `refreshTags()` 成功までは `get` を強制 `undefined`、`getExpiration` を `Date.now()` にする。Next.js は毎リクエスト前に `refreshTags()` を呼ぶ仕様なので、Redis が生きていれば最初のリクエストでゲートが開く。

一度 true にしたあとは false に戻さない。Next.js が推奨する「`refreshTags` 失敗時は last known local tag state で運転継続」に合わせるため。代わりに、定常運用中の Redis 一時障害では復旧までのあいだ新規の revalidate を見落とす窓が残る — 可用性とのトレードオフとして受容する。

### ⑥ エントリ寿命の上限でタグ TTL との不等式を担保する

このタイムスタンプ方式の正しさは **「タグタイムスタンプの TTL > そのタグを参照しうる全エントリの expire」** という不等式に依存している。これが崩れると、TTL 切れで消えたタグタイムスタンプを参照できなくなり、まだ生きているエントリを `get` したときに `maxTagTimestamp = 0` となって「無効化されていない」と誤判定し、**古いデータを hit として返してしまう**。

エラーも warn も出ず、長期間運用してから初めて顕在化するため、検知も再現も難しい。

そこで本ハンドラでは **ユーザコードが指定した `cacheLife` の `expire` を `MAX_ENTRY_EXPIRE_SECONDS`（30日）でクランプ** し、タグ TTL を `TAG_TTL_SECONDS`（31日）に固定することで、この不等式を定数で担保している。

- クランプが発生した場合は warn を出す（運用で気づけるように）
- MAX を伸ばすほど長期キャッシュが効くが、`revalidated-tags` Set にその期間ぶんのタグ名が滞留し、`refreshTags` の Lua スクリプトの処理量も増える
- 高カーディナリティなタグ（`user:<id>` など）を多用するアプリでは MAX を短めにしてコストを抑えるのが妥当

## refreshTags の流れ

### ① スナップショット

EVAL を呼ぶ前のローカルマップのキー集合（タグ名）を `Set` として固定する。後段のトリム処理で使う伏線。

### ② Lua スクリプトで Redis を atomic に処理

`REVALIDATED_TAGS_SET` を見て、各タグについて：

- タイムスタンプキーがまだ生きていれば `[name, ts]` を結果に追加
- タイムスタンプが TTL で消えていれば、Set からそのタグ名も `SREM` で除去

「SMEMBERS してから個別に GET」だと、その隙に `updateTags` が走ってタイムスタンプを書いた瞬間に「消えている」と誤判定してしまうため、Lua で atomic に実行する。

### ③ 結果をローカルマップに反映

Lua の戻り値は `[name, ts, name, ts, ...]` のフラットな配列。2個ずつ読んで「タグ → 最終無効化時刻」のローカルマップを更新する。同時に「今回 Lua から戻ってきたタグ名（＝Redis 側でタイムスタンプが生きていたタグ）」の集合を別途控えておく。これは次の掃除ステップで使う。

### ④ 古くなったキーを掃除

EVAL 前のスナップショットを走査して、**「EVAL 前からローカルに居た」かつ「Lua からの戻り値に含まれていない」** タグだけをローカルマップから削除する。

- 前者：EVAL 中に並行で書かれた新顔タグを巻き込まないため
- 後者：Redis 側で TTL 切れになって消えたタグを意味する

両方を満たすキー＝「ローカルにあったが Redis にはもう居ない」ものだけが削除対象になる。

**なぜ「現在のローカルマップ」ではなく「スナップショット」と比較するのか**

`await redis.eval(...)` で待っている間に、別の処理が `updateTags(['new-tag'])` を呼んでローカルマップに新しいタグを書き込んでいる可能性がある。もし「現在のローカルマップ全部」と Lua の結果を比較してしまうと、その新しいタグまで「Lua の結果に含まれていない＝Redis にいなかった」と誤判定して消してしまう。スナップショットに固定しておけば、EVAL 中に追加された新顔は削除対象から外れる。

## 具体的なシーケンスで追ってみる

### T=0：`revalidateTag('posts')` がタスク A で呼ばれる

`updateTags(['posts'])` が走る。

```
SET next-cache:tag:posts "1715750000000" EX 2678400
SADD next-cache:revalidated-tags "posts"
```

Redis の状態：

```
next-cache:tag:posts        = "1715750000000"
next-cache:revalidated-tags = {"posts"}
```

各プロセスのローカルマップ：

- タスク A: `{ posts: 1715750000000 }`
- タスク B: `{}` ← **まだ知らない**

### T=1：タスク B で `refreshTags()` が呼ばれる

①スナップショット: 空集合（タスク B のローカルマップはまだ空なので）

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

③反映：ローカルマップに `posts → 1715750000000` を書き込む。Lua から戻ってきたタグ名の集合は `{"posts"}`。

④掃除：スナップショットが空なのでループは何もしない

タスク B のローカルマップ：`{ posts: 1715750000000 }` ✅

### T=2（31日後）：タイムスタンプの TTL 切れ

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

④の掃除ループ：スナップショットは `{"posts"}`、Lua から戻ってきたタグ集合は `{}` なので、ローカルマップから `posts` を削除する。これでローカルと Redis の状態が一致する。

### スナップショットの存在意義が際立つケース

T=3 の Lua 実行中に、並行して別の `updateTags(['breaking-news'])` が走ったとする。

- ローカルマップに `breaking-news: <now>` がセットされる
- Redis にも `next-cache:tag:breaking-news` と Set への追加が走る

`refreshTags()` 視点：

- スナップショット = `{"posts"}` （EVAL を呼ぶ前に固定済み。`breaking-news` は含まれない）
- Lua から戻ってきたタグ集合 = `{}` （Lua は posts しか見ていない＝`breaking-news` は Lua にとっては「Set にまだ無い or 取得タイミング外」）

もし④でローカルマップの全キーを Lua の戻り値と比較していたら、せっかく `updateTags` が書いた `breaking-news` を「Redis に居ない」と誤判定して削除してしまう。スナップショットに固定することで、掃除の対象は「EVAL 前から知っていたタグ」だけに絞られ、並行更新を巻き込まない。
