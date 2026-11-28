# Studiolo v0.9.14 — 手机一键更新

## 新增：Android 应用内一键更新

设置 → 关于 → 检查更新，现在在手机上真的能用了（此前 Tauri 的 updater 插件不支持 Android，点了只会报错）。

- 检查走**原生 HTTP**（Kotlin `fetchText`），绕开 WebView 对第三方域的 CORS 限制
- 发现新版本 → 显示版本号与包大小 → 点「下载并安装」→ 实时百分比 → 完成后自动拉起系统安装器
- 下载走 `https://updates.isidel.com/apk`（Cloudflare Worker 302 到国内节点），比直连 GitHub 快很多
- 安装权限未授予时提示「需要允许本应用安装应用」，不再是英文报错

## 分发

- 新增稳定的更新入口 `https://updates.isidel.com/android.json`（Cloudflare Worker）
- 仓库代码里不再出现任何带签名的存储链接；APK 地址由运行时 manifest 提供
- 桌面端更新链路不变（GitHub `updater-feed/latest.json`）

## 修复

- 手机设置页「关于 / 检查更新」不再依赖 Core 设置是否加载完成，未登录也能看到
- 平台探测在 Tauri 注入前执行时会误判为桌面端，导致手机上走错更新分支
- 与默认后端共用 `check` 时 Android 分支被劫持到不支持的插件

## 已知说明

- 桌面端首次启动或每次换构建后，macOS 会弹一次「访问钥匙串中的密钥」，点「始终允许」即可
- 手机端从本版开始可以在应用内完成更新，不需要再手动下载 APK
