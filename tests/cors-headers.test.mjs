import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// 客户端自定义请求头必须出现在 Core 的 CORS allow_headers 里，
// 否则 WebView 的预检会 400，fetch 直接失败（表现为「无法连接到 Studiolo 后端」）。

const SRC = new URL('../src', import.meta.url).pathname
const MAIN = new URL('../backend/app/main.py', import.meta.url).pathname

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|vue|js)$/.test(name)) out.push(full)
  }
  return out
}

function clientCustomHeaders() {
  const found = new Set()
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/['"](X-[A-Za-z0-9-]+)['"]/g)) found.add(match[1])
  }
  return [...found]
}

function coreAllowedHeaders() {
  const text = readFileSync(MAIN, 'utf8')
  const match = text.match(/allow_headers=\[([^\]]*)\]/)
  assert.ok(match, 'backend/app/main.py 里找不到 allow_headers')
  return match[1]
    .split(',')
    .map(part => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .map(header => header.toLowerCase())
}

test('客户端用到的每个 X-* 请求头都在 Core 的 CORS allow_headers 白名单里', () => {
  const headers = clientCustomHeaders()
  const allowed = coreAllowedHeaders()
  assert.ok(headers.length > 0, '没有在 src/ 里找到任何 X-* 请求头')
  const missing = headers.filter(header => !allowed.includes(header.toLowerCase()))
  assert.deepEqual(missing, [], `这些自定义请求头没进 CORS 白名单：${missing.join(', ')}（WebView 预检会 400）`)
})
