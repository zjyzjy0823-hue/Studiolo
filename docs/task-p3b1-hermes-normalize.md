# 任务书：P3b-1 —— hermes 快照归一化（真机阻塞项）

## 一、真机复现（2026-11-24 18:3x，0.9.1 epoch 构建）

- 手机打开会话 → `POST /api/v1/fleet/nodes/{id}/session/snapshot` 返回 **200**
- 客户端界面：**0 条消息气泡、0 个工具卡片、11 条「用时未记录」占位**
- 结论：服务端返回了 turns，但没有 messages —— **数据形状不对**

## 二、根因

`hermes` 分支把 gateway 的原生事件**原样**放进快照/增量，字段是 `session_id` / `replay_epoch` / `type: "message.delta"` 这一类；
而客户端与其它 provider 用的是契约信封（`sessionId` / `epoch` / `seq` / `type: "message.assistant.delta"`）。
两边对不上，客户端解析不出消息，只剩空骨架。

## 三、要求

1. **`session.snapshot` 对所有 provider 必须返回同一种结构**（契约 Snapshot）：
   ```json
   { "sessionId", "epoch", "lastSeq", "source": "gateway|node",
     "snapshot": { "messages": [...], "turns": [...], "notices": [...], "approvals": [...],
                   "usage": {...}, "running": false, "runId": null, "lastSeq": 123 },
     "incomplete": false }
   ```
2. hermes 分支的流程固定为：
   ```
   gateway session.events.since（原生）
        → 归一化成契约事件（复用 P1 的 EventStore/fold）
        → fold() 得到 Snapshot
   ```
   **不允许**把原生字段直接透给客户端。
3. 归一化映射表必须写进 `docs/spec-session-events.md`（原生 type → 契约 type，字段对应关系）。
4. gateway 重放窗口不全时：返回已折叠的部分 + `"incomplete": true` + `"lastSeq"`（不要 500，也不要空对象）。
5. 增量 `session.events.since` 同样只返回**契约事件**（原生字段不允许出现在顶层）。
6. 不改客户端（`src/`）、不改契约字段名。

## 四、测试（真跑并贴输出）

1. 用**真实 gateway 原生样本**（可新增 fixture）走 `snapshot`：断言 `messages` 非空、工具数正确、`turns` 数量与原生 `turn` 事件一致、`source="gateway"`。
2. `incomplete` 分支：窗口截断时返回 `incomplete: true` 且 `messages` 不为空。
3. 增量路径：`events.since` 返回的每个事件都符合契约信封（逐字段校验，特别是不允许出现 `session_id`/`replay_epoch`）。
4. 回归：P1/P2 既有用例全绿；agent-node 全量绿（沙箱端口测试失败可接受，需说明）。

## 五、禁止

- 不改 `src/`、`src-tauri/`
- 不改客户端解析逻辑（客户端已经按契约写，是服务端要跟上）
- 不 commit、不重启服务（重启我自己来，因为要按顺序：Core → node）

## 六、交付

改动文件 / 真实测试输出 / 归一化映射表 / 「与任务书不一致 / 没做到 / 有风险」
