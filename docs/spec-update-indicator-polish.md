# 规格：更新入口视觉与交互打磨

> 功能已经跑通（真机实测 0.9.12 → 0.9.13 一键更新成功）。本次**只做视觉与交互**，不改状态机、不改 IPC、不改 tauri 配置。

## 现状问题（评估）

1. 按钮 32×32，但 `footer.statusbar` 行高只有 24px 左右 → 按钮把状态栏撑高、和版本号基线不齐。
2. 纯黑圆 + 白色图标，在浅色与暗色主题下都显得"贴上去的"，没有融入设计系统。
3. 交互反馈只有 `transform: scale(1.05)`，没有按下态、没有焦点环、状态切换是硬切。
4. 弹层是普通白卡片，没有指向按钮的箭头、没有出现动画、没有"稍后"入口。
5. 下载中只有外圈 conic 进度，没有百分比文字提示。

## 目标

### A. 按钮（`src/components/layout/OpusShell.vue`）

| 项 | 要求 |
|---|---|
| 尺寸 | **24×24**，圆角 50%，`flex: none`，与版本号间距 8px，右侧留 8px |
| 底色 | 亮色主题 `#0f1115`，暗色主题 `rgba(255,255,255,.9)`（图标反色）；两种都加 1px `inset 0 0 0 1px rgba(255,255,255,.12)` 内描边避免糊在背景上 |
| 图标 | 13px，`stroke-width: 2`，白色（暗色主题深色） |
| hover | `translateY(-1px)` + `box-shadow: 0 4px 10px rgba(0,0,0,.25)` + 箭头 `rotate(18deg)`，过渡 160ms |
| active | `scale(.92)`，过渡 90ms |
| focus-visible | `0 0 0 2px var(--surface), 0 0 0 4px var(--accent)` |
| 状态过渡 | 背景/颜色 180ms，图标切换 180ms |

状态视觉：

| 状态 | 呈现 |
|---|---|
| `idle` / `up-to-date` | 静态刷新箭头；`title` 保持现有文案 |
| `checking` | 箭头顺时针旋转 1s 线性；按钮底色略微提亮 |
| `available` | 右上角 7px accent 圆点 + **呼吸光环**（`box-shadow` 0 0 0 0 → 6px accent 透明度衰减，2s 循环）；hover 时光环加快 |
| `downloading` | 外圈 conic 进度 + 内圈深底；hover 时在按钮上方显示 `42%` 小气泡（`aria-hidden`，纯视觉） |
| `ready` | 用 `RotateCw`，加一次 600ms 的轻微上下弹跳（`@keyframes nudge`） |
| `error` | 1px 红色外环 + 图标改红；不改变大小 |

`@media (prefers-reduced-motion: reduce)` 下：关闭旋转/光环/弹跳，只保留颜色变化。

### B. 弹层（同一文件）

- 宽度 **260px**，圆角 `var(--r-lg)`，`1px solid var(--line)`，`box-shadow: var(--shadow-pop)`
- 结构：
  1. 标题行：`发现新版本` + 右上角 `×` 关闭按钮（24px，hover 有底色）
  2. 副行：版本 chip（`vX.Y.Z`，accent 背景 12% 透明、accent 文字）+ 包大小
  3. 说明：最多 3 行，`line-clamp: 3`（不要 `nowrap` 省略成一行）
  4. 操作行：主按钮「下载并安装」（`btn-primary`，占满宽度）+ 次按钮「稍后」（`btn-ghost`，右对齐）
- 出现动画：从按钮方向 `scale(.96) translateY(4px)` → 原大小，180ms `cubic-bezier(.2,.8,.2,1)`
- 弹层右下角有一个 8px 的旋转 45° 小方块作为"箭头"，颜色与弹层一致
- 点击弹层外部 / Esc 关闭（已有逻辑保留）
- 焦点陷阱不做，但弹层打开时把焦点放到「下载并安装」

### C. 手机设置页（`src/components/settings/UpdateRow.vue`）

- 行右侧改为：小图标（`RefreshCw`/`RotateCw`/`AlertCircle`）+ 状态文字，整体用胶囊样式（`padding: 4px 10px; border-radius: 999px; background: var(--surface-2)`），与设置页其它 `chip` 保持一致
- 状态文案：`已是最新` / `发现 vX.Y.Z` / `下载中 42%` / `重启生效` / `检查失败`
- 点击行为不变

## 约束

- 只改：`src/components/layout/OpusShell.vue`、`src/components/settings/UpdateRow.vue`（以及必要时新增 `src/components/settings/update-row.css`）
- 只用现有设计 token（`--accent`、`--line`、`--surface*`、`--shadow-pop`、`--r-lg`、`--fs`），不要引入新颜色变量
- 不改 `useUpdater.ts` 的任何逻辑与状态名；不改 tauri 配置、CI、其它页面
- 所有字号继续用 `calc(Npx * var(--fs))`
- 不 commit

## 验收

1. `npx vue-tsc --noEmit` 0 报错、`npm run build` 成功。
2. 状态栏高度不因按钮变大（按钮 24px，行高不变）。
3. 用构建产物 CSS 渲染按钮的 5 种状态截图（可用临时 HTML harness），确认：尺寸 24、有呼吸光环、有进度环、有 hover 位移。
4. 浅色与暗色主题各截一张，按钮都"融入"背景而不是硬贴。
