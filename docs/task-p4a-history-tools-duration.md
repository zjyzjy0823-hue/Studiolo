# 任务书：P4a —— 历史消息的工具卡片与「用时」显示

## 一、真机现状（0.9.4 epoch，2026-11-24 20:1x）

用户消息与助手内容已经能显示，但还有两个可见问题：

| 现象 | 真机观察 |
|---|---|
| 「用时未记录」 | 每条历史助手消息上方都显示，**误导**（不是没记录，是这个版本不提供） |
| 历史工具调用 | 快照里 `toolCalls` 有数据（服务端测试 `tools=2`），**界面上一个卡片都没有** |

## 二、要做的两件事

### 1. 未知用时不要显示成「未记录」

规则：

- `durationMs` 为 `null` / `undefined` / 非正数 → **整块不渲染**（不要显示“用时未记录”，也不要显示 0 秒）
- 只有拿到有效用时（>0）才显示，格式保持现状
- 「未记录」这种文案在未来某处需要说明时，用 tooltip 或设置页说明，**不要挂在每条消息上**

实现提示：`src/components/chat/AgentChatThread.vue` 里负责用时标签的渲染分支；不要改数据层。

### 2. 历史消息里的工具调用要渲染成卡片

服务端快照的 message 结构：

```json
{ "role": "assistant", "text": "...", "toolCalls": [
    { "callId": "call-1", "name": "bash", "status": "completed", "output": "...", "durationMs": 1234 }
] }
```

要求：

- 把快照消息映射成客户端 `ChatMessage` 时，`toolCalls` 要填成现有的 `ToolCallBadge[]` 形状（`callId/name/status/output/durationMs` 对应字段先读代码确认）
- 渲染必须复用**现有**的实时工具卡片组件/样式，不要新写一套
- 状态映射：`completed → success`、`error/failed → error`、其它 → running
- `durationMs` 为 null → 卡片上不显示耗时，不要显示 0s

实现位置：`src/stores/fleet.ts` 里 epoch 路径的消息映射（`sessionSync` 的 `apply`），以及必要的类型补全。**不要**改 legacy 路径的渲染。

## 三、测试（真跑并贴输出）

1. 纯函数测试：快照消息 → `ChatMessage` 映射
   - 工具卡片数量与 `toolCalls` 一致
   - 状态映射正确（completed/error/running）
   - `durationMs: null` → 卡片不带耗时、消息不带用时
2. 渲染规则测试（可用纯函数抽出判定）：`durationMs` 为空时不产出任何用时文案
3. `npx vue-tsc --noEmit` exit 0
4. `node --test tests/` 全绿（现有 205 项不得减少）

## 四、禁止

- 不改 `src-tauri/`、`backend/`、`agent-node/`
- 不改 legacy 渲染路径（`syncMode === 'legacy'` 的分支一行不动）
- 不引入新依赖
- 不 commit、不打包

## 五、交付

改动文件 / 真实测试输出 / 「与任务书不一致 / 没做到 / 有风险」
