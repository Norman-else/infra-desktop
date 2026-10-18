# Radar Desktop

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

已安装的应用启动 10 秒后会检查一次更新，之后每 4 小时检查一次；也可以在菜单「环境 → 检查更新」手动检查。新版本会在后台下载，下载完顶栏出现「新版本 · 重启更新」按钮，点了就会安装并重启。

- **Windows**：使用 electron-updater（NSIS）。
- **macOS**：应用只有 ad-hoc 签名，系统自带的更新机制不接受，所以应用会自己下载 `.zip`、校验 sha512，退出后替换 `/Applications/Radar Desktop.app` 再重新打开。

安装包没有用付费证书签名（mac 是 ad-hoc 签名），所以首次打开会被系统拦一下：

- **Windows**：SmartScreen 提示时点「更多信息 → 仍要运行」。
- **macOS**：把应用拖进「应用程序」后右键 → 打开；如果提示「已损坏」，在终端运行：

```bash
xattr -cr "/Applications/Radar Desktop.app"
```

## 使用

- 顶栏颜色就是当前环境（dev 绿 / sat 橙 / prod 红），显示集群名、集群连接状态和 AWS 凭证剩余时间。
- `Ctrl+Shift+E`（macOS `⇧⌘E`）或点「切换环境」打开环境列表，数字键 1-9 直接切换。（`Ctrl+K` 留给 radar 自己的搜索。）
- 切换过的环境的 radar 会留在后台，切回来是秒开；不用的可以在列表里点「断开」。

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
  "duration": "",            // 传给 aws-vault --duration，例如 "1h"
  "radarArgs": [],           // 额外的 radar 参数
  "envs": {
    "prod": { "label": "PROD", "color": "#c62828", "context": "acme-prod", "hidden": false }
  }
}
```

改完点「重新加载配置」。

- aws-vault 用 `file` backend 时，应用会弹窗要密码，密码只保存在本次运行的内存里。
- macOS 上应用会从登录 shell 读取 `PATH`、`KUBECONFIG`、`AWS_VAULT_*` 这些变量，所以 `~/.zshrc` 里的设置也会生效。

## 开发

```bash
npm test
```

```bash
npm run typecheck
```

`test/fake-aws-vault` 是一个假的 aws-vault（`go build` 后使用），可以在没有真实 AWS key 的机器上走完整流程。先在 `settings.json` 里把 `awsVaultPath` 指向它；需要 MFA 时输入 `000000` 会被拒绝，其他 6 位数字会被接受。用 `RADAR_DESKTOP_DATA_DIR=<目录>` 可以让测试运行使用独立的设置目录。
