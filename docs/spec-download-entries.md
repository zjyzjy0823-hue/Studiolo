# SPEC：给「下载记录」加两个入口（小改动）

下载记录页**已经做好并提交**：`src/components/settings/DownloadHistory.vue`，
挂在设置页的 `downloads` 分区。设置页支持用 URL 定位分区：
`/settings?section=downloads`（`SettingsPage.vue` 的 `sectionFromSearch()` 会读）。

这轮只做**两个跳转入口**，不许改下载记录页本身。

## 入口一：手机端会话列表右上角「⋯」

文件 `src/pages/ChatPage.vue`，找到 `m-inbox-more-menu`（`更多会话选项`）里的菜单项列表：

- 新增一项「下载记录」，复用现有 `class="m-fmenu-item"` 与 `OpusIcon name="download"`
  （`OpusIcon` 若没有 `download` 图标，就用现有的 `folder` 之类，先确认有哪些 name 可用）
- 点击后：关闭菜单（`mobileMoreMenuOpen = false`），然后跳转到 `/settings?section=downloads`
- 跳转方式必须沿用该文件里已有的路由/导航写法（先读它现在怎么切页，不要自己发明 `window.location`）

## 入口二：PC 端

在 PC 布局里同样放一个能到 `/settings?section=downloads` 的入口：

- 先读 PC 侧导航/侧栏（`src/components/layout/`、`src/App.vue` 或 ChatPage 的桌面分支）看现有「设置」入口怎么写的
- 就在「设置」旁边/子项里加「下载记录」，沿用同一套导航方式
- 如果 PC 侧本来就有设置子菜单，加成子项；没有的话就加一个同级的图标+文字入口，样式跟随邻居

## 约束

- 只改：`src/pages/ChatPage.vue` 与 PC 导航相关文件（必要时 `src/components/layout/*`）
- 不要改 `DownloadHistory.vue`、`downloadHistory.ts`、`SettingsPage.vue` 的逻辑（除非只是加一行 import）
- 不 commit、不打包、不碰 `src-tauri/`、`backend/`、`agent-node/`

## 验证（真跑并贴输出）

- `npx vue-tsc --noEmit` 必须 0 错误
- `node --test tests/` 全绿

## 交付

改动文件 / 真实输出 / 与 SPEC 不一致处
