# 规格：更新链路加固（客户端哈希校验 + 发版脚本按版本选包 + 测试与 CI 补漏）

> 背景：`test:updater-android` 用例 7 在干净检出上必红（依赖被 gitignore 的 `dist-release/`，还硬编码了 0.9.13 APK 的 size/hash）。顺着查下去发现两个真实缺陷：
> 1. `scripts/make-latest-json.mjs` 选 APK 只取目录里第一个 `*_arm64-release.apk`，**不校验版本**——实测请求 `0.9.14` 返回的是 `0.9.13` 的 url/size/sha256。
> 2. 手机端下载完**从不校验** `manifest.sha256`，只要 feed 与 `/apk` 不同步就会「提示新版 → 装到旧包」且无任何报错。
>
> 本批四项改动全部只在这 4 个文件里，**不要动其它任何文件**。

## 任务 1（P1）：客户端下载后校验 sha256

**文件**：`src/composables/useUpdater.ts`

位置：Android 分支里 `fullBytes` 组装完成之后、`// Chunked Base64` 之前（当前约 `:338`）。

插入逻辑（可微调实现，语义不得变）：

```ts
// 更新包完整性校验：manifest 带 sha256 时必须匹配，否则不落盘、不拉起安装器
const expectedSha = typeof currentUpdate.rawJson?.sha256 === 'string'
  ? currentUpdate.rawJson.sha256.trim().toLowerCase()
  : ''
if (expectedSha) {
  let actualSha = ''
  try {
    const digest = await crypto.subtle.digest('SHA-256', fullBytes)
    actualSha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    actualSha = ''
  }
  if (actualSha !== expectedSha) {
    state.value = 'error'
    error.value = '更新包校验失败，请重试'
    return
  }
}
```

硬性要求：

- `sha256` 现在挂在 `currentUpdate.rawJson.sha256`（见 `:211`），**不是**顶层字段
- manifest 没带 `sha256` → 跳过校验（兼容旧 feed），不能把更新卡死
- 哈希算不出来（`crypto.subtle` 不可用）→ 当作校验失败（宁可报错，不装未校验的包）
- 必须在 `android_save_attachment` 之前返回，**不允许**留下半截文件
- 桌面分支（`downloadAndInstall` 那条）一行都不要改

## 任务 2（P2）：发版脚本按版本精确选 APK

**文件**：`scripts/make-latest-json.mjs`，只改 `generateAndroidManifest()`

现状（错误行为）：

```js
const candidate = entries.find(e => e.endsWith('_arm64-release.apk'))
```

要求的判定顺序：

1. 显式传了 `--apk`：使用它；但文件名必须包含 `_${version}_`，否则 `throw new Error(...)` 说明版本与文件名不一致
2. 未传 `--apk` 且有 `releaseDir`：
   - 收集 `entries.filter(e => e.endsWith('_arm64-release.apk'))`
   - **空集合 → 返回 `null`**（桌面-only 发版，保持现有「跳过 android.json」行为，main() 继续 warn）
   - 非空 → 精确匹配 `e.endsWith('_${version}_arm64-release.apk')`
   - 一个都没匹配上 → `throw new Error`，文案要带上「目录里有哪些版本」和「请求的是哪个版本」，让发版人一眼看懂
3. 不要用 `.find()` 兜底取第一个

注意：`main()` 已经有 `try/catch` + `process.exit(1)`，抛错会自动变成失败退出，不要额外改 `main()`。

## 任务 3（P2）：测试改成自带输入 + 补边界用例

**文件**：`tests/updater-android.test.mjs`

### 3.1 重写用例 7（`scripts/make-latest-json.mjs 生成 android.json 格式结构`）

- 不再使用 `releaseDir: 'dist-release'`
- 用 `fs.mkdtempSync(path.join(os.tmpdir(), 'studiolo-apk-'))` 建临时目录
- 写入假 APK：`Studiolo_0.9.13_arm64-release.apk`，内容固定（如 `Buffer.from('fake-apk-for-manifest-test')`）
- 断言：
  - `manifest.version === '0.9.13'`
  - `manifest.url === '<baseUrl>/Studiolo_0.9.13_arm64-release.apk'`
  - `manifest.size === <写入字节数>`
  - `manifest.sha256 === <测试里用 node:crypto 现算的 hex>`
  - `manifest.notes` 原样透传
- 用例结束清理临时目录（`fs.rmSync(dir, { recursive: true, force: true })`，`finally` 里做）

### 3.2 新增用例（都是 `test(...)` 顶层，不要塞进别的用例里）

| # | 场景 | 期望 |
|---|---|---|
| 8 | 同目录同时有 0.9.13 与 0.9.14 两个 APK，请求 0.9.14 | url/size/sha256 全部是 0.9.14 那份（**这条就是今天这个 bug 的回归守卫**）|
| 9 | 目录里一个 APK 都没有 | `generateAndroidManifest(...) === null`（不是抛错）|
| 10 | 目录里只有 0.9.13，请求 0.9.14 | `assert.throws(...)`，错误文案含 `0.9.14` |
| 11 | 更新流：manifest.sha256 与下载字节**不一致** | `state === 'error'`、`error` 含「校验失败」、**没有**调用 `android_save_attachment` |
| 12 | 更新流：manifest.sha256 与下载字节**一致** | 正常走到 `android_save_attachment`（沿用现有用例 4 的 mock 方式）|

用例 11/12 需要自己算下载字节的 sha256（Node 22 有 `globalThis.crypto.subtle`，也可用 `node:crypto` 的 `createHash`）。

## 任务 4（P3）：CI 补齐全量前端 suite

**文件**：`.github/workflows/ci.yml`，`frontend` 作业

在现有步骤之后追加（保持现有顺序不动）：

```yaml
      - run: npm run test:timestamps
      - run: npm run test:font-scale
      - run: npm run test:worklog
      - run: npm run test:outbox
      - run: npm run test:attachment
      - run: npm run test:downloads
      - run: npm run test:downloads-view
      - run: npm run test:cors
      - run: npm run test:streaming
      - run: npm run test:updater
      - run: npm run test:updater-android
```

## 任务 5（可选，1 行）

`src/composables/useUpdater.ts:286` 的

```ts
const downloadUrl = ANDROID_APK_PROXY || currentUpdate.url || (currentUpdate.rawJson?.url as string)
```

后面两个分支是死代码（常量恒为真）。改成显式写法并加一行注释说明「Android 固定走代理，manifest.url 不参与下载」，不要改变行为。

## 不要做

- 不要动 `src/pages/**`、`components/**`、`backend/**`、`agent-node/**`、`src-tauri/**`
- 不要动 `dist-release/`、`.gitignore`、`package.json`
- 不要改 `ANDROID_FEED_URL` / `ANDROID_APK_PROXY` 的值
- 不要 commit / push / 切分支

## 验收（必须自己跑，回贴真实输出）

1. `npx vue-tsc --noEmit`
2. `npm run test:updater-android`（全部用例，含新增 8–12）
3. `npm run build`
4. 全量前端 suite（20 个 `test:*`）逐个跑，贴每个的 pass/fail；`test:updater-android` 这里必须全绿
5. `git status --short`：只应出现 `scripts/make-latest-json.mjs`、`src/composables/useUpdater.ts`、`tests/updater-android.test.mjs`、`.github/workflows/ci.yml`（外加未跟踪的 node_modules）

## 报告格式

1. 四项各自的 `文件:行号` + 改动摘要
2. 五条验收的真实输出（数字来自实际执行）
3. 若发现规格与代码冲突，先说明再按最接近原意实现
