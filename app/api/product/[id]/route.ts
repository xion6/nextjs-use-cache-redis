import { cacheLife, cacheTag } from 'next/cache'
import { NextResponse } from 'next/server'

export function generateStaticParams() {
  return [{ id: '1' }]
}

async function getProduct(id: string) {
  'use cache'
  cacheTag(`product-${id}`)
  // 検証中に時間ベースの再検証が混ざらないよう長めの profile を使う
  cacheLife('weeks')
  return {
    id,
    rand: Math.round(Math.random() * 1000) / 1000,
    pid: process.pid,
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const product = await getProduct(id)
  return NextResponse.json(product)
}
