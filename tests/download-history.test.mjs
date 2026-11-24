import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addDownload,
  clearDownloads,
  isRecordOpenable,
  readDownloads,
  removeDownload,
} from '../src/services/downloadHistory.ts'

function memoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value) },
    get size() { return map.size },
  }
}

test('新记录排在最前，并且能读回来', () => {
  const storage = memoryStorage()
  addDownload({ name: 'a.md', sizeBytes: 10, channel: 'relay', status: 'saved' }, storage)
  addDownload({ name: 'b.md', sizeBytes: 20, channel: 'external', status: 'handed_off', url: 'https://x/y' }, storage)
  const list = readDownloads(storage)
  assert.equal(list.length, 2)
  assert.equal(list[0].name, 'b.md')
  assert.equal(list[0].channel, 'external')
  assert.equal(list[1].name, 'a.md')
  assert.equal(typeof list[0].at, 'number')
})

test('坏数据不会炸，只返回空列表', () => {
  const storage = memoryStorage()
  storage.setItem('studiolo.downloads.v1', '{not json')
  assert.deepEqual(readDownloads(storage), [])
  storage.setItem('studiolo.downloads.v1', JSON.stringify({ a: 1 }))
  assert.deepEqual(readDownloads(storage), [])
})

test('字段不合法的条目会被过滤掉', () => {
  const storage = memoryStorage()
  storage.setItem('studiolo.downloads.v1', JSON.stringify([
    { id: '1', name: 'ok.md', sizeBytes: 1, at: 1, channel: 'relay', status: 'saved' },
    { id: '2', name: 'bad.md', sizeBytes: 1, at: 1, channel: 'weird', status: 'saved' },
    { name: 'no-id.md' },
  ]))
  const list = readDownloads(storage)
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'ok.md')
})

test('最多保留 100 条', () => {
  const storage = memoryStorage()
  for (let i = 0; i < 105; i += 1) {
    addDownload({ name: `f${i}.md`, sizeBytes: 1, channel: 'relay', status: 'saved' }, storage)
  }
  const list = readDownloads(storage)
  assert.equal(list.length, 100)
  assert.equal(list[0].name, 'f104.md')
})

test('删除与清空', () => {
  const storage = memoryStorage()
  addDownload({ name: 'a.md', sizeBytes: 1, channel: 'relay', status: 'saved', id: 'x' }, storage)
  addDownload({ name: 'b.md', sizeBytes: 1, channel: 'relay', status: 'saved', id: 'y' }, storage)
  assert.equal(removeDownload('x', storage).length, 1)
  assert.equal(readDownloads(storage)[0].id, 'y')
  assert.deepEqual(clearDownloads(storage), [])
  assert.deepEqual(readDownloads(storage), [])
})

test('只有未过期的外链记录可以再次打开', () => {
  const now = 1_800_000_000_000
  const base = { id: '1', name: 'a.md', sizeBytes: 1, at: 1, status: 'handed_off' }
  assert.equal(isRecordOpenable({ ...base, channel: 'external', url: 'https://x/y', expiresAt: now / 1000 + 60 }, now), true)
  assert.equal(isRecordOpenable({ ...base, channel: 'external', url: 'https://x/y', expiresAt: now / 1000 - 60 }, now), false)
  assert.equal(isRecordOpenable({ ...base, channel: 'external', url: 'https://x/y' }, now), true)
  assert.equal(isRecordOpenable({ ...base, channel: 'relay' }, now), false)
})
