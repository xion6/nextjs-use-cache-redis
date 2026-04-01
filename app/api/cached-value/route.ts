import { cacheLife } from 'next/cache'
import { NextResponse } from 'next/server'

async function getCachedValue() {
  'use cache'
  cacheLife('seconds')
  return Math.random()
}

export async function GET() {
  const value = await getCachedValue()
  return NextResponse.json({ value, pid: process.pid })
}
