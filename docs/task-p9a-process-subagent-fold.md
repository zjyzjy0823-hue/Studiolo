# 任务书：P9a —— 后台进程与子代理的投影（服务端）

## 一、目标

`fold()` 除消息/回合/工具外，再派生两个集合，并随快照下发：

```json
"processes": [{ "id": "proc_xxx", "command": "...", "pid": 35977,
                "startedAt": 1795613000, "status": "running|completed|failed",
                "delegationId": "deleg_xxx|null", "subagentId": "sa-0-xxxx|null" }],
"subagents": [{ "id": "deleg_xxx", "count": 4, "goals": ["..."],
                "startedAt": 1795613000, "status": "running|completed" }]
```

字段可选、向后兼容：老客户端忽略即可。`session.events.since` 不需要返回它们。

## 二、数据来源（**已从真实数据确认，不要猜**）

### 1. 后台进程启动

`terminal` 工具返回（JSON 字符串）：

```json
{"output": "Background process started", "session_id": "proc_a15e02a5535b", "pid": 35977, "exit_code": 0, "error": null, "notify_on_complete": true}
```

判定：`session_id` 以 `proc_` 开头 → 记一条 `processes`，`command` 取该工具调用的参数（`command` 字段），`status="running"`。

### 2. 后台进程结束（以 user 角色注入的系统消息）

文本开头形如：

```
[IMPORTANT: Background process proc_124cc9eaa190 completed normally (exit code 0).
Started by subagent sa-0-b5c77b61 of delegation deleg_0327ec68. Task: "..."
```

判定：正则 `\[IMPORTANT: Background process (proc_[A-Za-z0-9]+) completed` + `exit code (\d+)`
→ 更新对应 process 的 `status`（0 → `completed`，否则 `failed`），并回填 `subagentId` / `delegationId`（若文本里有 `Started by subagent (sa-[\w-]+) of delegation (deleg_\w+)`）。

**注意**：这条消息同时会进消息列表（那是 P6 要处理的事），**本任务不动消息投影**，只解析它来更新进程状态。

### 3. 子代理启动

`delegate_task` 工具返回（JSON 字符串）：

```json
{"status": "dispatched", "mode": "background", "count": 4, "delegation_id": "deleg_0327ec68",
 "goals": ["..."], "note": "..."}
```

判定：`delegation_id` 存在且 `mode == "background"` → 记一条 `subagents`，`status="running"`。
`mode` 不是 background 的（同步子代理）**不记**。

### 4. 子代理结束

文本开头形如：

```
[ASYNC DELEGATION BATCH COMPLETE — deleg_0327ec68]
A background fan-out unit you dispatched earlier — 4 subagent(s) — has finished; ...
```

判定：正则 `\[ASYNC DELEGATION BATCH COMPLETE — (deleg_[A-Za-z0-9]+)\]` → 该 delegation `status="completed"`。

## 三、规则

- 同一 id 重复出现只更新，不重复插入
- 上限：`processes` / `subagents` 各保留最近 **20** 条；已结束且超过 **1 小时**的丢弃
- 时间字段：启动事件的时间；缺失则用事件自身的 ts
- 解析失败必须静默跳过（不能因为一条脏数据让整个 fold 抛错）
- `incomplete` 语义不变

## 四、测试（用上面的真实样本做夹具，真跑并贴输出）

1. `proc_` 返回 → processes 出现 1 条，command/pid 正确
2. 完成消息（exit 0 / exit 1）→ status 分别 completed / failed，且回填 delegationId/subagentId
3. `delegation_id` + `mode=background` → subagents 1 条，count/goals 正确
4. `mode` 非 background → 不记
5. `[ASYNC DELEGATION BATCH COMPLETE — deleg_x]` → subagents 里该条 completed
6. 重复事件幂等（同 id 两次不产生两条）
7. 上限：插入 25 条只保留 20
8. 脏 JSON → 不抛错、其它字段正常
9. agent-node 全量（沙箱端口测试失败需说明）

## 五、禁止

- 不改消息投影、不改 `src/`、不改 Core
- 不改 `session.events.since` 返回结构
- 不 commit、不重启服务

## 六、交付

改动文件 / 真实测试输出 / 快照里的真实 JSON 片段（一条 process + 一条 subagent）/ 「与任务书不一致 / 没做到 / 有风险」
