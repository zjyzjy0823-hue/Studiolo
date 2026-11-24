import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  blobResult,
  externalResultFromPayload,
  isJsonContentType,
} from '../src/services/hermesMedia.ts'

test('识别 JSON 响应（外链模式）', () => {
  assert.equal(isJsonContentType('application/json'), true)
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true)
  assert.equal(isJsonContentType('application/octet-stream'), false)
  assert.equal(isJsonContentType(null), false)
})

test('外链载荷转成 external 结果', () => {
  const result = externalResultFromPayload({
    url: 'https://dl.isidel.com/p/dl/a.md?sign=abc:1800000000',
    fileName: 'a.md',
    sizeBytes: 64 * 1024 * 1024,
  })
  assert.equal(result.kind, 'external')
  assert.match(result.url, /^https:\/\/dl\.isidel\.com\//)
  assert.equal(result.fileName, 'a.md')
  assert.equal(result.sizeBytes, 64 * 1024 * 1024)
})

test('缺少 url 必须报错，不能返回空链接', () => {
  assert.throws(() => externalResultFromPayload({ fileName: 'a.md' }), /未返回下载地址/)
  assert.throws(() => externalResultFromPayload({ url: '' }), /未返回下载地址/)
  assert.throws(() => externalResultFromPayload(null), /未返回下载地址/)
})

test('载荷省略 sizeBytes 时回退到 resolve 给出的大小', () => {
  const result = externalResultFromPayload({ url: 'https://x/y' }, 1234)
  assert.equal(result.kind, 'external')
  assert.equal(result.sizeBytes, 1234)
})

test('blob 大小必须与 resolve 一致', () => {
  const ok = blobResult(new Blob([new Uint8Array([1, 2, 3, 4])]), 4)
  assert.equal(ok.kind, 'blob')
  assert.equal(ok.blob.size, 4)
  assert.throws(() => blobResult(new Blob([new Uint8Array([1, 2])]), 9), /字节不完整/)
  assert.throws(() => blobResult(new Blob([]), 0), /字节不完整/)
})
