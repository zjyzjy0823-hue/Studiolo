# 规格：移动端功能对齐桌面端（清单）

> 方法：代码审计，不靠印象。依据是 `AgentChatThread.vue` 里的 43 处 `mobile` 分支、`saveDownload.ts` /
> `InlineAttachmentCard.vue` 里的 `isAndroidLocal()` 平台判断、以及 `stores/fleet.ts`（平台无关）。
> 结论分三类：**①桌面已具备**（不用动） / **②桌面确实缺**（建议补） / **③平台差异不该补**。

## ① 桌面已具备（共享同一份实现，无需处理）

| 功能 | 依据 |
|---|---|
| 发送即出 / 运行中被拒降级插话 | `stores/fleet.ts` + `agent-node` 服务端兜底，两端共用 |
| 回执多键对账、控制帧绕开流缓冲 | 同上 |
| 失败消息 ✕ 删除 + 7 天清理 + 重试复用 | store 层，启动时触发 |
| 运行中标志清零（settle + 回前台对账 + 90s 过期） | store 层，`visibilitychange` 桌面同样生效 |
| 工作步骤合并「工作步骤 · N 步」 | `messageSegments.ts` 渲染层 |
| 助手消息时间戳 | 桌面 hover 显示，移动端常显（有意差异） |
| 附件缩略图 / `[附带文件]` 剥离 | `messageSegments.ts` + `AgentChatThread.vue` 共享 |
| 停止/发送双键、运行中「发送（插话）」 | 两端都改过（`send-follow`） |
| 字号六档 | `SettingsPage.vue` 共享，桌面有独立「显示」区 |
| 主题 / 气泡样式 / 减少透明度 / 减少动态效果 | `SettingsPage.vue` 共享 |
| 模型与思考强度选择 | 桌面在 `composer-row` 的 `model-trigger`（移动端是常驻胶囊条，形态差异） |
| 系统通知（后台任务、待审批） | 移动端走原生通知，桌面走 Web Notification |
| 下载进度环 + 完成打勾（重进保留） | `InlineAttachmentCard.vue` + `downloadHistory.ts`（localStorage，跨平台） |
| 下载记录列表 | `components/settings/DownloadHistory.vue` |

## ② 桌面确实缺（建议补，按优先级）

| # | 功能 | 移动端行为 | 桌面现状 | 方案 | 工作量 |
|---|---|---|---|---|---|
| P1 | **打开已下载文件 / 打开方式** | MediaStore/FileProvider 唤起系统打开 | `openSavedDownload()` 直接抛「仅 Android 支持打开已下载文件」 | 桌面改为「Tauri save 对话框 + 写入真实路径 + `opener` 打开」，下载记录存绝对路径 | 2–3 h |
| P1 | **下载落到可预期位置** | `Download/Studiolo/` | `<a download>` 走浏览器默认目录，无路径记录 | 同上，改用 `dialog.save` + `fs.writeFile`，默认 `~/Downloads/Studiolo/<name>` | 含在 P1 |
| P2 | **「引用工作区文件 @」「斜杠指令 /」快捷入口** | 附件菜单里两个按钮 | 只有「选择照片/文件」，@ 与 / 需手打 | 桌面附件菜单补同样两项（复用 `insertQuickTrigger`） | 30 min |
| P2 | **下载/上传失败的可执行提示** | 「已保存到 Download/Studiolo」+ 打开 | 只有控制台级提示 | 桌面提示改为「已保存到 ~/Downloads/Studiolo」，并在记录里给「打开所在文件夹」 | 1 h |
| P3 | **相机拍照** | 调系统相机 | 桌面没有入口（也不该有）| 建议：macOS 走「拖拽/粘贴」，不补入口 | — |

## ③ 平台差异，不建议补

| 项 | 原因 |
|---|---|
| 移动端常驻「模型胶囊条」 | 桌面空间充裕，已在 composer 工具行展示模型与思考强度 |
| 移动端「+」快捷菜单的拍照 | 桌面用拖拽 / Ctrl+V 更自然 |
| 移动端返回手势、底部导航 | 桌面有侧边栏与快捷键 |

## 验收

1. 桌面下载一个附件 → 记录里出现真实路径 → 点「打开」由系统默认应用打开（不是浏览器另存）。
2. 桌面附件菜单出现「引用工作区文件 @」「调用斜杠指令 /」，点击后输入框插入前缀并弹出候选。
3. `npm run test:downloads` 仍全绿（新增桌面分支的用例）。
