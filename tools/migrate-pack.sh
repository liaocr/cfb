#!/usr/bin/env bash
# tools/migrate-pack.sh —— 生成「整机可搬」的迁移压缩包（默认**不含**密钥）
#
# 用法：
#   bash tools/migrate-pack.sh                 # 输出到 /home/user
#   bash tools/migrate-pack.sh /tmp            # 输出到指定目录
#   bash tools/migrate-pack.sh --with-secrets  # 额外生成独立的密钥包（默认不生成）
#
# 产出：
#   cfb-migration-YYYYMMDD.tar.gz  仓库（含 .git 全部历史）+ 仓库外实验数据
#   cfb-secrets-YYYYMMDD.tar.gz    仅 --with-secrets 时生成；含 .secrets/keys.env，保管好
#
# 设计：白名单式排除（缓存 / node_modules / 日志 / 本脚本自己的产物），其余全打包 ⇒ 不会漏东西。
set -euo pipefail

ROOT="${HOME:-/home/user}"
[ -d "$ROOT/cfb" ] || { echo "找不到仓库 $ROOT/cfb" >&2; exit 1; }

OUT="$ROOT"
WITH_SECRETS=0
for a in "$@"; do
  case "$a" in
    --with-secrets) WITH_SECRETS=1 ;;
    *) OUT="$a" ;;
  esac
done
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d)"
NAME="cfb-migration-$STAMP.tar.gz"

# 仓库外的顶层条目（白名单式：只排除缓存 / 密钥 / 本脚本产物）
mapfile -t EXTRAS < <(find "$ROOT" -maxdepth 1 -mindepth 1 \
  ! -name cfb ! -name .secrets ! -name .cache ! -name .local ! -name .npm ! -name .arena \
  ! -name 'cfb-migration-*' ! -name 'cfb-secrets-*' ! -name '.*history' \
  -printf '%f\n' | sort)

echo "== 打包 =="
echo "仓库：$ROOT/cfb（含 .git 历史）"
echo "仓库外条目：${#EXTRAS[@]} 个：${EXTRAS[*]:-（无）}"
echo "输出：$OUT/$NAME"

tar -czf "$OUT/$NAME" -C "$ROOT" \
  --exclude='node_modules' --exclude='*.log' --exclude='.nyc_output' --exclude='coverage' \
  cfb "${EXTRAS[@]}"

echo
echo "== 校验 =="
echo "文件数：$(tar -tzf "$OUT/$NAME" | wc -l)"
echo "大小：  $(du -h "$OUT/$NAME" | cut -f1)"
echo "sha256：$(sha256sum "$OUT/$NAME" | cut -d' ' -f1)"
echo "$(sha256sum "$OUT/$NAME" | cut -d' ' -f1)  $NAME" > "$OUT/$NAME.sha256"

if [ "$WITH_SECRETS" = "1" ] && [ -f "$ROOT/.secrets/keys.env" ]; then
  SNAME="cfb-secrets-$STAMP.tar.gz"
  tar -czf "$OUT/$SNAME" -C "$ROOT" .secrets
  chmod 600 "$OUT/$SNAME"
  echo
  echo "== 密钥包（务必单独保管，不要放进任何仓库）=="
  echo "$OUT/$SNAME  sha256: $(sha256sum "$OUT/$SNAME" | cut -d' ' -f1)"
else
  echo
  echo "提示：密钥未打包（默认）。需要时用 --with-secrets，或手动复制 ~/.secrets/keys.env（chmod 600）。"
fi

cat <<'EOF'

== 新机上恢复 ==
  tar -xzf cfb-migration-*.tar.gz -C /home/user
  cd /home/user/cfb
  git status -sb && node manifest.mjs && node verify.mjs
  # 恢复密钥（手动，或从 cfb-secrets-*.tar.gz 解出）：~/.secrets/keys.env（chmod 600）
  # 把 transfer/NEXT-MODEL-PROMPT.md 整份粘给新模型
EOF
