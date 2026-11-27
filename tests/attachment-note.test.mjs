import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAttachmentNote } from '../src/services/messageSegments.ts'

test('1. 单个已解密附件 → 剥离正文块并解析出文件', () => {
  const text = [
    '重进之后这些工具之间要是没有消息可以和在一起，你分析一下给方案',
    '',
    '[附带文件]',
    '- [已解密附件] photo-20261126-122032.jpg (image/jpeg): /Users/zjy/Projects/.studiolo-inbox/ea846c52-photo-20261126-122032.jpg',
  ].join('\n')

  const { cleaned, files } = parseAttachmentNote(text)
  assert.equal(cleaned, '重进之后这些工具之间要是没有消息可以和在一起，你分析一下给方案')
  assert.equal(files.length, 1)
  assert.equal(files[0].name, 'photo-20261126-122032.jpg')
  assert.equal(files[0].mime, 'image/jpeg')
  assert.equal(files[0].path, '/Users/zjy/Projects/.studiolo-inbox/ea846c52-photo-20261126-122032.jpg')
})

test('2. 多附件 → 逐条解析', () => {
  const text = [
    '看这两张',
    '',
    '[附带文件]',
    '- [已解密附件] a.png (image/png): /tmp/x/.studiolo-inbox/1-a.png',
    '- [已解密附件] report.pdf (application/pdf): /tmp/x/.studiolo-inbox/2-report.pdf',
  ].join('\n')

  const { cleaned, files } = parseAttachmentNote(text)
  assert.equal(cleaned, '看这两张')
  assert.equal(files.length, 2)
  assert.deepEqual(files.map(f => f.name), ['a.png', 'report.pdf'])
  assert.equal(files[1].mime, 'application/pdf')
})

test('3. 加密票据（无本地路径）→ path 为空', () => {
  const text = 'hi\n\n[附带文件]\n- [加密附件票据] shot.jpg (id=abc-123)'
  const { cleaned, files } = parseAttachmentNote(text)
  assert.equal(cleaned, 'hi')
  assert.equal(files.length, 1)
  assert.equal(files[0].name, 'shot.jpg')
  assert.equal(files[0].path, '')
  assert.equal(files[0].mime, 'image/jpeg')
})

test('4. 只在末尾才剥离；正文中间的 [附带文件] 原样保留', () => {
  const mid = '正文里提到 [附带文件] 这个词，然后继续写别的'
  const result = parseAttachmentNote(mid)
  assert.equal(result.cleaned, mid)
  assert.equal(result.files.length, 0)
})

test('5. 没有该块 → 原样返回', () => {
  const text = '普通消息，没有任何附件'
  const { cleaned, files } = parseAttachmentNote(text)
  assert.equal(cleaned, text)
  assert.deepEqual(files, [])
})

test('6. 只有附件块、没有正文 → cleaned 为空字符串', () => {
  const text = '[附带文件]\n- [已解密附件] only.png (image/png): /tmp/.studiolo-inbox/9-only.png'
  const { cleaned, files } = parseAttachmentNote(text)
  assert.equal(cleaned, '')
  assert.equal(files.length, 1)
})
