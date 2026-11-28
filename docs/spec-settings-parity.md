# 规格：设置页桌面/移动对齐（字号 + 恢复默认）

> 任务来源：2026-11-28 设置页端差审计。
>
> **状态**：任务 A / B 已在 `fix/settings-parity` 分支完成并验证，**不要重做**。本文档末尾的「第二批」是当前要做的内容。

## 背景（为什么做）

1. 手机设置首页有「字号」6 档（`SettingsPage.vue:250-254`），桌面「外观」分区没有。字号不是装饰：`useFontScale` 会写 `<html data-font-size>`，驱动全局 `--fs`（`src/styles/main.css:1-6`），所有 `calc(x * var(--fs))` 跟着变。桌面缺入口＝功能缺失。
2. `src/components/settings/AppearanceSettings.vue:47-63` 有字号实现，但**没有任何文件引用该组件**（死代码），所以不能靠它。
3. `docs/spec-desktop-parity.md` 里「字号六档：`SettingsPage.vue` 共享，桌面有独立显示区」是**错误结论**，本次更正。该文档父级会改，你不用动。
4. 「恢复默认设置」：手机是「更多设置」列表里的一行（`:269`），桌面要先把右上角 `⋯`（`:208`）点开才有「恢复默认」（`:210-214`），入口太深。

## 任务 A（必须）：桌面「外观」分区补「字号」

**唯一文件**：`src/pages/SettingsPage.vue`

位置：桌面分支 `<template v-else-if="activeSection === 'appearance'">`（约 291-328 行）里 `<section class="set-sec"><h2>显示</h2>` 的 `.mat-solid` 容器内（现有三行：外观模式 / 减少透明度 / 减少动态效果）。

要求：

- 追加第四行，结构与「外观模式」完全一致：
  - 左侧 `<div class="grow"><div class="t">字号</div><div class="d">只影响文字大小；保存在本设备，不参与同步</div></div>`
  - 右侧 `<OpusSegment>` 内 `v-for="item in FONT_SCALE_OPTIONS"`，`<button type="button" :aria-pressed="fontScale === item.id" @click="setFontScale(item.id)">{{ item.label }}</button>`
  - 与移动分支 `:250-254` 使用同一套数据与行为
- `FONT_SCALE_OPTIONS`、`fontScale`、`setFontScale` 已在文件顶部导入/定义（约 `:23`、`:73`），**不要重复引入或重命名**
- 禁止新增裸 `font-size: <n>px` 声明（`tests/font-scale.test.mjs` 会扫描 `src/**` 与 `design/studiolo-redesign/*.css`，命中即失败）
- 不要改移动分支（那里已经正确）

## 任务 B（必须）：桌面导航底部露出「恢复默认设置」

**唯一文件**：`src/pages/SettingsPage.vue`

位置：桌面 `<nav class="set-nav">`（`:289`，`v-for="item in sections"` 的那个）。

要求：

- 在最后一个 `nav-item` 之后追加一个按钮，文案「恢复默认设置」，点击调用现有 `resetSettings()`（`:149`）
- 样式弱化，优先复用导航现有类或 `btn btn-ghost btn-sm`；**不要新增 `<style>` 规则、不要改 CSS 文件**
- 保留右上角 `⋯` 工具栏里的「恢复默认」按钮不动（`:213`）
- 先读 `resetSettings()` 的实现：如果它内部已经二次确认，直接调用；如果没有，也直接调用——**本任务不改变重置语义，只加一个入口**

## 不要做（out of bounds）

- 不要删除 `src/components/settings/AppearanceSettings.vue`、`src/components/settings/SettingsNav.vue`（死代码清理归父级）
- 不要动 `SyncSettings.vue`、`NotificationSettings.vue`、`AccountSettings.vue` 等其它组件
- 不要动 `src/stores/`、`src/composables/`、`src/styles/`、`package.json`
- 不要碰 `agent-node/`、`backend/`、`src-tauri/`
- 不要改 `docs/spec-desktop-parity.md`
- 不要 `git add` / `git commit` / `git checkout`（只允许 status/log/show/diff）

## 验收（你必须自己执行，并回贴真实输出）

1. `npx vue-tsc --noEmit`（如失败贴出完整错误）
2. `npm run test:font-scale`
3. `npm run test:theme-engine`
4. `git diff --stat`：只应出现 `src/pages/SettingsPage.vue`

## 交付报告格式

1. 改动点：`文件:行号` + 每个任务插入/修改的行数
2. 三条命令的真实结果（通过/失败 + 关键数字），失败要贴断言原文
3. 若规格与代码冲突（例如行号已漂移、`resetSettings` 有额外确认），先说明冲突再按最接近原意的方式实现，不要静默偏离

---

# 第二批（当前任务，2026-11-28 第二轮）

> 第一轮已完成并验证：任务 A（桌面字号 `:326`）、任务 B（桌面导航「恢复默认设置」`:291`）。**不要重做，不要回退**。
> 本批做 4 件事，全部需要你自己动手并自测。

## 任务 C（必须）：给「恢复默认设置」加二次确认

**文件**：`src/pages/SettingsPage.vue`

- 顶部新增导入：`import { confirmAction } from '../composables/useConfirm'`（同目录已有该 composable，`AutomationPage.vue` 用法可参考）
- 把 `resetSettings()`（当前约 `:149-152`）改成 `async function resetSettings()`：
  ```ts
  async function resetSettings() {
    if (!await confirmAction('恢复默认设置？这会重置外观、同步、安全、通知等所有设置项，且无法撤销。')) return
    const { timezone: _timezone, deploymentTimezone: _deploymentTimezone, ...editable } = structuredClone(defaultSettings)
    await saveSettings(editable)
  }
  ```
- 三处调用点（工具栏 `:213`、移动端列表 `:269`、桌面导航 `:291`）保持 `@click="resetSettings"` 不变，不要分别包 try
- `ConfirmDialog` 已全局挂载在 `App.vue:358`，不需要你引入组件
- 不要给别的按钮加确认

## 任务 D（必须）：删除两个无人引用的死组件

```bash
git rm src/components/settings/AppearanceSettings.vue src/components/settings/SettingsNav.vue
```

- 这两个文件全仓零引用（已核实：`grep -rl <name> src | grep -v 自身` 为空）
- `rm` 在你的 deny 名单里，但 `git rm` 不在；**只准用 `git rm`**。若被拒绝，立刻停止并如实报告，不要换 `mv`/`cp` 之类绕过
- 删除后再跑一次引用检查并把命令与输出贴回来

## 任务 E（必须）：修 `DownloadsPage.vue` 的裸 px（既有回归）

**文件**：`src/pages/DownloadsPage.vue`，共 3 处，只改这 3 行：

| 行（约） | 现在 | 改成 |
|---|---|---|
| `:832` | `font-size: 10.5px;` | `font-size: calc(10.5px * var(--fs));` |
| `:1106` | `font-size: 11px;` | `font-size: calc(11px * var(--fs));` |
| `:1281` | `font-size: 11px;` | `font-size: calc(11px * var(--fs));` |

- 这是 `tests/font-scale.test.mjs` 用例 2 在 main 上一直红的根因（v0.9.13 下载页引入）
- 不要顺手改其它样式，不要重排文件

## 任务 F（必须）：更正上一轮的错误文档结论

**文件**：`docs/spec-desktop-parity.md:19`

把这一行：

```
| 字号六档 | `SettingsPage.vue` 共享，桌面有独立「显示」区 |
```

改成：

```
| 字号六档 | `SettingsPage.vue`：移动端首页分段控件；桌面「外观 → 显示」行（2026-11-28 补齐） |
```

只改这一行，别动表格其它行。

## 本批验收（必须全部自己跑，回贴真实输出）

1. `npx vue-tsc --noEmit`
2. `npm run build`
3. `npm run test:font-scale` —— 本批结束后必须 **3/3 全绿**（用例 1、2、3 全过）
4. `npm run test:theme-engine`
5. `git status --short` —— 应为：`src/pages/SettingsPage.vue`、`src/pages/DownloadsPage.vue`、`docs/spec-desktop-parity.md` 修改，2 个组件 deleted

## 不要做

- 不要 commit / push / 切分支（父级负责提交）
- 不要动 `docs/spec-settings-parity.md` 本身
- 不要碰 `agent-node/`、`backend/`、`src-tauri/`、`package.json`

## 报告格式

1. 任务 C/D/E/F 各自 `文件:行号` 与改动摘要
2. 五条验收命令的真实输出（数字必须来自实际执行）
3. 任何偏离都要先说明原因
