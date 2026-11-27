import test from 'node:test'
import assert from 'node:assert/strict'
import {
  percentOf,
  createDownloadProgressStore,
  shouldReport,
} from '../src/services/downloadProgress.ts'

test('1. percentOf 正常百分比计算', () => {
  assert.equal(percentOf(0, 1000), 0)
  assert.equal(percentOf(500, 1000), 50)
  assert.equal(percentOf(1000, 1000), 100)
})

test('2. percentOf 超出范围钳制', () => {
  assert.equal(percentOf(2000, 1000), 100)
  assert.equal(percentOf(-5, 1000), 0)
})

test('3. percentOf 未知总长或非法总长返回 null', () => {
  assert.equal(percentOf(123, null), null)
  assert.equal(percentOf(123, 0), null)
  assert.equal(percentOf(123, -10), null)
})

test('4. 进度 store：set → 订阅者收到；clear → 收到 undefined；重复 set 相同值不重复通知', () => {
  const store = createDownloadProgressStore()
  const history = []
  const unsubscribe = store.subscribe(state => {
    history.push(state)
  })

  const s1 = { phase: 'downloading', percent: 25, loaded: 250, total: 1000 }
  store.set(s1)
  assert.equal(history.length, 1)
  assert.deepEqual(history[0], s1)

  // 重复 set 相同值不重复通知
  store.set({ phase: 'downloading', percent: 25, loaded: 250, total: 1000 })
  assert.equal(history.length, 1)

  // clear → 收到 undefined
  store.clear()
  assert.equal(history.length, 2)
  assert.equal(history[1], undefined)

  // 重复 clear 也不重复通知
  store.clear()
  assert.equal(history.length, 2)

  // set 新值继续通知
  const s2 = { phase: 'done', percent: 100, loaded: 1000, total: 1000 }
  store.set(s2)
  assert.equal(history.length, 3)
  assert.deepEqual(history[2], s2)

  unsubscribe()
})

test('5. 节流函数 shouldReport：间隔 < 100ms 不报，≥100ms 报', () => {
  assert.equal(shouldReport(100, 0), true)
  assert.equal(shouldReport(99, 0), false)
  assert.equal(shouldReport(150, 100), false)
  assert.equal(shouldReport(199, 100), false)
  assert.equal(shouldReport(200, 100), true)
  assert.equal(shouldReport(250, 100), true)
})
