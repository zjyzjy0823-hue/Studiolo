# SPEC · 审批已决收成一行 + 思考展开限高

- 版本：v1（2026-11-23）
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 审查者：Hermes agent

## 1. 两个问题

1. **审批同意后拖一串**：`PermissionRequestCard` 已决（`decision !== 'pending'`）后，命令全文仍以 `<code class="perm-cmd">` 展示，`word-break: break-all` 把多行脚本折成十几行；下方 `ToolCallCard` 又显示一遍同一条命令。
2. **思考展开顶飞对话**：`WorkLog.vue` 的 `<p>{{ step.text }}</p>` 没有任何高度限制，`details` 一展开就撑满屏幕。

## 2. 改动一：`src/components/chat/PermissionRequestCard.vue`

### 2.1 行为

| 状态 | 期望 |
| --- | --- |
| `pending` | **完全保持现状**：命令全文（`perm-cmd`）+ 四个操作按钮 |
| 已决（`submitted`/`allow_*`/`deny`） | 命令**默认折叠成单行**：`✓ 已允许本次执行 · npm test -- --run`（超长省略）；点击这一行展开完整命令 |
| 已决且无命令 | 只显示决策行，不出现命令区 |

### 2.2 实现要求

- 新增本地状态 `expanded = ref(false)`；`watch(() => props.card.callId)` 时重置为 `false`。
- 计算首行：`(card.command || '').split('\n')[0].trim()`；判断是否有更多内容：`command.includes('\n') || command.length > firstLine.length`。
- 折叠行结构：

```html
<button type="button" class="perm-cmd-collapsed" @click="expanded = !expanded">
  <code class="perm-cmd-first">{{ firstLine }}</code>
  <span v-if="hasMore" class="perm-cmd-toggle">{{ expanded ? '收起' : '展开' }}</span>
</button>
<code v-if="expanded" class="perm-cmd">{{ card.command }}</code>
```

- 样式：`.perm-cmd-collapsed` 单行 `display:flex; gap:6px; align-items:center; width:100%;`，`.perm-cmd-first` 用 `overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`（**不要** `break-all`）。
- 保留已决态原有的 `.perm-done` 决策行（图标 + 文案），顺序：决策行在前，命令折叠行在后。
- 移动端（`max-width: 700px`）折叠行 `min-height: 40px`，符合 48dp 触控附近的可点区域。

## 3. 改动二：`src/components/chat/WorkLog.vue`

### 3.1 目标

思考展开后最多占 **40vh**，内部滚动，底部渐隐；展开有轻微过渡，不再瞬间撑满。

### 3.2 实现要求

- `.work-log-thought p` 增加：

```css
max-height: 40vh;
overflow-y: auto;
overscroll-behavior: contain;
mask-image: linear-gradient(to bottom, #000 calc(100% - 18px), transparent);
```

- 仅在内容真的溢出时才需要渐隐；允许用纯 CSS 实现（mask 在内容不足 40vh 时不可见，可接受）。
- 展开过渡：给 `p` 加

```css
@keyframes thought-reveal { from { max-height: 0; opacity: 0; } to { max-height: 40vh; opacity: 1; } }
.work-log-thought[open] p { animation: thought-reveal 0.18s ease-out; }
@media (prefers-reduced-motion: reduce) { .work-log-thought[open] p { animation: none; } }
```

- 不要改 `.work-log-timeline` 的 `--work-step-height`、步骤间距、工具卡片。
- 不要动 `WorkLog` 的 `label` 逻辑（本轮用时显示已由其它分支处理，勿回改）。

## 4. 不改的东西（明令禁止）

1. 不改 `pending` 审批卡片的布局与按钮
2. 不改 `ToolCallCard.vue`（命令/输出重复问题本轮不处理）
3. 不改 `FormQuestionCard.vue`
4. 不改 `AgentChatThread.vue` 的 approvals 渲染位置
5. 不改 `fleet.ts` / `chatHelpers.ts` / 任何 agent-node 代码
6. 不改 `durationMs`、回执、消息合并逻辑
7. 不 commit、不改版本号

## 5. 边界行为

| 场景 | 期望 |
| --- | --- |
| 待决审批 | 与改前完全一致 |
| 已决 + 单行短命令 | 折叠行直接显示完整命令，无「展开」 |
| 已决 + 多行脚本 | 折叠行显示首行 + 省略 + 「展开」，点开显示全文 |
| 已决 + 拒绝 | 显示「已拒绝执行」+ 命令折叠行 |
| 思考 200 字 | 展开后自然高度，不滚动 |
| 思考 3000 字 | 展开后 40vh + 内部滚动 + 底部渐隐 |
| `prefers-reduced-motion` | 无动画，其余行为一致 |

## 6. 门禁（自己跑并贴结果）

```bash
npx vue-tsc --noEmit -p tsconfig.json
npm run test:fleet
npm run build
```

## 7. 交付格式

```markdown
## 改动文件
- path:line — 一句话

## 门禁结果
- 命令 → 实际输出摘要

## 与 SPEC 的不一致
- 无 / 逐条说明

## 手动验证建议
1. …
```
