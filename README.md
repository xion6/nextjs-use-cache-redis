# nextjs-use-cache-redis

Next.js の `'use cache'` ディレクティブと Redis カスタムキャッシュハンドラーの動作検証プロジェクト。

ECS のようなマルチタスク環境では、デフォルトのインメモリキャッシュはプロセス間で共有されない。このプロジェクトでは Redis をキャッシュバックエンドとして使い、複数プロセス間でキャッシュが共有されることを確認する。

## セットアップ

```bash
# Redis を起動
docker run -d --name redis -p 6379:6379 redis

# 依存パッケージをインストール
npm install

# プロダクションビルド（use cache は dev モードでは動作しない）
npm run build
```

## 検証

2つのプロセスを別ポートで起動する。

```bash
npx next start -p 3001 &
npx next start -p 3002 &
```

両方が `Ready` になったら順番にリクエストを送る。

```bash
curl http://localhost:3001/api/cached-value
curl http://localhost:3002/api/cached-value
```

**期待する結果:**

```json
{"value":0.871,"pid":1001}
{"value":0.871,"pid":1002}
```

`value` が同じ、`pid` が異なる → Redis 経由でキャッシュが共有されている。

> **注意:** `curl` を `&` で並列実行すると、両プロセスが同時にキャッシュミスして別の値を生成するため一致しない。必ず順番に実行する。

## 停止

```bash
kill $(lsof -t -i :3001) $(lsof -t -i :3002)
docker stop redis
```

## docker compose で検証

ECS/Fargate に近い container-to-container 構成での検証手順。Redis + Next.js x 2 をすべてコンテナで起動する。

```bash
# 起動（初回はビルドあり、~1分）
docker compose up -d --build

# 同じシナリオで curl
curl http://localhost:3001/api/cached-value
curl http://localhost:3002/api/cached-value

# 後片付け
docker compose down
```

### host 検証との差

機能的には同じ結果になる（キャッシュ共有・fail-open・警告サイクル）が、1 点だけ違いが出る:

- **Redis 停止直後の初回リクエスト**: host 検証では Docker ポートフォワーダが即座に RST を返すので ~1 秒で打ち切られるが、compose では container-to-container の TCP SYN タイムアウトに引っかかり ~8 秒かかる。2 回目以降は ioredis 内部状態が disconnected になり ~1 秒に戻る
- 本番（ENI 切断、SG 遮断、NAT 経由の間欠断）は後者に近いので、レイテンシ要件が厳しいなら ioredis の `connectTimeout` を短くする調整余地がある

## generateStaticParams + use cache での非伝搬の再現

`cacheHandlers`（複数形）は `'use cache'` のエントリ層しかカバーしない。`generateStaticParams` で列挙したパスはビルド時に静的プリレンダされ、その出力は各インスタンスのファイルシステムに焼かれる。そのため `revalidateTag` を片側で呼んでも、他インスタンスの静的プリレンダ出力には伝わらない。

`app/api/product/[id]/route.ts` がこの状況の最小再現になっている:

- `generateStaticParams` が `[{ id: '1' }]` を返す
- `getProduct` が `'use cache'` で `cacheTag('product-${id}')` を付ける
- `cacheLife('weeks')` で時間ベースの再検証を排除している

検証スクリプトを用意した:

```bash
docker compose up -d --build
./verify-product-revalidate.sh
docker compose down
```

**期待される（バグを示す）出力:**

- 初期取得: A と B の `rand` が一致（ビルド時に焼かれた同じ値）
- A 側でのみ `revalidate?tag=product-1` を実行
- 再取得: **A の `rand` だけ更新され、B は古いまま**

これは `cacheHandler`（単数形）が未設定で、ISR / Route Handler レスポンス層が各インスタンスのローカルファイルシステムに閉じているために起きる。単数形ハンドラを Redis 経由で実装すれば閉じる。
