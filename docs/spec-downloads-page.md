# 规格：PC 端「下载」独立页面（落地实现）

> 用户已选定 **方案 A（表格型）**，并提出两处修改：
> 1. **去掉左上角的「下载」大标题和下面那行说明文字**（页面不再有 header 区块）
> 2. **右上角的「刷新」和「在文件夹中打开」合并到下面那行工具栏里**

## 一、交互与路由

| 项 | 要求 |
|---|---|
| 侧栏下载图标 | 直接进新页面（`page === 'Downloads'`），**不再** `go('Settings', false, 'downloads')` |
| 高亮 | 侧栏下载图标在 `currentPage === 'Downloads'` 时高亮 |
| 设置入口 | 设置 →「下载记录」**保留**（`DownloadHistory.vue` 不动），可从这里跳到新页面 |
| 页面类型 | `App.vue` 的 `Page` 联合类型加 `'Downloads'`，渲染 `<DownloadsPage />` |

## 二、页面结构（自上而下）

1. **工具栏（单行）**
   - 左：搜索框（占位「按文件名或来源会话搜索」，带搜索图标，`⌘F` 聚焦可选）
   - 中：类型筛选 chips —— `全部 N` / `图片` / `文档` / `压缩包` / `安装包` / `其它`（带各自数量，选中态用 accent）
   - 中右：时间下拉（全部时间 / 今天 / 近 7 天 / 近 30 天）、排序下拉（时间倒序 / 时间正序 / 大小 / 名称）
   - **最右：刷新图标按钮 + 「在文件夹中打开」按钮**（这两颗从原 header 移过来，尺寸与 chips 一致高度）
2. **批量操作条**（仅当选中 ≥1 时出现，占一行，不跳变）
   - `已选 N 项 · 共 X MB` + 批量打开 / 在文件夹中显示 / 删除 / 取消选择
3. **表格**
   - 列：`☑` | 文件名（类型图标 + 名称 + 次级路径） | 来源会话（胶囊，可点击跳会话） | 大小 | 时间 | 状态 | 操作
   - 状态：`已完成`（绿点）/ `下载中 42%`（进度条 + 速度）/ `失败`（红字 + 「重试」按钮）
   - 行 hover 有底色；选中行 accent 左侧 2px 竖条
   - 进行中的任务固定排在最前（其次按选择的排序）
4. **空状态**：居中图标 + 「还没有下载记录」+ 「在对话里点附件的『下载』后，文件会出现在这里」
5. 不做页面级 header（无标题、无描述）

## 三、数据与行为

### 数据源
- 历史：`src/services/downloadHistory.ts` 的 `readDownloads()`（`DownloadRecord[]`：`id/name/sizeBytes/at/channel/status/url?/expiresAt?/sessionKey?/displayPath?`）
- 进行中：`src/services/downloadProgress.ts` 的 `downloadProgressStore`（订阅式，`DownloadProgressState`）
- 监听变更：`storage` 事件 + 组件挂载时刷新 + 进度 store 订阅

### 操作
| 操作 | 实现 |
|---|---|
| 打开 | 已有 `openSavedDownload(record)`（桌面走 `open_saved_path`） |
| 在文件夹中显示 | **新增 Rust 命令 `reveal_in_folder(path)`**：macOS `open -R <path>`、Windows `explorer /select,<path>`；同样只允许下载目录内路径，失败返回 `path_missing` |
| 重新下载 | `record.url` 存在且未过期 → 触发下载（复用现有下载路径）；否则按钮 disabled + tooltip「链接已过期，请回到原会话重新下载」 |
| 删除 | 只删记录（不动磁盘文件），删除后 toast「已删除记录」；批量删除同理 |
| 批量打开 | 逐个 `openSavedDownload`，失败的跳过并 toast 汇总 |

### 纯函数（放 `src/services/downloadsView.ts`，便于测试）
- `typeOf(name)` → `image|doc|archive|installer|other`
- `filterRecords(records, { query, type, range, sort })`
- `summarize(records)` → `{ count, totalBytes, byType }`
- `formatBytesHuman(n)`（若已有 formatBytes 则复用）

## 四、视觉要求

- 完全沿用现有设计语言：`mat-solid` 卡片、`--surface/--line/--text/--text-2/--accent/--danger/--r-lg`、字号 `calc(Npx * var(--fs))`
- 表格行高 44px，表头 36px，斑马纹不要，靠分隔线
- 亮/暗主题都要正常（token 已经主题化，不要写死颜色）
- 图标用内联 SVG（复用 `OpusIcon` 或 lucide 风格），不用 emoji

## 五、同时更新样例

把 `~/Projects/riri-mocks/download-page/a-table.html` 按上面两处修改同步（去掉 header、按钮并入工具栏），方便截屏对照。

## 六、约束

- 新增：`src/pages/DownloadsPage.vue`、`src/services/downloadsView.ts`、`tests/downloads-view.test.mjs`
- 修改：`src/App.vue`（Page 类型 + 渲染）、`src/components/layout/OpusShell.vue`（侧栏入口 + 高亮）、`src-tauri/src/lib.rs`（`reveal_in_folder` + 注册）
- 不动：`DownloadHistory.vue`、`downloadHistory.ts` 的存储格式、其它页面
- 不新增 npm 依赖；不 commit
- 完成后必须真实运行：`npx vue-tsc --noEmit`、`npm run build`、`npm run test:downloads`、新增的 `npm run test:downloads-view`，并贴真实输出

## 七、验收

1. 侧栏点下载图标 → 进入新页面（不是设置）
2. 页面顶部**没有**大标题与说明文字
3. 「刷新」「在文件夹中打开」在工具栏最右侧，与筛选 chips 同一行
4. 8 条以上记录正常渲染；进行中任务在最前且有进度；失败行可重试
5. 选中出现批量条；空状态下提示文案正确
6. 桌面点「打开」可用；「在文件夹中显示」能定位到文件
