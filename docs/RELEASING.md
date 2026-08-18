# 发版流程（Releasing）

## 一键发版

```bash
./scripts/release.sh patch    # 1.1.2 → 1.1.3
./scripts/release.sh minor    # 1.1.2 → 1.2.0
./scripts/release.sh major    # 1.1.2 → 2.0.0
./scripts/release.sh 1.5.0    # 指定版本号
```

脚本自动完成：工作树检查 → `npm run check`（类型检查 + 测试 + 构建）→ 改 `package.json` 版本号 → commit + tag + push → `gh release create` → `npm publish --access public`。

## 前置条件

- **gh 已登录**：`gh auth status` 显示 litwalle 账号即可。
- **npm 已登录**：`npm login --auth-type=legacy`（legacy 登录发布时才会弹 OTP 输入，浏览器登录不会）。
- 无交互 / CI 发布时改用带 Bypass 2FA 的 granular token：

```bash
NPM_TOKEN=npm_xxxx ./scripts/release.sh patch
```

## 手动步骤（与脚本等价）

1. 改 `package.json` 的 `version`
2. `npm run build`（`lib/` 产物需要同步提交）
3. `git commit` → `git tag vX.Y.Z` → `git push origin main --tags`
4. `gh release create vX.Y.Z`
5. `npm publish --access public`

## 踩过的坑（务必遵守）

- **必须用无 scope 包名 `dsh-cross-chat`**：`@dsh-external` scope 被 registry 封锁，任何账号在它下面发布都返回 404。
- **npm 已禁止新建 Classic token**（2025-11 起）；发布只用两种方式：① 终端 legacy 登录 + 输入 OTP；② Granular token（All Packages + Read and write + 勾 Bypass 2FA）。
- **已发布的版本不可覆盖**：README/文档改动也必须发新版本号才会反映到 npm 页面。
- **补救窗口**：发布后 72 小时内可 `npm unpublish`（之后只能 deprecate）。
- **tag 与 npm 版本保持一致**：脚本已自动保证，手动操作时注意 `vX.Y.Z` 与 `package.json` 的 `X.Y.Z` 对应。
