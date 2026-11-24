# 任务书：P9b —— 客户端显示后台进程与子代理

## 一、后端已就绪（P9a，`3454a2c`）

Core 两条透传路由（与 `session/snapshot` 同风格，需鉴权）：

```
POST /api/v1/fleet/nodes/{node_id}/session/processes   {"session_id": "..."}
  → {"processes": [{session_id, command, cwd, pid, status, uptime_seconds,
                    output_preview, output_tail, exit_code, started_at}], "provider": "hermes"}
POST /api/v1/fleet/nodes/{node_id}/session/subagents   {"session_id": "..."}
  → {"subagents": [...], "delegations": [...], "provider": "hermes"}
```

注意：请求体用 `session_id`（Core 两种写法都兼容，但统一用 snake_case）。
provider 不支持时返回 `{"unsupported": true}`。

## 二、要做的（只改客户端 `src/`）

### 1. 数据层 `src/services/fleet.ts`

- 新增 `fetchSessionProcesses(nodeId, sessionKey)` / `fetchSessionSubagents(nodeId, sessionKey)`
- 返回判别联合：`{kind:'ok', items} | {kind:'unsupported'} | {kind:'error', message}`
- **失败不清空已有数据**（沿用上次结果），只在首次失败时显示"暂不可用"

### 2. 状态 `src/stores/fleet.ts`

每个会话维护：

```ts
processesBySession: Record<string, ProcessItem[]>
subagentsBySession: Record<string, SubagentItem[]>
activityFetchedAt: Record<string, number>
```

刷新时机（都要做，且要**去抖**，同类请求 2 秒内只发一次）：

- 打开会话后一次
- 每轮运行结束（`running` 由 true → false）后一次
- 收到工具完成事件且工具名是 `terminal` / `delegate_task` / `process_manage` 后一次
- 用户下拉刷新时一次

只保留 `status === 'running'` 的进程进列表（和 Hermes Mobile 一致），已结束的进程在抽屉里最多保留最近 5 条（标灰）。

### 3. UI

**状态带**（输入框上方，仅当有内容时显示）：

```
🔄 2 个后台任务   🤖 1 个子代理            >
```

- 数量为 0 时不占位（不显示空条）
- 点击展开底部抽屉

**抽屉**：

- 后台任务项：命令前 60 字符、`pid`、已运行时长（用 `uptime_seconds`，每秒本地自增即可）、状态；展开可看 `output_tail`
- 子代理项：目标摘要（`goals` 里的第一条前 60 字符）、`count`、状态
- 空态：「当前没有后台任务」
- v1 **不做**终止按钮（kill 接口不在本轮范围）

## 三、硬约束

- 不改 `src-tauri/`、`backend/`、`agent-node/`
- 不改 legacy 同步路径
- 不引入新依赖
- 请求失败必须静默降级，**不能因为进程接口挂掉导致聊天打不开**
- 不 commit、不打包

## 四、测试（真跑并贴输出）

1. 纯函数：把 Core 返回的 JSON 映射成 `ProcessItem[] / SubagentItem[]`（字段缺失、`unsupported`、错误三种输入）
2. 只保留 running + 最多 5 条历史已结束项
3. 去抖：2 秒内连续触发 5 次只发 1 次请求（用假 fetch 计数）
4. 失败不清空：先成功拿到 2 条，再失败一次，列表仍是 2 条
5. 状态带在 0 条时不渲染（Vue 组件测试）
6. `node --test tests/` 全绿（现有 215 项不得减少）、`npx vue-tsc --noEmit` exit 0

## 五、交付

改动文件 / 真实测试输出 / 截图位置说明（哪两个组件）/ 「与任务书不一致 / 没做到 / 有风险」
