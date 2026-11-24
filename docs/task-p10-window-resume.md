# 任务书：P10 —— 会话打开卡住与变慢（窗口化 + resume 缓存）

## 一、实测证据（2026-11-25 10:0x）

```
session.resume {session_id: "20261123_215747_38c00c"}
  → 耗时 1.54s，载荷 4.25 MB，消息 2144 条，messages_omitted=False
```

```
agent-node 错误日志：session.resume 30s 超时（1 次）
```

```
state.db：该会话 2401 条消息；上下文 138k；已压缩 ×2
```

## 二、三个根因

| 编号 | 根因 | 症状 |
|---|---|---|
| R1 | 打开会话一次性拉**全部** 2144 条（4.25 MB） | 手机解析 JSON + 渲染上千气泡 → 卡住 |
| R2 | `_resume` 硬超时 30 秒，且每个会话切换都重新 resume | 撞上长回合时界面卡死半分钟 |
| R3 | 会话无上限增长（2401 条），每轮上下文 13.8 万 | 首字延迟越来越长 |

## 三、本任务范围（只做 R1 + R2，R3 是使用习惯问题）

### 1. 快照窗口化（agent-node）

`session.snapshot` 与 `session.history` 一律默认只返回**最近 40 轮 / 最多 120 条消息**：

- 返回 `hasMoreBefore: true/false`
- 返回 `beforeCursor`（下一页的游标，取窗口首条消息的稳定 id 或序号）
- 新 RPC `session.older`：参数 `{session_id, before_cursor, limit}` → 返回更早一页（同样结构）
- 窗口内的 turn 结构必须完整（不能把一轮切两半；按 turn 边界裁剪）
- 运行中的回合**永远包含**在窗口内

**注意**：这只是**传输窗口**，不是删数据；transcript 一条不动。

### 2. resume 缓存与超时

- resume 结果按 session 缓存（进程内），**同一会话 5 分钟内不重复 resume**
- `session.resume` 超时从 30s 降到 **5s**；超时后：
  - 返回明确错误码（不是静默空数据）
  - 客户端可继续用缓存/窗口数据
- 并发去重：同一会话的 resume 同时只允许一个在飞（其余等待同一个 future）

## 四、测试（真跑并贴输出）

1. 造 300 条消息的会话 → snapshot 只返回窗口（≤120 条），`hasMoreBefore=true`
2. 窗口在 turn 边界裁剪（最后一轮完整，不被截断）
3. `session.older` 能翻到更早一页，翻到底 `hasMoreBefore=false`
4. 运行中的回合始终在窗口内（即使它超长）
5. resume 缓存：连续两次调用只发生一次真实 resume（假 connection 计数）
6. resume 超时 5s：超时后返回错误码，不挂 30s
7. 并发去重：5 个并发请求只 resume 一次
8. 全量：agent-node（沙箱端口测试失败需说明）

## 五、禁止

- 不删数据、不改 transcript、不改 `session.events.since`
- 不改 `src/`、不改 Core 契约字段名（只新增 `hasMoreBefore` / `beforeCursor`）
- 不 commit、不重启服务

## 六、交付

改动文件 / 真实测试输出 / **用当前真实会话（20261123_215747_38c00c）实测一次**：snapshot 载荷从多少降到多少、耗时多少 / 「与任务书不一致 / 没做到 / 有风险」
