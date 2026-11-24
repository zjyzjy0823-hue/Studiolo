# Studiolo 会话层：完整架构分析与重构方案

> 2026-11-24 · 基于代码实测 + 对照 hermes-mobile（com.m57.hermescontrol）
> 目的：解释「为什么会同时出现这么多症状」，并给出重构边界。**本文不含代码改动建议的细节实现**，只给结构决策。

---

## 一、先给结论

1. **一半症状是版本问题**：手机上装的其实是 0.8.6（11-23 22:42）。0.8.7 续传、0.8.8 外链下载、0.8.9 下载记录、0.9.0 入口**都没装过**。已用 adb 装上 0.9.0。
2. **剩下的一半是架构问题，但不是"整个 App 要重写"**：问题出在**会话事件的所有权**——同一条会话的状态，现在分散在三个地方各自演化，谁也不完整。
3. **最关键的一条**：Hermes gateway **本身已经实现了带游标的事件重放**（`session.events.since` + `replay_epoch` + `last_sequence`），而我们在中间层（agent-node + Core）**又造了一套更弱的序号系统**，还把它建在内存上。所有"丢帧/重连/工具调用消失"的根，都在这里。
4. **hermes-mobile 之所以稳**：它直接连 gateway，用官方的 `events.since` 续传；消息落 Room 数据库；有真正的心跳/活性探测；系统消息有 `provenance` 标记。它没有中间层。

---

## 二、事实基础

### 2.1 设备实况

| 项 | 值 |
|---|---|
| 机型 | vivo V2111A（Android 11） |
| 原安装版本 | **0.8.6 / versionCode 8006**（2026-11-23 22:42 安装） |
| 现状 | 已用 `adb install -r` 升到 **0.9.0 / 9000**，运行正常 |

> 结论先行：你说"没有下载页""文件没了"——0.8.6 里**根本不存在**这些功能。这部分不用查架构。

### 2.2 代码事实（我们这边）

| 事实 | 位置 |
|---|---|
| 客户端消息**只存在内存**：`messagesBySession = ref<Record<string, ChatMessage[]>>({})` | `src/stores/fleet.ts:261` |
| 用时是**客户端现算**：`durationMs = Date.now() - promptMeta.startedAt` | `src/stores/fleet.ts:2549-2559` |
| 重连是**固定退避** `[1s,2s,4s,8s,15s]`，且**没有心跳/活性探测**（全文件搜不到 ping/heartbeat） | `src/stores/fleet.ts:91,1116` |
| 断线时清空一大片在途状态（steer、in-flight 请求、session list、outbox…） | `src/stores/fleet.ts:1003-1027` |
| 节点历史是**内存 deque，上限 500 条** | `agent-node/agent_node/adapters/hermes.py:35,297` |
| 节点**确实用了** gateway 的 `replay_epoch` / `last_sequence` | `adapters/hermes_ws.py:295,457,533-534,603-615` |
| 但节点对外**重新编号**，Core 再编一次 | `daemon.py` 的 `HermesMediaResult` / frame seq |

### 2.3 代码事实（hermes-mobile）

| 事实 | 位置 |
|---|---|
| 消息**落 Room 数据库**，字段包含工具调用与计时 | `data/local/ChatMessageEntity.kt` |
| 持久化字段：`role/content/reasoningText/toolName/toolCallId/toolStatus/isStreaming/tokenCount/tps/completionId/sortGroup/sortOrder/messageProvenance` | 同上 |
| 重连用 **`session.events.since(session_id, replay_epoch, last_sequence)`** | `data/ws/HermesWsClient.kt:86`、`contract/RpcMethod.kt:46` |
| 序号水位：`ReplayTracker.setSeqWatermark(sessionId, seq)` | `HermesWsClient.kt:330` |
| 连接健康：**心跳 15s / 陈旧阈值 60s / 活性探测 5s** | `data/ws/ConnectionHealth.kt:23,30,31` |
| 网络切换主动重连：`reconnectForNetworkChange(...)` | `HermesWsClient.kt:214` |
| 消息来源标记 `MessageProvenance`（`LOCAL_PENDING` / 远端 / 系统） | `ui/chat/ChatMessage.kt:40` |
| 断线重放的**去重**逻辑写在 reducer 里并有注释说明 | `ui/chat/ChatWsEventReducer.kt:1203` |
| 插话/中断是**官方 RPC**：`session.steer` / `session.interrupt` / `prompt.cancel` | `data/ws/WsMethods.kt:12,14,58` |
| 附件用 gateway 的鉴权下载 URL（`/api/files/download?...`） | `data/model/Attachment.kt` |
| 会话列表有本地缓存 | `data/local/SessionListCacheStore.kt` |

---

## 三、现状架构：为什么它必然会出这些问题

```
         ┌─────────────── Hermes gateway（真正的状态源）───────────────┐
         │  session.events.since(replay_epoch, last_sequence)  ← 已有   │
         └──────────────────────┬─────────────────────────────────────┘
                                │ WS（epoch+seq）
                        agent-node（中转）
                     _history deque(maxlen=500)   ← 内存，会丢
                                │ 重新编号
                             Core（fleet）
                    stream/seq 又一套，队列 256   ← 再编号
                                │ WS
                        客户端 fleet.ts
              messagesBySession（纯内存）           ← 第三份状态
```

**三处序号、三份状态、零份持久化。** 任何一处重启或抖动，下游就必须"猜"：

| 层 | 状态 | 是否持久 | 失效后果 |
|---|---|---|---|
| gateway | transcript + epoch/seq | ✅ | — |
| agent-node | `_history[500]` | ❌ | 重启后只能靠 transcript 反推 → **有损**（工具调用、思考、计时都可能缺） |
| Core | 内存队列 + 传输 seq | ❌ | 重启后客户端必须全量重放 |
| 客户端 | `messagesBySession` | ❌ | 退出即清空；用时/流式/待发全靠内存 |

### 3.1 症状逐条解剖

#### ① 多轮对话里不显示工具调用，只发结果

- 工具调用**只以事件帧存在**（`ToolCall` / `ToolCallUpdate`）。
- 节点 `_history` 是 **deque(maxlen=500)**：一轮长对话（含工具）很容易把早期帧挤掉。
- 节点重启后走 `_transcript_history()` 从 gateway transcript 反推——transcript 行里工具信息是**压缩过**的（`tool_call_id` + 文本），重建不出原样的卡片。
- 结论：**工具调用的生命周期 = 一个易失的环形缓冲**。这不是 bug，是设计。

#### ② 用时「未记录」

- `promptMeta` 是客户端内存对象，`startedAt` 只活在这一轮 + 这个进程里。
- 重连/切后台/杀进程 → 没起点 → 显示"未记录"。
- hermes-mobile 的做法：`tokenCount` / `tps` 随消息**入库**，用时是**保存过的数据**，不是算出来的。

#### ③ 老是显示重连

- 客户端**没有心跳**：只能等 socket close 才知道断了。
- 移动网络切换（WiFi↔5G）、后台挂起、CF/frp 空闲回收，都会触发 close。
- 收到 close 就 `connectionLost()` → 清一大片状态 → 固定退避重连 → 重放历史 → 再渲染。
- 用户看到的就是"又重连了"，并且伴随历史闪一下、流式中断。
- hermes-mobile：心跳 15s + 60s 陈旧判定 + 换网络时先做 5s 活性探测，**区分"安静"和"死了"**。

#### ④ 插话（steer）丢对话

- 我们的插话要跨四层判定：客户端 running → Core 白名单 → 节点 `_active_runs` → adapter steer。
- `_active_runs` 在**节点内存**里，后台任务/外部回合发起的运行不登记 → 判定"未运行" → 降级成普通发送 → 撞上"当前会话已有任务运行中"。
- hermes-mobile 直接调 `session.steer`，运行态是 gateway 说了算。
- 结论：**运行态不该由中转层猜**。

#### ⑤ 客户端出现不该出现的消息

- Hermes gateway 把「后台进程已完成」这类系统通知**以 user 角色**写进会话。
- 客户端没有"来源"概念，只能照实渲染成用户气泡。
- hermes-mobile 有 `MessageProvenance`，系统注入与用户输入从数据结构上就分开。

#### ⑥ 退出再回来，文件/记录没了

- 下载记录只存 `localStorage`（0.8.9 才引入），且没有服务端副本。
- 0.8.6 上更是**完全没有**这个功能。
- 结论：这部分是**版本 + 存储位置**问题，不是协议问题。

#### ⑦ 重连后历史闪断、消息重复或缺失

- 客户端靠"缺口缓冲 + 游标 + 快照抢占"自己拼；
- 但快照本身来自节点内存（会丢），所以拼出来的东西不保证完整；
- 我们为此加的补丁（1000 帧缓冲、5s 超时重试、快照抢占翻页）**互相之间还要再协调**——这就是"越修越复杂"的来源。

---

## 四、hermes-mobile 的整体做法（可借鉴的部分）

它的核心思路只有一句：**UI 是数据库的投影，数据库是事件折叠的结果，事件由 gateway 负责重放。**

```
gateway(WSS) ──session.events.since(epoch,seq)──> App
                                                   │
                                       ChatWsEventReducer（纯函数：事件→消息）
                                                   │
                                             Room DB（持久）
                                                   │
                                            Compose UI（只读）
```

四个关键设计：

1. **消息是数据库行，不是内存对象**
   工具调用（`toolName`/`toolCallId`/`toolStatus`）、流式标记（`isStreaming`）、token/速度（`tokenCount`/`tps`）都是**列**。
   → 进程重启、切页面、断网，读库即可复原。

2. **续传用官方游标**
   `replay_epoch` 标识"服务端进程的一次生命周期"，`last_sequence` 是水位。
   重连时只求 `> last_sequence` 的增量；epoch 变了就说明服务端重启过，改走快照。
   → 不需要客户端自己维护"帧缓冲"。

3. **连接健康是显式状态机**
   心跳 15s、60s 无活动判死、换网络先探测 5s。
   → "正在重连"只在**真的连不上**时出现，不会因为一次安静的等待就闪。

4. **来源与顺序是数据模型的一部分**
   `MessageProvenance`（本地待发 / 服务端 / 系统）、`localAnchorOrder` + `localPredecessorId`（本地消息稳定插入位置）、`sortGroup`/`sortOrder`。
   → 不会出现"系统通知冒充用户""本地消息乱序""重放导致重复"。

---

## 五、对照表

| 维度 | 我们现在 | hermes-mobile | 差距性质 |
|---|---|---|---|
| 状态源 | 内存（三份） | Room 数据库（一份投影） | **结构性** |
| 事件续传 | 自建 seq + 帧缓冲 | gateway `events.since(epoch,seq)` | **结构性** |
| 工具调用 | 只活在事件里，环形缓冲 500 | 数据库列，永久 | **结构性** |
| 用时/速度 | 客户端现算 | 入库字段 | **结构性** |
| 断线判定 | 等 close | 心跳 + 陈旧阈值 + 活性探测 | 工程细节 |
| 重连行为 | 清空在途状态 + 全量重放 | 按水位补增量 | **结构性** |
| 插话 | 四层自建判定 | 官方 `session.steer` | **结构性** |
| 系统消息 | 无来源标记 | `MessageProvenance` | 数据模型 |
| 附件下载 | 中继 + 直链两套 | gateway 鉴权 URL 一套 | 设计取向 |
| 多节点 | 支持（Core 聚合） | 不支持（单 gateway） | **我们的额外成本** |

**一句话**：hermes-mobile 是"单节点、直连、数据库投影"；我们是"多节点、中转、内存投影"。多节点是我们真正多出来的复杂度，但**中转层不该自己发明序号**。

---

## 六、三条可选路线

### 方案 A：保留中转，补持久化（最小结构改动）

- 节点把 `_history` 换成 SQLite 表；Core 转发时**沿用节点的 epoch/seq**，不再自己编号。
- 客户端收到的事件带 `(epoch, seq)`，重连时按水位要增量。
- 优点：多节点保留；改动集中在中转层与客户端 store。
- 代价：仍然要维护三处一致；工具调用/计时还得多写一份持久化。
- 风险：**这是"把现在的结构做对"，但不是最简结构**，仍可能复现同类问题。

### 方案 B：Core 降级为透明路由（推荐）

- Core 只负责：节点注册、鉴权、**把 gateway 的 `session.events.since` 原样透传**（含 `replay_epoch`/`last_sequence`），不再有 fleet 自己的流序号。
- 会话状态由节点侧持久化（一个 SQLite 表即可，按 gateway 的 session_id 存事件）。
- 客户端：Room/IndexedDB 投影 + 本地库 + 心跳。
- 优点：序号只有一套（gateway 的）；工具调用/计时天然完整；插话直接调 `session.steer`。
- 代价：Core 的"会话索引"要重做（现在是自建 stream）；多节点路由要重新设计（按 node 分流，但不改序号）。
- 风险：动了 Core 的核心协议，需要一次性切换，过渡期要双读。

### 方案 C：单节点直连（等同 hermes-mobile）

- App 在**同一局域网**时直连 gateway；外网才走 Core。
- 优点：最简单、最稳，直接复用 hermes-mobile 的全部设计。
- 代价：多节点聚合、外网访问要另做；等于放弃现在 Core 的定位。
- 适用：如果你实际只用 Mac mini 一个节点 —— 那 Core 的价值主要就是"外网穿透 + 鉴权"。

### 取舍

| | A | B | C |
|---|---|---|---|
| 结构正确性 | 中 | **高** | 高 |
| 改动面 | 中 | 大 | 中（但废掉 Core 一半能力） |
| 多节点 | 保留 | 保留 | 丢失 |
| 外网 | 保留 | 保留 | 需另做 |
| 与 hermes-mobile 对齐 | 部分 | **大部分** | 完全 |

**我的建议：B**。保留多节点与外网能力，但把"事件序号"这条命脉交还给 gateway，中转层只做路由与鉴权。

---

## 七、推荐路线（B 方案，分阶段）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P1 事件落地** | 节点侧建 `session_events(session_id, epoch, seq, turn_id, type, payload, created_at)`，所有事件先落库再转发 | 杀节点进程重启，客户端仍能看到完整工具调用 |
| **P2 序号归一** | Core 停用自己的 stream seq，改为透传 `(epoch, seq)`；客户端按水位续传 | 断网 5 分钟重连，不重复、不缺失 |
| **P3 投影层** | 客户端消息落本地库（IndexedDB/SQLite），启动先用库渲染再拉增量；用时/工具状态入库 | 冷启动秒开，历史用时完整显示 |
| **P4 连接健康** | 心跳 15s / 陈旧 60s / 换网络探测 5s；"重连中"只在真断时出现 | 手机切 WiFi↔5G 不再闪"重连" |
| **P5 来源标记** | 事件区分 `user / assistant / system_notice / tool`；系统通知单独渲染 | 后台完成通知不再冒充用户消息 |
| **P6 插话归一** | 删掉 `_active_runs` 自建判定，直接 `session.steer`，失败回执语义化 | 插话在后台回合也能生效 |
| **P7 删补丁** | 移除帧缓冲/快照抢占/指纹回退等兼容代码 | 代码量下降，回归全绿 |

时间：P1–P3 是主菜（约 4–6 天），P4–P6 各半天到一天，P7 收尾。

---

## 八、明确不建议做的事

1. **不要重写 UI**。现在的界面问题都是"数据来得不全"，不是渲染错。换数据源即可。
2. **不要在客户端继续加缓冲/重试**。那是在补偿一个不该存在的中间序号。
3. **不要把"会话状态"再放进 Core 的进程内存**。Core 重启一次就全丢，这是当前最脆的一环。
4. **不要为了省事让节点直接读 gateway 的 transcript 当历史**。transcript 是给模型用的压缩视图，不是给 UI 用的事件流。

---

## 九、附：为什么之前的补丁会互相打架

我们过去加过：1000 帧缓冲、按 seq 冲刷、快照抢占翻页、游标只在应用后推进、`sameTurnContent` 指纹回退、外部回合合成 runId……

它们每一个都在解决"**这段数据可能不全**"，而"不全"的根源是**节点内存上限 + 三层序号**。
补丁之间没有共同的不变量，所以：

- A 补丁假设"seq 连续"，B 补丁为了容错允许跳号 → 冲突；
- C 补丁把快照当权威，D 补丁把增量当权威 → 冲突；
- 每加一个补丁，都要为它再写一个"例外分支"。

**正确做法是把不变量收成一条**：
> 会话事件 = `(epoch, seq)` 单调、可重放、持久化；客户端 = 它的投影。

一条不变量，胜过十个补丁。

---

## 十、下一步（需要你拍板）

1. 走 A / B / C 哪条；
2. 若走 B，是否接受"Core 协议一次性切换"（过渡期双读，约 1 周）；
3. 是否先把 P1+P2 做出来做验证（不动 UI），再决定 P3 之后。
