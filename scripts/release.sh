#!/usr/bin/env bash
# scripts/release.sh — dsh-cross-chat 一键发版
# ---------------------------------------------------------------------------
# 用法:
#   ./scripts/release.sh patch          # 1.1.2 → 1.1.3
#   ./scripts/release.sh minor          # 1.1.2 → 1.2.0
#   ./scripts/release.sh major          # 1.1.2 → 2.0.0
#   ./scripts/release.sh 1.5.0          # 指定版本号
#
# 流程: 工作树检查 → npm run check(类型检查+测试+构建) → 改版本号
#       → commit + tag + push → gh release → npm publish
#
# 环境变量:
#   NPM_TOKEN  可选。带 Bypass 2FA 的 granular token，用于无交互发布
#              （CI 或自动发版场景）；不设则 npm publish 走本地登录会话，
#              发布时可能需要输入 OTP。
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION_INPUT="${1:-patch}"

# 1. 工作树必须干净
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作树不干净，请先提交或还原改动："
  git status --short
  exit 1
fi

# 2. 质量门禁：类型检查 + 测试 + 构建（构建产物 lib/ 会一并提交）
echo "▶ npm run check"
npm run check

# 3. 计算新版本号
CURRENT="$(node -p "require('./package.json').version")"
if [[ "$VERSION_INPUT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEXT="$VERSION_INPUT"
else
  case "$VERSION_INPUT" in
    patch|minor|major)
      NEXT="$(node -e "
        const [maj, min, pat] = require('./package.json').version.split('.').map(Number)
        const bump = '$VERSION_INPUT'
        const v = bump === 'major' ? [maj + 1, 0, 0] : bump === 'minor' ? [maj, min + 1, 0] : [maj, min, pat + 1]
        console.log(v.join('.'))
      ")"
      ;;
    *)
      echo "✗ 用法: ./scripts/release.sh <patch|minor|major|X.Y.Z>"
      exit 1
      ;;
  esac
fi
echo "▶ $CURRENT → $NEXT"

node -e "
  const fs = require('fs')
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  pkg.version = '$NEXT'
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
"

# 4. commit + tag + push
git add package.json lib
git commit -m "chore: release v$NEXT"
git tag "v$NEXT"
git push origin main --tags

# 5. GitHub Release（Release Notes 自动从提交记录生成）
gh release create "v$NEXT" --title "v$NEXT" --generate-notes

# 6. npm publish
if [ -n "${NPM_TOKEN:-}" ]; then
  env "npm_config_//registry.npmjs.org/:_authToken=$NPM_TOKEN" npm publish --access public
else
  npm publish --access public
fi

echo "✓ v$NEXT 发布完成：npm registry + GitHub Release"
