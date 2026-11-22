# SPEC · Chat 加号「拍照 / 选择照片」（Android 原生媒体选择器）

- 版本：v1（2026-11-22）
- 目标版本：v0.8.6
- 实施者：Codex（`gpt-6.2-sol`, effort=high）
- 审查者：Hermes agent（读完 diff 后自行复跑门禁）

## 1. 目标

在 Chat 输入区加号面板（`panel === 'attach'`）新增两个入口：

| 入口 | Android | 桌面 |
| --- | --- | --- |
| **拍照** | 拉起系统相机，拍完全尺寸 JPEG 后降采样返回 | 不显示 |
| **选择照片** | 系统照片选择器（可多选） | 隐藏 input + `accept="image/*"` |

拍照/选图结果统一进入现有 `queuedFiles`，复用现有 AES-256-GCM 分块加密上传链路（`encryptAndUploadFile`）。**不新建上传通道。**

## 2. 非目标

- 不做视频、录音、多摄像头（超广角/长焦）切换
- 不做应用内自定义相机 UI（不引 CameraX）
- 不做 iOS
- 不改消息气泡渲染、不改预览弹层、不改 `SpacePage`
- 不改任何版本号、不 commit

## 3. 现状（已确认，勿重复造）

| 事实 | 位置 |
| --- | --- |
| 加号面板渲染 | `src/components/chat/AgentChatThread.vue:3085` `<template v-if="panel === 'attach'">` |
| 现有文件选择 | 同文件 `fileInputRef`（`:2813`）、`triggerFilePick()`（`:1655`）、`handleFileSelect()`（`:1750`）、`appendFiles()`（`:1660`） |
| 待发送附件 | `queuedFiles` computed（`:216`），chip 渲染在 `:2849`，图片缩略图走 `queuedFileThumb()` |
| Android 插件模板目录 | `src-tauri/android/*.kt`（**被 git 跟踪**，是唯一可编辑处） |
| 模板复制进 gen | `scripts/android-prepare.mjs:60-62` 的 `copy()` 列表 |
| 插件注册 | `src-tauri/src/lib.rs:301-303`（`.plugin(android::…)`，均在 `#[cfg(target_os = "android")]` 分支内） |
| Rust 桥范例 | `src-tauri/src/android.rs`：`AndroidDownloads`（`run_mobile_plugin_async` + `CommandResult`） |
| Kotlin 范例 | `src-tauri/android/AndroidDownloads.kt`（`@TauriPlugin` + `@Command fun x(invoke: Invoke)`） |
| FileProvider | `AndroidManifest.xml` authority `${applicationId}.fileprovider`；`res/xml/file_paths.xml` 已含 `cache-path name="my_cache_images" path="."` |
| gen 目录 | `src-tauri/gen/` **全目录 gitignore（0 跟踪）**，禁止在其中留下任何唯一改动 |

## 4. 契约（先冻结，前后端按此实现）

### 4.1 Rust 命令

```rust
#[derive(serde::Serialize)]
pub struct PickedImage {
    pub name: String,   // photo-20261122-201530.jpg / IMG_0001.jpg
    pub mime: String,   // image/jpeg（统一转 JPEG 输出）
    pub base64: String, // 已降采样的 JPEG 字节
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
async fn android_capture_photo(state: State<'_, AndroidMedia>) -> CommandResult<PickedImage>;

#[tauri::command]
async fn android_pick_images(state: State<'_, AndroidMedia>, limit: Option<u32>) -> CommandResult<Vec<PickedImage>>;
```

- `limit` 默认 10，上限 20。
- 用户取消：`capture` 返回 `Err("cancelled")`；`pick` 返回空数组 `[]`（不报错）。
- 前端按 `code === 'cancelled'` 静默处理，不弹 toast。

### 4.2 Kotlin 插件命令名

`AndroidMedia.kt` 暴露 `capturePhoto` / `pickImages`，返回 JSObject：

```json
{ "items": [ { "name": "...", "mime": "image/jpeg", "base64": "...", "width": 2048, "height": 1536 } ] }
```

Rust 侧拆包成 `Vec<PickedImage>` / 单元素。

## 5. Kotlin 实现约束（关键，照做可避免踩坑）

1. **生命周期**：`ActivityResultLauncher` 必须早于 `STARTED` 注册。插件在 WebView 创建时才 load，此时 Activity 往往已 RESUMED，直接 `activityResultRegistry.register(...)` 会抛 `IllegalStateException`。
   **采用方案**：在 `src-tauri/android/MainActivity.kt` 里用 `registerForActivityResult` 预先注册两个 launcher，回调经一个进程内 `object AndroidMediaBridge` 转给插件。
   - `ActivityResultContracts.TakePicture()`（需要预先构造 `content://` 输出 Uri）
   - `ActivityResultContracts.PickMultipleVisualMedia(limit)`；若该 API 在当前 `androidx.activity` 版本不可用，退化用 `Intent.ACTION_GET_CONTENT` + `EXTRA_ALLOW_MULTIPLE` + `type="image/*"`（零新依赖）。
2. **权限**：**禁止**在 `AndroidManifest.xml` 声明 `android.permission.CAMERA`。
   系统相机 Intent 下若声明了 CAMERA 反而要求运行时授权；不声明则相机 App 自己负责。
   `PickVisualMedia` 无需任何存储权限。旧机退化路径同样无需 `READ_EXTERNAL_STORAGE`。
3. **FileProvider 输出**：拍照输出写 `host.cacheDir/media/`，用
   `FileProvider.getUriForFile(host, "${host.packageName}.fileprovider", file)`，
   Intent 加 `FLAG_GRANT_WRITE_URI_PERMISSION`。`file_paths.xml` 已含 `cache-path`，**不要改 xml**。
4. **降采样 + 转正**（必须做，否则 8 MB 原图走 IPC 会卡，且 agent 侧看图会歪）：
   - 两段解码：`inJustDecodeBounds` 取尺寸 → `inSampleSize` 降到长边 ≤ 2048
   - 读 EXIF 方向：用 **framework 的 `android.media.ExifInterface`**（API 24+ 自带，**不要加 gradle 依赖**），按 90/180/270 用 `Matrix` 旋转
   - 输出 JPEG `quality = 85`，mime 统一 `image/jpeg`，文件名 `photo-yyyyMMdd-HHmmss.jpg`
   - 删掉 cache 里的源文件（降采样完成后）
5. **线程**：解码/编码放单线程 `Executor`，结果回主线程 `invoke.resolve/reject`（照 `AndroidDownloads.kt` 的 `writer` 写法）。
6. **IPC 大小**：单张降采样后应 < 1.5 MB base64；超 8 MiB base64 直接 `reject("too_large")`（Tauri typed parser 对 >32 MiB 字符串有限制，留足余量）。

## 6. 构建接线（三处缺一不可）

1. `src-tauri/android/AndroidMedia.kt`（新建，唯一真源）
2. `scripts/android-prepare.mjs:61` 的数组加入 `'AndroidMedia.kt'`
3. `src-tauri/src/lib.rs`：
   - `#[cfg(target_os = "android")]` 块内加 `.plugin(android::media_plugin())`
   - `generate_handler![…]` 加 `android_capture_photo`, `android_pick_images`（同样只在 android cfg 分支）
4. `src-tauri/src/android.rs`：新增 `pub struct AndroidMedia(PluginHandle<...>)` + `pub fn media_plugin() -> TauriPlugin<...>`，完全照 `AndroidDownloads` 的形状。

## 7. 前端改动（`src/components/chat/AgentChatThread.vue`）

1. 加号面板（`panel === 'attach'` 内，现有「上传加密文件」之后）加两项：
   - `拍照` — `v-if="isAndroid"`，图标用现有 `OpusIcon` 可用名（如 `camera` / `photo`；若 registry 无此名，用 `plus`/`image` 里已存在的，**不要新增 svg 文件**，先在 `OpusIcon` 注册表里确认）
   - `选择照片` — Android 走原生 `pickImages`；非 Android 复用隐藏 `<input accept="image/*">`
2. 新增函数：
   ```ts
   const isAndroid = isTauri() && desktopPlatform() === 'android'   // 复用现有 desktopPlatform()
   async function captureNativePhoto() { … }   // closeSettings() → androidInvoke → appendFiles
   async function pickNativeImages() { … }
   function base64ToFile(item: PickedImage): File  // 分块 atob/Blob，禁止一次性 atob 巨型字符串
   ```
3. `appendFiles()` 前不需要额外压缩（Kotlin 已降采样）；若 `mime` 不是 `image/*` 则跳过并 toast。
4. 错误处理：`cancelled` 静默；其他 `code` 用现有 `emit('action', …)` toast，文案中文。

## 8. 门禁（必须自己跑并在交付里贴结果）

```bash
# 前端类型与构建
npx vue-tsc --noEmit -p tsconfig.json
npm run build            # 或项目现有桌面前端构建命令

# Rust（桌面 target 不编译 android.rs，必须用 android target）
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.2.12479018}"
cd src-tauri && cargo check --target aarch64-linux-android

# 模板接线自检（不跑完整 Gradle）
node scripts/android-prepare.mjs && grep -c "AndroidMedia" \
  src-tauri/gen/android/app/src/main/java/com/isidel/studiolo/AndroidMedia.kt
```

- 不要求本机出 APK（真机验收由 JY 装包完成），但上面的 `cargo check --target aarch64-linux-android` 必须真跑。
- 若 NDK 路径与机器不符，先 `ls $HOME/Library/Android/sdk/ndk` 找实际版本，**不要跳过**，改成实际路径后跑。

## 9. 明令禁止

1. 不 commit、不 push、不开 PR、不改版本号
2. 不改 `LocalCorePlugin.kt` 的任何路径校验（`read_device_space` 的边界逻辑）
3. 不碰 Shared Space 密码学（`backend/app/space/*`、`src/services/blobTransfer.ts`）
4. 不在 `src-tauri/gen/` 里留下唯一改动（所有 Kotlin 源必须落在 `src-tauri/android/`）
5. 不加任何新 gradle/npm 依赖（EXIF 用 framework 的 `android.media.ExifInterface`，选图用 androidx 已有 API）
6. 不声明 CAMERA / READ_MEDIA_IMAGES / READ_EXTERNAL_STORAGE 权限
7. 不重排 `panel === 'attach'` 现有菜单项顺序，只追加
8. 不改动 `queuedFiles` / outbox / 上传链路的既有语义
9. 不引入新 `OpusIcon` svg 资源（用已有名）

## 10. 交付格式（最后一条消息）

```markdown
## 改动文件
- path:line — 一句话

## 门禁结果
- 命令 → 实际输出摘要（passed/failed + 数字）

## 与 SPEC 的不一致
- 无 / 逐条说明原因

## 真机验收步骤（JY 照着点）
1. …
```

额度耗尽时：保留已完成改动，写清完成到哪一步、哪些测试跑过、下一步从哪继续。
