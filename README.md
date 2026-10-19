# Infra Desktop

> 0.2.0 起由 Radar Desktop 改名为 Infra Desktop（仓库 Norman-else/infra-desktop）。已安装的 Radar Desktop 会原地更新，设置会自动从 `Radar Desktop` 数据目录迁移过来，旧目录保留不动。

用桌面应用打开 [Radar](https://github.com/skyhook-io/radar)：选环境 → 输入 MFA → radar 页面直接显示在窗口里。不用再手动 `aws-vault exec … -- kubectl radar`。支持 Windows 和 macOS。

## 前提

本机需要已经装好并能在终端里正常使用：

- `aws-vault`（并且已 `aws-vault add <source_profile>` 存好 access key）
- `aws` CLI v2（EKS 的 kubeconfig 用 `aws eks get-token` 拿 token）
- radar（`kubectl-radar`，比如 `scoop install radar` / `brew install skyhook-io/tap/radar`）
- `~/.kube/config` 里有各环境的 EKS context

## 用法

```bash
npm install
npm start
```

## 安装包

| 平台 | 产物 | 在哪里构建 |
|---|---|---|
| Windows x64 | `release/Radar-Desktop-Setup-<版本>-x64.exe` | Windows 上运行 `npm run dist:win` |
| macOS Apple Silicon / Intel | `release/Radar-Desktop-<版本>-arm64.dmg` / `-x64.dmg` | Mac 上运行 `npm run dist:mac`，或用 GitHub Actions |

### 发布新版本

在 GitHub 的 **Actions → Release → Run workflow** 中选 `master` 分支和版本递增方式（patch / minor / major，或者直接填版本号）。workflow 会：

1. 修改 `package.json` 版本号，提交到 master 并打 `vX.Y.Z` tag
2. 在 macOS 和 Windows runner 上构建安装包
3. 发布 GitHub Release，附带 `.exe`、`.dmg`、`.zip` 和 `latest*.yml`

### 自动更新

已安装的应用启动 10 秒后会检查一次更新，之后每 30 分钟检查一次，窗口获得焦点时（距上次检查超过 10 分钟）也会检查；也可以在菜单「环境 → 检查更新」手动检查。新版本会在后台下载，下载完顶栏出现「新版本 · 重启更新」按钮，点了就会安装并重启。

- **Windows**：使用 electron-updater（NSIS）。
- **macOS**：应用只有 ad-hoc 签名，系统自带的更新机制不接受，所以应用会自己下载 `.zip`、校验 sha512，退出后替换 `/Applications/Infra Desktop.app` 再重新打开。

安装包没有用付费证书签名（mac 是 ad-hoc 签名），所以首次打开会被系统拦一下：

- **Windows**：SmartScreen 提示时点「更多信息 → 仍要运行」。
- **macOS**：把应用拖进「应用程序」后右键 → 打开；如果提示「已损坏」，在终端运行：

```bash
xattr -cr "/Applications/Infra Desktop.app"
```

## 使用

- 顶栏颜色就是当前环境（dev 绿 / sat 橙 / prod 红），显示集群名、集群连接状态和 AWS 凭证剩余时间。
- `Ctrl+Shift+E`（macOS `⇧⌘E`）或点「切换环境」打开环境列表，数字键 1-9 直接切换。（`Ctrl+K` 留给 radar 自己的搜索。）
- 顶栏有 **Radar | Vault** 切换（`Ctrl+Shift+R` / `Ctrl+Shift+V`，macOS 为 `⇧⌘R` / `⇧⌘V`）。同一个环境只输一次 MFA，两个工具共用凭证。
- 某个工具启动失败时只影响它自己：凭证保留，点 Retry 重新启动该工具，不用再输 MFA。
- 切换过的环境的 radar 会留在后台，切回来是秒开；不用的可以在列表里点「断开」。

## Vault

顶栏切到 **Vault** 就会在当前环境打开 [vault-mcp](https://github.com/Norman-else/vault-mcp) 的 Web UI，和 Radar 共用同一份 AWS 凭证：不用再输 MFA，不需要 Claude，也不会改你全局的 kubectl context。凭证续期后 Vault 会自动重新登录。

**需要什么**：装好 [uv](https://docs.astral.sh/uv/) 就行。桌面总是用 `uvx` 运行 vault-mcp 的 **GitHub Release**，从不使用本地 clone 的代码：

- 默认用最新的 Release（每 4 小时检查一次）。新版本先验证能用（`vault-mcp-web-ui --version`）再切换，不能用就继续用上一个能用的版本；正在使用的 Vault 不会被中途重启，新版本在下次启动该环境的 Vault 时生效。
- 第一次运行某个版本时会下载，需要一两分钟。
- 所以改了 vault-mcp 之后，要在 vault-mcp 仓库发布 Release（Actions → Release），桌面才会用上。

**第一次用某个环境的 Vault**：桌面按这个顺序找 Vault 的 Address、Header（`X-Vault-AWS-IAM-Server-ID`）和 Role：

1. 桌面自己的设置文件 `envs.<profile>.vault`；
2. `~/.claude.json` 里 `vault` MCP server 的 `VAULT_ADDR_<ENV>` / `VAULT_HEADER_<ENV>` / `VAULT_ROLE_<ENV>` / `AWS_REGION_<ENV>`（只读这几项）；
3. 集群自动识别：用该环境的凭证跑 kubectl，读 bank-vaults 的 `Vault` 资源（AWS auth 的 `iam_server_id_header_value`，以及绑定到 profile `role_arn` 的角色）和指向 Vault Service 的 Ingress（地址用 `https://<host>`）。找到后写进设置文件，下次不再查；
4. 都没有时，页面上出现一个小表单手动填写。

相关设置：

| 键 | 说明 |
|---|---|
| `vaultMcpRef` | 固定 vault-mcp 版本（Release tag 或 commit），设置后不再自动跟随最新 Release |
| `envs.<profile>.vault` | `{ "addr", "header", "role", "env", "port" }`，覆盖自动读取的值 |

Vault 端口默认是 radar 端口 + 10：dev 9291、sat 9292、prod 9293。

## 工作方式

1. **环境发现**：读取 `~/.aws/config` 里带 `role_arn` 的 profile，按 role 的 AWS 账号匹配 kubeconfig 里同账号的 EKS context。
2. **凭证**：运行 `aws-vault export --format=json <profile>`。aws-vault 有缓存会话就直接成功；需要 MFA 时应用弹窗收验证码，再用 `--mfa-token` 重跑。同一个 source profile 的 MFA 会话对 dev/sat/prod 通用，所以一般只输一次。
3. **radar**：每个环境启动一个 `kubectl-radar -no-browser -port <随机> -kubeconfig <只含该环境 context 的临时文件>`。radar 内只能看到这一个集群，不会切到凭证不匹配的集群。
4. **凭证续期**：radar 通过应用内置的本地 ECS 凭证端点（`AWS_CONTAINER_CREDENTIALS_FULL_URI`）拿凭证。过期前 5 分钟应用会静默续期，不用重启 radar；如果 aws-vault 会话也过期了，顶栏会提示输入 MFA 续期。
5. radar 子进程的 AWS 配置与 `~/.aws` 隔离，`[default]` key 或 `AWS_PROFILE` 不会抢先生效。

## 设置

菜单「环境 → 打开设置文件」（`settings.json`，在应用数据目录）：

```jsonc
{
  "awsVaultPath": "",        // 默认从 PATH 找
  "radarPath": "",           // 默认找 kubectl-radar / radar
  "kubeconfig": "",          // 默认 $KUBECONFIG 或 ~/.kube/config
  "duration": "",            // 传给 aws-vault --duration；要和终端里用的一致（例如 "8h"），才能复用已缓存的会话
  "radarArgs": [],           // 额外的 radar 参数
  "envs": {
    "prod": { "label": "PROD", "color": "#c62828", "context": "acme-prod", "hidden": false, "port": 9283 }
  }
}
```

改完点「重新加载配置」。

每个环境的 radar 固定端口：默认按列表顺序 dev 9281、sat 9282、prod 9283（9280 留给终端里直接运行的 radar），可用 `envs.<profile>.port` 修改。radar 的 MCP 在同一端口的 `/mcp`，例如 `http://127.0.0.1:9281/mcp`；⚙ 菜单里列出了运行中环境的 MCP 地址，点击即可复制。

- aws-vault 用 `file` backend 时，应用会弹窗要密码，密码只保存在本次运行的内存里。
- macOS 上应用会从登录 shell 读取 `PATH`、`KUBECONFIG`、`AWS_VAULT_*` 这些变量，所以 `~/.zshrc` 里的设置也会生效。

## 开发

```bash
npm test
```

```bash
npm run typecheck
```

`test/fake-aws-vault` 是一个假的 aws-vault（`go build` 后使用），可以在没有真实 AWS key 的机器上走完整流程。先在 `settings.json` 里把 `awsVaultPath` 指向它；需要 MFA 时输入 `000000` 会被拒绝，其他 6 位数字会被接受。用 `INFRA_DESKTOP_DATA_DIR=<目录>` 可以让测试运行使用独立的设置目录。
