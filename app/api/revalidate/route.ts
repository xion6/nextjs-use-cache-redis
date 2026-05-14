import { revalidateTag } from 'next/cache'
import { type NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const tag = request.nextUrl.searchParams.get('tag')
  if (!tag) {
    return NextResponse.json(
      { revalidated: false, message: 'tag クエリパラメータが必要です' },
      { status: 400 },
    )
  }
  revalidateTag(tag, 'max')
  return NextResponse.json({
    revalidated: true,
    tag,
    pid: process.pid,
    now: Date.now(),
  })
}
