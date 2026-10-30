#!/bin/sh
# Usage: ./install.sh [--uninstall]
set -eu
SHELL=${SHELL:-}

BEGIN='# >>> Agent Guild >>>'
END='# <<< Agent Guild <<<'
PACKAGE='lib/node_modules/@oddessentials/agent-guild'
src=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
dest="${XDG_DATA_HOME:-$HOME/.local/share}/agent-guild"

fail() { echo "$*" >&2; exit 1; }

zshrc() {
  if [ "${SHELL##*/}" = zsh ]; then zsh=$SHELL; else zsh=$(command -v zsh) || return 1; fi
  dir=$("$zsh" -c "printf %s \"\${ZDOTDIR:-\$HOME}\"" </dev/null) && [ -d "$dir" ] || return 1
  echo "$dir/.zshrc"
}

profile() {
  case "${SHELL##*/}" in
    zsh) zshrc || fail "$SHELL did not say which folder its .zshrc is in. Nothing was installed." ;;
    bash)
      for name in .bash_profile .bash_login; do
        if [ -e "$HOME/$name" ]; then echo "$HOME/$name"; return; fi
      done
      echo "$HOME/.profile" ;;
    ''|sh|dash|ksh) echo "$HOME/.profile" ;;
  esac
}

without_block() {
  [ -f "$1" ] || return 0
  awk -v b="$BEGIN" -v e="$END" '$0 == b { skip = 1; next } skip && $0 == e { skip = 0; next } !skip' "$1"
}

write_profile() {
  file=$1
  [ -L "$file" ] && file=$(readlink -f -- "$file")
  launcher=$(printf '%s' "$2" | sed 's/[\\"$`]/\\&/g')
  line="case \":\$PATH:\" in *\":$launcher:\"*) ;; *) export PATH=\"\$PATH\":\"$launcher\" ;; esac"
  kept=$(without_block "$file")
  rm -f -- "$file.agent-guild"
  if [ -f "$file" ]; then cp -p -- "$file" "$file.agent-guild"; fi
  {
    if [ -n "$kept" ]; then printf '%s\n\n' "$kept"; fi
    printf '%s\n%s\n%s\n' "$BEGIN" "$line" "$END"
  } > "$file.agent-guild"
  mv -- "$file.agent-guild" "$file"
}

remove_block() {
  zsh_file=''
  if [ "${SHELL##*/}" = zsh ] || command -v zsh >/dev/null 2>&1; then
    zsh_file=$(zshrc) || echo "zsh did not say which folder its .zshrc is in. Remove the Agent Guild block from that .zshrc yourself." >&2
  fi
  for file in "$zsh_file" "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    [ -n "$file" ] || continue
    [ -L "$file" ] && file=$(readlink -f -- "$file")
    if [ ! -f "$file" ] || ! grep -qxF "$BEGIN" "$file"; then continue; fi
    kept=$(without_block "$file")
    cp -p -- "$file" "$file.agent-guild"
    if [ -n "$kept" ]; then printf '%s\n' "$kept"; fi > "$file.agent-guild"
    mv -- "$file.agent-guild" "$file"
  done
}

carry() {
  [ -d "$1" ] || return 0
  for entry in "$1"/* "$1"/.[!.]*; do
    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi
    if [ ! -e "$2/${entry##*/}" ] && [ ! -L "$2/${entry##*/}" ]; then mv -- "$entry" "$2/${entry##*/}"; fi
  done
}

stop_running() {
  if [ -x "$dest/bin/node" ] && [ -f "$dest/$PACKAGE/bin/agent-guild.mjs" ]; then
    "$dest/bin/node" "$dest/$PACKAGE/bin/agent-guild.mjs" stop >/dev/null 2>&1 || true
  fi
}

if [ "${1:-}" = --uninstall ]; then
  [ -d "$dest" ] || fail "Agent Guild is not installed in $dest."
  stop_running
  tools=''
  for entry in "$dest"/launcher/*; do
    case ${entry##*/} in agent-guild|agent-guild-report|'*') ;; *) tools="$tools ${entry##*/}" ;; esac
  done
  rm -rf -- "$dest"
  remove_block
  echo "Agent Guild was removed from $dest. Your Agent Guild data and settings are kept."
  if [ -n "$tools" ]; then echo "These commands installed into its folder were removed with it:$tools"; fi
  exit 0
fi
[ $# -eq 0 ] || fail 'Usage: ./install.sh [--uninstall]'

[ -d "$src/agent-guild" ] || fail "There is no agent-guild folder beside $0."
"$src/agent-guild/bin/node" --version >/dev/null 2>&1 \
  || fail "This download's Node.js does not run on this computer. Download the one for $(uname -m) Linux; Alpine and other musl-based Linux are not supported."
version=$("$src/agent-guild/bin/node" -p 'require(process.argv[1]).version' "$src/agent-guild/$PACKAGE/package.json")
file=$(profile)
[ -n "$file" ] || fail "Your shell (${SHELL##*/}) is not one this installer can add Agent Guild to. Nothing was installed."

stop_running
mkdir -p -- "$(dirname -- "$dest")"
rm -rf -- "$dest.new" "$dest.old"
cp -RP -- "$src/agent-guild" "$dest.new"
cp -- "$0" "$dest.new/install.sh"
mkdir -- "$dest.new/launcher"
if [ -d "$dest" ]; then
  for dir in '' /bin /lib/node_modules; do carry "$dest$dir" "$dest.new$dir"; done
  for scope in "$dest"/lib/node_modules/@*; do
    if [ -d "$dest.new/lib/node_modules/${scope##*/}" ]; then carry "$scope" "$dest.new/lib/node_modules/${scope##*/}"; fi
  done
  mv -- "$dest" "$dest.old"
fi
mv -- "$dest.new" "$dest"
rm -rf -- "$dest.old"
"$dest/bin/node" "$dest/$PACKAGE/src/manager/launchers.mjs"
write_profile "$file" "$dest/launcher"

echo "Agent Guild $version is installed in $dest."
echo "New terminals find it after you sign in again. To open it now, run: \"$dest/launcher/agent-guild\""
echo "To uninstall it, run: \"$dest/install.sh\" --uninstall"
