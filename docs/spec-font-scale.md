# SPEC：全局字号调节（方案 A：`--fs` 变量 + 机械替换）

> 目标：外观设置里可选字号档位，**只缩放文字**，布局/图标/间距不变；默认可与今天像素完全一致。

## 0. 硬前提（必须先读）

- 全站字号是硬编码 px：`font-size: <n>px` 共 **813 处**（`src/**/*.vue`、`src/**/*.css`）。
- 还有少数 `font-size: clamp(a, b, c)`（px / cqi 单位），同样要缩放。
- 没有 `font:` 简写带字号、没有内联 `fontSize: '12px'`、没有 SVG `font-size=`。
- 存在 1 处 `font-size: .88em` —— **不要动**（相对单位本来就会跟随父级）。

## 1. 档位（6 档，含 0.8）

| id | 名称 | 倍率 |
|---|---|---|
| `compact` | 紧凑 | **0.8** |
| `small` | 小 | 0.9 |
| `standard` | 标准 | 1（默认） |
| `large` | 大 | 1.12 |
| `xlarge` | 更大 | 1.25 |
| `huge` | 特大 | 1.4 |

## 2. 机制

### 2.1 变量
在全局样式（`src/styles/main.css` 或 `opus-app.css` 顶部，选已经在最前面加载的那个）加：

```css
:root { --fs: 1; }
[data-font-size="compact"] { --fs: 0.8; }
[data-font-size="small"]   { --fs: 0.9; }
[data-font-size="standard"]{ --fs: 1; }
[data-font-size="large"]   { --fs: 1.12; }
[data-font-size="xlarge"]  { --fs: 1.25; }
[data-font-size="huge"]    { --fs: 1.4; }
```

### 2.2 机械替换（用脚本做，不要手改 813 处）

对 `src/**/*.{vue,css}` 中所有 **长度型** `font-size` 值：

- `font-size: 12px;` → `font-size: calc(12px * var(--fs));`
- `font-size: 12.5px;` → `font-size: calc(12.5px * var(--fs));`
- `font-size: clamp(28px, 3vw, 38px);` → `font-size: calc(clamp(28px, 3vw, 38px) * var(--fs));`
- `font-size: clamp(14px, 1.35cqi, 24px);` → 同上规则

**不要动**：`font-size: inherit`、`font-size: .88em`、`font-size: inherit/100%/var(--x)`、`font: inherit`。

脚本要求（可复现、可审查）：
- 用 `python3` 写一个一次性脚本放在 `/tmp`（不要进仓库），正则只匹配 `font-size\s*:\s*([^;{}]+?)\s*(;|})`，对 value 做判断：
  - 含 `px` 或 `clamp(` → 包一层 `calc((<value>) * var(--fs))`
  - 否则跳过
- 输出「替换数 / 跳过数」，并保证 `git diff` 里**只有** `font-size` 行变化。

### 2.3 运行时
新建 `src/composables/useFontScale.ts`（照着 `useWorkbenchTheme.ts` 的写法）：

```ts
export type FontScaleId = 'compact' | 'small' | 'standard' | 'large' | 'xlarge' | 'huge'
export const FONT_SCALE_OPTIONS: { id: FontScaleId; label: string; factor: number }[]
export function useFontScale(): { scale: Ref<FontScaleId>; setScale(id: FontScaleId): void }
```
- localStorage key：`studiolo:font-scale`（与 `studiolo:workbench-theme` 同级约定）
- 应用方式：`document.documentElement.dataset.fontSize = id`（未设置时写 `standard`）
- **启动即应用**：在 `src/main.ts`（或 `App.vue` onMounted 之前）调用一次，避免首帧闪烁
- 存储失败时静默降级为 `standard`

### 2.4 设置入口
`src/components/settings/AppearanceSettings.vue` 增加一张卡（放在「工作台主题」卡下面）：

- 标题「字号」
- 6 个档位按钮（分段控件，移动端可换行）
- 一句实时预览文本：`这是正文预览：Agent 正在读取 src/stores/fleet.ts 并执行 12 个工具调用。`
- 「恢复默认」按钮
- 说明文字：「只影响文字大小；保存在本设备，不参与 Sync v3。」

**不进 Sync v3**（和主题一致，避免手机/桌面互相覆盖）。

## 3. 已知需要目测微调的地方（允许改，但只允许这些）

文字放大后个别**固定高度**容器会挤。只允许把这几类 `height: <n>px` 改成 `min-height: <n>px`，且必须在交付里逐条列出：
- 聊天气泡的收据行、工具卡头部、待发队列行
- 设置页的 `setting-row` / 分段控件按钮
- 顶部工具栏按钮

不允许改间距、圆角、图标尺寸、动画。

## 4. 测试

新增 `tests/font-scale.test.mjs`（node:test + node:fs）：

1. **档位映射**：6 档 id/factor 与 spec 一致，默认 `standard`。
2. **裸 px 守卫**：扫描 `src/**/*.{vue,css}`，断言匹配 `font-size\s*:\s*[0-9.]+px` 的数量为 **0**（`calc(... * var(--fs))` 不匹配）。例外白名单：无。
3. **变量声明存在**：`--fs: 1` 与 6 个 `[data-font-size=...]` 块都存在。

`package.json` 增加：
```json
"test:font-scale": "node --test tests/font-scale.test.mjs"
```

验收门槛：
1. `npm run test:font-scale` 全绿
2. `npm run test:fleet`（65）与 `npm run test:outbox`（14）不回归
3. `npx vue-tsc --noEmit` 0 报错
4. `git diff` 中仅新增/修改与本 spec 相关的行；`font-size` 行除包裹 `calc()` 外内容不得变化
5. 813 处替换后，抽查 5 个文件（`AgentChatThread.vue`、`opus-app.css`、`settings.css`、`ChatPage.vue`、`WorkLog.vue`）每处都是 `calc(<原值> * var(--fs))`

## 5. 边界

- 只改 `src/**`、`tests/**`、`package.json`
- 不改 agent-node / Core / Hermes；不改主题令牌、配色、间距
- 不新增依赖；不 commit
- 图标（lucide `:size`、`OpusIcon`）一律不动

## 6. 交付格式

1. 脚本输出：替换数 / 跳过数（贴真实数字）
2. 改动文件清单 + `文件:行号`
3. 三条命令真实输出（test:font-scale / test:fleet / test:outbox）+ `vue-tsc`
4. 被改成 `min-height` 的位置逐条列出
5. 未完成项或偏离说明
