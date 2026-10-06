#!/usr/bin/env bash
# Linux without glibc: installs the given package (or packs this checkout) in
# an Alpine container and checks that agent-guild refuses to start a manager,
# which would crash at its first session, and says what to do instead. Then
# runs the commands it prints, word for word, and the install smoke test.
# Needs Docker and network access. Packing bundles the installed
# node_modules, so a checkout needs npm ci first.
#
#   bash tests/package/musl.sh [package.tgz]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if (($#)); then
  cp "$1" "$work/package.tgz"
else
  (cd "$root" && npm pack --silent --pack-destination "$work" >/dev/null)
  mv "$work"/*.tgz "$work/package.tgz"
fi

docker run --rm -i -v "$work:/pkg:ro" -v "$here:/tests:ro" node:22-alpine sh -eu <<'STEPS'
fail() { echo "not ok  $1"; exit 1; }
npm install --global --no-fund --no-audit /pkg/package.tgz >/dev/null 2>&1
export AGENT_GUILD_HOME=/tmp/guild AGENT_GUILD_NO_UPDATE_CHECK=1 AGENT_GUILD_SKIP_SHELL_ENV=1 SHELL=/bin/sh

echo "=== agent-guild refuses to start a manager"
if out=$(agent-guild open --no-browser 2>&1); then fail "agent-guild started a manager: $out"; fi
echo "$out"
case $out in
  "agent-guild: Agent Guild's terminal library, node-pty, comes built for Linux with glibc 2.28 or later"*) ;;
  *) fail 'the message does not say why' ;;
esac
if echo "$out" | grep -q '^    at '; then fail 'a stack trace was printed'; fi
if [ -e "$AGENT_GUILD_HOME/manager.log" ]; then fail 'a manager was started'; fi

echo "=== the commands it prints build node-pty"
packages=$(echo "$out" | sed -n 's/.*(on Alpine: \(apk add [^)]*\)).*/\1/p')
build=$(echo "$out" | sed -n 's/^  \(cd .*\)$/\1/p')
if [ -z "$packages" ] || [ -z "$build" ]; then fail 'no commands to run'; fi
echo "\$ $packages"
sh -c "$packages" >/dev/null
echo "\$ $build"
sh -c "$build" >/tmp/build.log 2>&1 || { tail -n 40 /tmp/build.log; fail 'the build failed'; }

echo "=== the installed package runs terminals"
node /tests/smoke.mjs "$(npm prefix --global)"
STEPS
