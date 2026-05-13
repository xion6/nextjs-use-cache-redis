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
