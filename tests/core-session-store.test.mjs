import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CORE_SESSION_STORAGE_KEY,
  isCoreSessionRecord,
  loadCoreSession,
  saveCoreSession,
  clearCoreSession,
  coreSessionMatches,
} from '../src/services/coreSessionStore.ts'

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, String(v))
    },
    removeItem: (k) => {
      map.delete(k)
    },
    raw: map,
  }
}

function createThrowingStorage({ get = false, set = false, remove = false } = {}) {
  return {
    getItem: () => {
      if (get) throw new Error('Storage getItem error')
      return null
    },
    setItem: () => {
      if (set) throw new Error('Storage setItem error')
    },
    removeItem: () => {
      if (remove) throw new Error('Storage removeItem error')
    },
  }
}

const sampleSession = {
  origin: 'http://localhost:8080',
  token: 'core-jwt-token-xyz',
  localToken: 'desktop-local-token-abc',
  workspaceId: 'ws-workspace-123',
  coreUrl: 'http://localhost:8080',
}

test('1. 合法会话记录读写与序列化隔离', () => {
  const storage = createMemoryStorage()
  saveCoreSession(sampleSession, storage)

  const loaded = loadCoreSession(storage)
  assert.deepEqual(loaded, sampleSession)

  // 验证只存入 5 个字段，不携带额外字段
  const extraSession = { ...sampleSession, user: 'admin', role: 'root' }
  saveCoreSession(extraSession, storage)
  const rawString = storage.getItem(CORE_SESSION_STORAGE_KEY)
  assert.ok(rawString)
  const parsed = JSON.parse(rawString)
  assert.deepEqual(parsed, sampleSession)
  assert.equal(parsed.user, undefined)
  assert.equal(parsed.role, undefined)
})

test('2. saveCoreSession(null) 与 clearCoreSession 正常清除', () => {
  const storage = createMemoryStorage()
  saveCoreSession(sampleSession, storage)
  assert.ok(storage.getItem(CORE_SESSION_STORAGE_KEY))

  saveCoreSession(null, storage)
  assert.equal(storage.getItem(CORE_SESSION_STORAGE_KEY), null)
  assert.equal(loadCoreSession(storage), null)

  saveCoreSession(sampleSession, storage)
  clearCoreSession(storage)
  assert.equal(storage.getItem(CORE_SESSION_STORAGE_KEY), null)
})

test('3. 脏 JSON 数据自动清理并返回 null', () => {
  const storage = createMemoryStorage({
    [CORE_SESSION_STORAGE_KEY]: '{ invalid json string content ...',
  })

  const loaded = loadCoreSession(storage)
  assert.equal(loaded, null)
  // 脏数据应顺手清掉
  assert.equal(storage.getItem(CORE_SESSION_STORAGE_KEY), null)
})

test('4. 字段缺失或空字符串时自动清理并返回 null', () => {
  const keys = ['origin', 'token', 'localToken', 'workspaceId', 'coreUrl']
  for (const key of keys) {
    const incomplete = { ...sampleSession }
    delete incomplete[key]

    const storageMissing = createMemoryStorage({
      [CORE_SESSION_STORAGE_KEY]: JSON.stringify(incomplete),
    })
    assert.equal(loadCoreSession(storageMissing), null)
    assert.equal(storageMissing.getItem(CORE_SESSION_STORAGE_KEY), null)

    const emptyField = { ...sampleSession, [key]: '   ' }
    const storageEmpty = createMemoryStorage({
      [CORE_SESSION_STORAGE_KEY]: JSON.stringify(emptyField),
    })
    assert.equal(loadCoreSession(storageEmpty), null)
    assert.equal(storageEmpty.getItem(CORE_SESSION_STORAGE_KEY), null)
  }
})

test('5. storage 抛错降级（getItem / setItem / removeItem 均静默降级不抛异常）', () => {
  const throwingGet = createThrowingStorage({ get: true })
  assert.doesNotThrow(() => {
    const loaded = loadCoreSession(throwingGet)
    assert.equal(loaded, null)
  })

  const throwingSet = createThrowingStorage({ set: true })
  assert.doesNotThrow(() => {
    saveCoreSession(sampleSession, throwingSet)
  })

  const throwingRemove = createThrowingStorage({ remove: true })
  assert.doesNotThrow(() => {
    clearCoreSession(throwingRemove)
  })
})

test('6. storage 为 null 或未传参时的降级行为', () => {
  assert.doesNotThrow(() => {
    assert.equal(loadCoreSession(null), null)
    saveCoreSession(sampleSession, null)
    clearCoreSession(null)
  })
})

test('7. coreSessionMatches 正常匹配', () => {
  const context = {
    localToken: 'desktop-local-token-abc',
    workspaceId: 'ws-workspace-123',
    coreUrl: 'http://localhost:8080',
  }
  assert.equal(coreSessionMatches(sampleSession, context), true)
})

test('8. coreSessionMatches 不匹配场景 1：session 为 null / undefined / 非法记录', () => {
  const context = {
    localToken: sampleSession.localToken,
    workspaceId: sampleSession.workspaceId,
    coreUrl: sampleSession.coreUrl,
  }
  assert.equal(coreSessionMatches(null, context), false)
  assert.equal(coreSessionMatches(undefined, context), false)
  assert.equal(coreSessionMatches({ token: 'abc' }, context), false)
})

test('9. coreSessionMatches 不匹配场景 2：localToken 不一致或缺失', () => {
  assert.equal(
    coreSessionMatches(sampleSession, {
      localToken: 'different-local-token',
      workspaceId: sampleSession.workspaceId,
      coreUrl: sampleSession.coreUrl,
    }),
    false,
  )
  assert.equal(
    coreSessionMatches(sampleSession, {
      localToken: null,
      workspaceId: sampleSession.workspaceId,
      coreUrl: sampleSession.coreUrl,
    }),
    false,
  )
})

test('10. coreSessionMatches 不匹配场景 3：workspaceId 不一致或缺失', () => {
  assert.equal(
    coreSessionMatches(sampleSession, {
      localToken: sampleSession.localToken,
      workspaceId: 'different-workspace-id',
      coreUrl: sampleSession.coreUrl,
    }),
    false,
  )
  assert.equal(
    coreSessionMatches(sampleSession, {
      localToken: sampleSession.localToken,
      workspaceId: null,
      coreUrl: sampleSession.coreUrl,
    }),
    false,
  )
})

test('11. coreSessionMatches 不匹配场景 4：coreUrl 不一致或缺失', () => {
  assert.equal(
    coreSessionMatches(sampleSession, {
      localToken: sampleSession.localToken,
      workspaceId: sampleSession.workspaceId,
      coreUrl: 'http://other-core-host:9999',
    }),
    false,
  )
  assert.equal(
    coreSessionMatches(sampleSession, {
      localToken: sampleSession.localToken,
      workspaceId: sampleSession.workspaceId,
      coreUrl: null,
    }),
    false,
  )
})
