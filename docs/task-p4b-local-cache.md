# 任务书：P4b —— 本地消息缓存（冷启动秒开 + 退出回来不空白）

## 一、目标

App 打开会话时**先用本机缓存渲染**，同时后台拉快照校正。这样：

- 冷启动不再白屏等网络
- 杀进程重进，历史立刻可见（即使网络慢）
- 网络失败时仍能看到上次内容（只读）

## 二、范围（只改客户端）

1. 新增 `src/services/messageCache.ts`（纯逻辑 + 可注入存储）：
   - 存储介质：**IndexedDB**（不可用时降级 `localStorage`，再不可用则不缓存）
   - 键：`sessionKey`
   - 值：`{ updatedAt, messages: CachedMessage[], lastSeq, epoch }`
   - 上限：每会话 **300 条**、最多 **30 个会话**，超出按 `updatedAt` LRU 淘汰
   - 只存渲染必需字段：`id/role/text/thought/toolCalls/durationMs/at/streaming=false`；
     **不缓存**：附件 blob、图片 dataURL、原始 base64、任何 token
2. `fleet.ts` 接入（最小改动）：
   - `openSession`/`subscribe` 前先 `cache.read(sessionKey)` → 有则立即填充 `messagesBySession`
   - 快照/历史返回后 `cache.write(...)` 覆盖
   - 写入必须**节流**（如 500ms 合并一次），避免流式 delta 频繁落盘
   - 会话被删除/归档时删除对应缓存
3. 开关：`localStorage['studiolo.localCache'] === 'off'` 时不读不写（出问题可一键关）
4. **不改 legacy 渲染逻辑**，缓存只影响"先显示什么"，不改变数据来源与顺序

## 三、硬约束

- 不允许缓存未完成的流式内容为最终态：`streaming` 一律存 `false`，恢复时按"非流式"显示
- 不允许缓存任何密钥/token/附件二进制
- 缓存读写失败必须静默降级（不能因为缓存坏了打不开会话）
- 不引入新依赖（IndexedDB 用原生 API）
- 不改 `src-tauri/`、`backend/`、`agent-node/`

## 四、测试（真跑并贴输出）

1. 纯函数：写入 → 读回，字段完整
2. 上限：写 400 条只保留 300；写 40 个会话只保留 30（LRU 正确）
3. `streaming: true` 的消息写入后读回为 `false`
4. 缓存不可用（存储抛错）→ 读返回空、写不抛
5. 开关 `off` → 不读不写
6. `node --test tests/` 全绿（现有 207 项不得减少）、`npx vue-tsc --noEmit` exit 0

## 五、禁止

- 不 commit、不打包
- 不重构 `fleet.ts` 的其它部分（只加缓存读写的最小调用点）

## 六、交付

改动文件 / 真实测试输出 / 「与任务书不一致 / 没做到 / 有风险」
