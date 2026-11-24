# SPEC：大文件直传 VPS —— 后端切片（agent-node + Core）

## 背景

- 附件中继硬上限 32MB（`backend/app/fleet/media.py` 的 `MediaRelay.max_bytes`），超过必断，这是要解决的根因。
- 已有 `agent-node/agent_node/alist_publish.py`（已提交 396c636）：上传 AList → 两个 host 各拉 512KB 测速 → 选快的 → 产出 24h 签名链接。签名算法已验证与服务端一致。
- AList 侧就绪：`/dl` 存储（底层 `/opt/alist/data/dl`），guest 只读，两个入口：
  - `https://dl.isidel.com`（DNS 直连 VPS）
  - `https://alist.isidel.com`（经 Cloudflare）

## 目标

> 32MB 的 Hermes 附件不再走中继字节流，改为发布到 AList，把**带有效期的直链**交给客户端；≤ 32MB 保持现有路径完全不变。

## 一、agent-node

1. 配置（`~/.hermes/studiolo-node/config.json`）新增**可选** `alist` 段：
   ```json
   {"alist": {"baseUrl": "...", "token": "...", "mountPath": "/dl",
              "hosts": ["https://dl.isidel.com", "https://alist.isidel.com"],
              "ttlSeconds": 86400, "thresholdBytes": 33554432}}
   ```
   缺省：`ttlSeconds=86400`、`thresholdBytes=32MB`、`mountPath=/dl`。**没有 alist 段时行为与今天完全一致。**

2. 附件请求处理（`daemon.py` / `hermes_media.py` 里的附件解析分支）：
   - 先 stat 目标文件拿 size；
   - `size > thresholdBytes` 且配置了 alist → 调 `LinkPublisher.publish(path)`
   - 成功 → 解析结果标记为**外链**，携带 `{url, expiresAt, sizeBytes, fileName}`
   - 失败 → 记 warning 并回退到今天的中继路径（超限时仍然返回原错误码 `media_too_large`，不要吞掉）

3. 链接复用：同一 `(真实路径, mtime, size)` 在过期前只发布一次，进程内缓存即可（节点重启后重建）。

4. 安全：沿用 `open_session_file` 的 `allowedRoots` + `cwd` + 符号链接防护；发布前必须已经通过该函数的校验，不得绕过。

## 二、backend（Core）

1. `MediaRelay` 增加**外链型 transfer**：不接收任何字节，只保存 `{url, expiresAt, size, filename, content_type}`。
2. 下载端点遇到外链型 → 返回 **307 Temporary Redirect** 到该 URL，`Cache-Control: no-store`；把 Range 语义交给 AList（它支持 206）。
3. `accept_bytes` 遇到外链型必须拒绝（防止把两种语义混用）。
4. 审计事件新增一条 `media_external`，记录 host、size、expiresAt（不记录完整签名 URL，只记 host + path）。
5. 链接已过期 → 返回 410，不要 307。

## 三、测试（必须真跑并贴输出）

agent-node：
- 超过阈值 + 配置 alist → 走外链，不读文件字节
- 未配置 alist → 原路径
- publish 抛错 → 回退原路径
- 同一文件第二次请求 → 复用缓存（publisher 只被调一次）
- 阈值边界：等于阈值不算超限

backend：
- 外链 transfer → 307 + Location
- 过期 → 410
- accept_bytes 对外链型 → 拒绝
- 既有 25 项 media/relay 测试全绿

## 四、禁止

- 不改 `src/`（客户端下一轮单独做）
- 不改 `max_bytes` 的现有语义
- 不 commit、不 push、不重启服务
- 不为让测试变绿放宽断言

## 五、交付

改动文件与理由 / 真实测试输出 / “与 SPEC 不一致 / 没做到 / 有风险”
