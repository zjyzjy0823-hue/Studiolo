# 规格：修复 `test:local-time` 用例 13（确认框引入后的测试适配）

> 背景：`2ac88c7` 给「恢复默认设置」加了二次确认（`confirmAction`），`SettingsPage.resetSettings()` 变成异步且需用户确认。CI `frontend` 作业因此红了：`test:local-time` 用例 13 断言 `writes.length === 2`，实际是 1 —— 测试直接调 `state.resetSettings()`，没人点确认，Promise 永远 pending，重置没有发生。
>
> 这是**测试需要适配新行为**，不是回退功能。**只改测试文件，不要动 `src/pages/SettingsPage.vue`。**

## 唯一文件

`tests/local-time.test.mjs`

## 现状（先读代码确认，行号以你读到的为准）

`inspectPage()` 在 bundle 字符串里构造 SettingsPage 并直接触发写入：

```js
store.update = async (_token, payload) => writes.push(payload)
...
await state.updateProfile({ ...state.profile.value, language: 'en-US' })
state.resetSettings()          // ← 这里现在会卡在 confirmAction
app.unmount()
return { timezone, writes }
```

用例 13 断言：

```js
assert.equal(result.writes.length, 2)   // profile 一次 + reset 一次
```

## 要求

1. 在 bundle 字符串的 import 区加入同一模块的确认解析函数（保证与 SettingsPage 用的是同一个 module 实例）：
   ```js
   import { resolveConfirmation } from './src/composables/useConfirm.ts'
   ```
2. `inspectPage()` 里把重置拆成两段，覆盖「取消」和「确认」：
   ```js
   await state.updateProfile({ ...state.profile.value, language: 'en-US' })

   // 取消：不应产生任何写入
   const cancelled = state.resetSettings()
   resolveConfirmation(false)
   await cancelled
   const afterCancel = writes.length

   // 确认：应产生一次写入
   const confirmed = state.resetSettings()
   resolveConfirmation(true)
   await confirmed
   ```
   > `resetSettings()` 内部同步调用 `confirmAction()`，所以「先调 reset、紧接着 resolveConfirmation」是安全的；不要加 `setTimeout`/`await Promise.resolve()` 之类的等待。
3. 返回值改成 `{ timezone, writes, afterCancel }`。
4. 用例 13 的断言改为（保持原有意图不变，只补确认语义）：
   - `result.timezone === 'Pacific/Auckland'`
   - `result.writes[0].language === 'en-US'`
   - `result.afterCancel === 1`（取消后没有新增写入；1 来自 updateProfile）
   - `result.writes.length === 2`（确认后新增一次重置写入）
   - 两个写入都不含 `timezone` / `deploymentTimezone`
5. 不要删改其它用例，不要改测试标题以外的东西（标题可保持原样）。

## 验收（自己跑，回贴真实输出）

1. `npm run test:local-time` —— 必须 13/13 全绿
2. 依次跑完所有前端测试脚本，把每个脚本的 pass/fail 贴回来：
   `npm run test:timestamps`、`test:font-scale`、`test:worklog`、`test:automation`、`test:outbox`、`test:local-time`、`test:core-sync`、`test:fleet`、`test:space-crypto`、`test:theme-engine`、`test:scheduler`、`test:desktop`、`test:data-bounded-reads`、`test:attachment`、`test:downloads`、`test:downloads-view`、`test:cors`、`test:streaming`、`test:updater`、`test:updater-android`
   - 已知既有失败：`test:updater-android` 用例 7（`make-latest-json` 结构）在 main 基线上同样失败，**不算你引入的**，如实报告即可
   - 若出现其它失败，先判断是不是你的改动引起，再修
3. `git status --short`：只应出现 `tests/local-time.test.mjs`（外加未跟踪的 node_modules）

## 不要做

- 不要改 `src/pages/SettingsPage.vue`（确认框是需求，不是 bug）
- 不要改其它测试文件
- 不要 commit / push
