# nextjs-use-cache-redis

Next.js の `use cache` ディレクティブと Redis カスタムキャッシュハンドラーの動作検証プロジェクト。

## 概要

- `'use cache'` ディレクティブ（Next.js 16+）を使ったサーバーサイドキャッシュ
- Redis をバックエンドにしたカスタムキャッシュハンドラー（`cache-handler.ts`）
- `/api/cached-value` エンドポイントでキャッシュの挙動を確認

## セットアップ

Redis が必要です（デフォルト: `redis://localhost:6379`）。

```bash
# Redis 起動（Docker を使う場合）
docker run -p 6379:6379 redis

# 依存パッケージインストール
npm install
```

環境変数でRedis URLを変更できます:

```bash
REDIS_URL=redis://your-host:6379 npm run dev
```

## 開発サーバーの起動

```bash
npm run dev
```

[http://localhost:3000](http://localhost:3000) をブラウザで開く。

## 動作確認

```bash
# キャッシュされた値を取得（同じ値が返ればキャッシュ有効）
curl http://localhost:3000/api/cached-value
```

`value` が同じで `pid` が異なる場合は、キャッシュが正常に機能しています。
