#!/bin/sh
# Локальная репетиция release-job: тег ↔ версия, сборка пакета, SHA256SUMS,
# проверка содержимого архива. Ничего не публикует и не создаёт тег.
#
#   sh scripts/release-local.sh v0.1.1
set -eu

usage() {
  echo "использование: sh scripts/release-local.sh vX.Y.Z" >&2
  exit 2
}

test "$#" -eq 1 || usage
tag=$1
case "$tag" in
  v[0-9]*) ;;
  *) echo "тег должен начинаться с v: $tag" >&2; exit 1 ;;
esac

version=$(node -p "require('./package.json').version")
echo "тег=$tag версия=$version"
test "${tag#v}" = "$version"

npm ci --no-audit --no-fund
npm run build
test -f dist/cli.js

rm -f dist/osnova-fabrica-*.tgz dist/SHA256SUMS
npm pack --pack-destination dist
archive=$(find dist -maxdepth 1 -name 'osnova-fabrica-*.tgz' -print)
test -n "$archive"
test "$(printf '%s\n' "$archive" | wc -l)" -eq 1
mv "$archive" dist/osnova-fabrica.tgz
sha256sum dist/osnova-fabrica.tgz > dist/SHA256SUMS
test -s dist/SHA256SUMS

# В релиз не должен попасть ни один секрет. .env.example — документация, не секрет.
if tar -tzf dist/osnova-fabrica.tgz | grep -E '(^|/)(\.env|key\.openssh|.*\.ppk|id_rsa|id_ed25519)$'; then
  echo "в пакете найден секретный файл" >&2
  exit 1
fi
tar -tzf dist/osnova-fabrica.tgz | grep -qx 'package/dist/cli.js'

echo "пакет: dist/osnova-fabrica.tgz"
cat dist/SHA256SUMS
