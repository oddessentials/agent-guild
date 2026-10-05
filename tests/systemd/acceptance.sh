#!/usr/bin/env bash
# The Linux boot service against a real systemd: packs this checkout,
# installs it for a user in a container whose PID 1 is systemd, and runs
# steps.mjs around two reboots. Needs Docker with privileged containers.
#
#   bash tests/systemd/acceptance.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
name="agent-guild-systemd-$$"
image=agent-guild-systemd
work=$(mktemp -d)

diagnose() {
  echo "::group::service journal and manager log"
  as_guild journalctl --user -u agent-guild.service -n 80 --no-pager -o short-iso || true
  docker exec "$name" tail -n 80 /home/guild/.config/agent-guild/manager.log || true
  echo "::endgroup::"
}
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

booted() {
  local deadline=$((SECONDS + 90))
  until state=$(docker exec "$name" systemctl is-system-running 2>/dev/null) && [[ $state == running || $state == degraded ]]; do
    if ((SECONDS > deadline)); then echo "systemd did not finish booting (${state:-no answer})"; exit 1; fi
    sleep 1
  done
}
reboot() {
  docker restart "$name" >/dev/null
  booted
}
as_guild() {
  docker exec "$name" runuser -u guild -- env HOME=/home/guild PATH=/home/guild/.local/bin:/usr/local/bin:/usr/bin:/bin \
    XDG_RUNTIME_DIR="/run/user/$uid" NPM_CONFIG_UPDATE_NOTIFIER=false "$@"
}
phase() {
  echo "=== $1"
  if ! as_guild node /opt/accept/steps.mjs "$1"; then
    diagnose
    exit 1
  fi
}

docker build -q -t "$image" "$here" >/dev/null
tarball=$(cd "$root" && npm pack --silent --pack-destination "$work" | tail -n 1)
docker run -d --name "$name" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw "$image" >/dev/null
booted
uid=$(docker exec "$name" id -u guild)

# Outside /tmp, which systemd may empty at boot.
docker exec "$name" mkdir -p /opt/accept
docker cp "$work/$tarball" "$name:/opt/accept/package.tgz"
docker cp "$here/steps.mjs" "$name:/opt/accept/steps.mjs"
docker exec "$name" chmod -R a+rX /opt/accept
as_guild npm install --global --prefix /home/guild/.local /opt/accept/package.tgz --no-audit --no-fund --loglevel=error

# Stands in for signing in over SSH: a user manager without lingering.
docker exec "$name" systemctl start "user@$uid"
phase before-reboot

docker exec "$name" loginctl enable-linger guild
reboot
phase after-reboot

as_guild npm uninstall --global --prefix /home/guild/.local @oddessentials/agent-guild --loglevel=error
reboot
phase after-removal
echo "=== the boot service passed every step"
