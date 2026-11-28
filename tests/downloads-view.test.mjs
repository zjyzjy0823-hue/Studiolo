import test from 'node:test'
import assert from 'node:assert/strict'
import {
  typeOf,
  formatBytesHuman,
  summarize,
  formatRecordTime,
  filterRecords,
} from '../src/services/downloadsView.ts'

test('1. typeOf 文件类型推断与边界处理', () => {
  // 图片
  assert.equal(typeOf('avatar.png'), 'image')
  assert.equal(typeOf('photo.JPG'), 'image')
  assert.equal(typeOf('diagram.svg'), 'image')
  assert.equal(typeOf('nested/path/to/hero.webp'), 'image')

  // 文档
  assert.equal(typeOf('report.pdf'), 'doc')
  assert.equal(typeOf('budget.XLSX'), 'doc')
  assert.equal(typeOf('notes.md'), 'doc')
  assert.equal(typeOf('data.csv'), 'doc')

  // 压缩包 (包括复合后缀 .tar.gz)
  assert.equal(typeOf('archive.zip'), 'archive')
  assert.equal(typeOf('bundle.tar.gz'), 'archive')
  assert.equal(typeOf('source.tar.bz2'), 'archive')
  assert.equal(typeOf('backup.7z'), 'archive')

  // 安装包
  assert.equal(typeOf('installer.dmg'), 'installer')
  assert.equal(typeOf('setup.exe'), 'installer')
  assert.equal(typeOf('package.pkg'), 'installer')
  assert.equal(typeOf('app.deb'), 'installer')

  // 其它
  assert.equal(typeOf('database.dump'), 'other')
  assert.equal(typeOf('run.log'), 'other')
  assert.equal(typeOf('.gitignore'), 'other')
  assert.equal(typeOf('noextension'), 'other')
  assert.equal(typeOf(''), 'other')
})

test('2. formatBytesHuman 字节格式化', () => {
  assert.equal(formatBytesHuman(0), '0 B')
  assert.equal(formatBytesHuman(-10), '0 B')
  assert.equal(formatBytesHuman(512), '512 B')
  assert.equal(formatBytesHuman(1024), '1.0 KB')
  assert.equal(formatBytesHuman(860160), '840 KB')
  assert.equal(formatBytesHuman(5033165), '4.8 MB')
  assert.equal(formatBytesHuman(1073741824), '1.00 GB')
})

test('3. summarize 汇总统计', () => {
  assert.deepEqual(summarize([]), {
    count: 0,
    totalBytes: 0,
    byType: { image: 0, doc: 0, archive: 0, installer: 0, other: 0 },
  })

  const records = [
    { name: 'photo.png', sizeBytes: 1000 },
    { name: 'doc.pdf', sizeBytes: 2000 },
    { name: 'sheet.xlsx', sizeBytes: 3000 },
    { name: 'archive.tar.gz', sizeBytes: 4000 },
    { name: 'setup.dmg', sizeBytes: 5000 },
    { name: 'data.dump', sizeBytes: 6000 },
  ]

  const s = summarize(records)
  assert.equal(s.count, 6)
  assert.equal(s.totalBytes, 21000)
  assert.equal(s.byType.image, 1)
  assert.equal(s.byType.doc, 2)
  assert.equal(s.byType.archive, 1)
  assert.equal(s.byType.installer, 1)
  assert.equal(s.byType.other, 1)
})

test('4. formatRecordTime 时间格式化', () => {
  const base = new Date(2026, 10, 28, 15, 30).getTime() // 2026-11-28 15:30
  // 今天
  assert.equal(formatRecordTime(new Date(2026, 10, 28, 10, 5).getTime(), base), '今天 10:05')
  // 昨天
  assert.equal(formatRecordTime(new Date(2026, 10, 27, 20, 15).getTime(), base), '昨天 20:15')
  // 同一年更早
  assert.equal(formatRecordTime(new Date(2026, 9, 15, 8, 0).getTime(), base), '10-15 08:00')
  // 跨年
  assert.equal(formatRecordTime(new Date(2025, 4, 1, 12, 0).getTime(), base), '2025-05-01')
})

test('5. filterRecords 关键词搜索、类型、时间筛选与排序', () => {
  const now = new Date(2026, 10, 28, 12, 0).getTime()
  const oneDay = 86400000

  const records = [
    { id: '1', name: 'finance-2026.xlsx', at: now - 3600000, sizeBytes: 5000, sessionKey: 'finance-bot' },
    { id: '2', name: 'preview.png', at: now - oneDay * 2, sizeBytes: 2000, sessionKey: 'design-agent' },
    { id: '3', name: 'app-installer.dmg', at: now - oneDay * 5, sizeBytes: 80000, inProgress: true },
    { id: '4', name: 'old-backup.tar.gz', at: now - oneDay * 20, sizeBytes: 15000 },
    { id: '5', name: 'ancient-report.pdf', at: now - oneDay * 40, sizeBytes: 3000 },
  ]

  // 按关键词搜索 (文件名或 sessionKey)
  const q1 = filterRecords(records, { query: 'finance' })
  assert.equal(q1.length, 1)
  assert.equal(q1[0].id, '1')

  const q2 = filterRecords(records, { query: 'design' })
  assert.equal(q2.length, 1)
  assert.equal(q2[0].id, '2')

  // 类型筛选
  const imgOnly = filterRecords(records, { type: 'image' })
  assert.equal(imgOnly.length, 1)
  assert.equal(imgOnly[0].id, '2')

  const docOnly = filterRecords(records, { type: 'doc' })
  assert.equal(docOnly.length, 2)

  // 时间范围筛选
  const todayOnly = filterRecords(records, { range: 'today', now })
  assert.equal(todayOnly.length, 1)
  assert.equal(todayOnly[0].id, '1')

  const sevenDays = filterRecords(records, { range: '7d', now })
  assert.equal(sevenDays.length, 3)

  const thirtyDays = filterRecords(records, { range: '30d', now })
  assert.equal(thirtyDays.length, 4)

  // 进行中任务固定置顶，即使按时间正序/倒序/大小/名称
  const sortedName = filterRecords(records, { sort: 'name_asc', now })
  assert.equal(sortedName[0].id, '3') // inProgress is at top!
  assert.equal(sortedName[1].name, 'ancient-report.pdf')

  const sortedSize = filterRecords(records, { sort: 'size_desc', now })
  assert.equal(sortedSize[0].id, '3') // inProgress is at top!
  assert.equal(sortedSize[1].id, '4') // 15000 bytes

  // 原始数组不被修改
  assert.equal(records[0].id, '1')
})
