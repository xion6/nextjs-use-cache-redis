#!/usr/bin/env bash
# generateStaticParams + use cache の構成で、片側インスタンスへの
# revalidateTag が他インスタンスに伝搬しないことを確認する。
#
# 前提: docker compose up -d --build で nucr-next-a (3001), nucr-next-b (3002) が
# Ready になっていること。

set -eu

A=http://localhost:3001
B=http://localhost:3002
TAG=product-1
ID=1

hr() { printf -- '--- %s ---\n' "$1"; }

hr "1. 初期取得（両インスタンス）"
echo "A: $(curl -s $A/api/product/$ID)"
echo "B: $(curl -s $B/api/product/$ID)"

hr "2. A 側でのみ revalidateTag($TAG)"
echo "$(curl -s "$A/api/revalidate?tag=$TAG")"

hr "3. revalidate 後の取得（両インスタンス）"
echo "A: $(curl -s $A/api/product/$ID)"
echo "B: $(curl -s $B/api/product/$ID)"

hr "4. もう一度（伝搬待ち確認）"
sleep 1
echo "A: $(curl -s $A/api/product/$ID)"
echo "B: $(curl -s $B/api/product/$ID)"

cat <<'EOS'

--- 観察ポイント ---

【pid フィールドの読み方】
- pid は「この JSON を生成した Node プロセスの ID」
- ビルド時に焼かれた値なら pid = next build プロセスの ID（A/B のイメージに同じ値が焼かれる）
- ランタイムで再生成された値なら pid = そのコンテナの next start プロセスの ID

【期待される挙動】
1. 初期取得: A と B で rand も pid も完全一致
   → 同じイメージにビルド時の prerender が焼かれているため
2. revalidateTag 直後: まだ古い値が返ることがある（再生成はバックグラウンドで走る）
3. しばらく後: A だけ rand が変わり、pid も A のサーバプロセスの ID に変わる
   → A 側でランタイム再生成された証拠
4. B はずっと古いまま（rand も pid もビルド時のもの）
   → revalidateTag が他インスタンスに伝搬していない＝今回示したいバグ
EOS
