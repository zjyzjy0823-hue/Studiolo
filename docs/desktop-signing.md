# 桌面端代码签名（macOS）

## 为什么要有这个东西

`Studiolo WebCrypto Master Key` 存在登录钥匙串里，它的 ACL 按**签名身份**授权，
不是按文件路径。Tauri 默认的临时签名（ad-hoc）每次编译都会生成新的代码哈希，
系统就认为「换了一个程序」，于是**每次重新安装都要手动点一次「始终允许」**。

固定身份签名后：只要证书不变，任何重新编译的产物都被同一个 ACL 认可 —— 只授权一次。

## 现有配置（一次性做完的）

| 项 | 值 |
|---|---|
| 签名身份 | `Studiolo Dev` |
| 证书/私钥 | `~/.hermes/secrets/studiolo-signing.crt` / `.key`（10 年有效） |
| 专用钥匙串 | `~/Library/Keychains/studiolo-signing.keychain-db` |
| 钥匙串密码 | `~/.hermes/secrets/studiolo-signing.passphrase`（chmod 600） |
| 构建配置 | `src-tauri/tauri.conf.json` → `bundle.macOS.signingIdentity = "Studiolo Dev"` |

证书是自签的，所以系统仍显示「不能验证真实性」，但**不妨碍使用**，也仍然只需要授权一次。

## 日常构建

```bash
cd ~/Projects/Nexa-LumaDock
npx tauri build --bundles app          # 会自动用 Studiolo Dev 签名
rm -rf /Applications/Studiolo.app
ditto src-tauri/target/release/bundle/macos/Studiolo.app /Applications/Studiolo.app
xattr -dr com.apple.quarantine /Applications/Studiolo.app
open -a /Applications/Studiolo.app
```

首次在新身份下启动会弹一次钥匙串授权 → 点「始终允许」。之后不再弹。

## 换证书 / 重做（仅在证书损坏或过期时）

```bash
KC=~/Library/Keychains/studiolo-signing.keychain-db
D=~/.hermes/secrets
# 1. 新证书
openssl req -x509 -newkey rsa:2048 -keyout "$D/studiolo-signing.key" -out "$D/studiolo-signing.crt" \
  -days 3650 -nodes -subj "/CN=Studiolo Dev/O=isidel" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:false"
# 2. 导入（必须 -legacy，否则 macOS security 报 MAC verification failed）
openssl pkcs12 -export -legacy -out /tmp/t.p12 -inkey "$D/studiolo-signing.key" -in "$D/studiolo-signing.crt" -passout pass:testpass123
security unlock-keychain -p "$(cat "$D/studiolo-signing.passphrase")" "$KC"
security import /tmp/t.p12 -k "$KC" -P testpass123 -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$(cat "$D/studiolo-signing.passphrase")" "$KC"
security list-keychains -d user -s $(security list-keychains -d user | tr -d '"') "$KC"
rm -f /tmp/t.p12
# 3. 重新构建；这次会再要求一次钥匙串授权
```

## 排错

- `security import` 报 **MAC verification failed** → p12 不是 legacy 算法，加 `-legacy` 重导。
- `codesign: The specified item could not be found in the keychain` → 钥匙串路径写成了当前目录；
  正确路径是 `~/Library/Keychains/studiolo-signing.keychain-db`。
- `find-identity -v` 显示 0 valid → 自签证书本来就不在"可信"列表，属于正常；
  只要 `codesign -dv` 能看到 `Authority=Studiolo Dev` 就说明签名成功。
