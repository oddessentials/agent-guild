#!/bin/bash
# Usage: installers/macos/build.sh <version> <folder holding agent-guild-<version>-macos-<arch>> <output folder>
# Takes APPLE_DEVELOPER_ID_APPLICATION_P12, APPLE_DEVELOPER_ID_INSTALLER_P12, APPLE_P12_PASSWORD,
# APPLE_NOTARY_KEY_P8, ASC_KEY_ID and ASC_ISSUER_ID from the environment.
set -euo pipefail
version=$1 stage=$2 out=$3
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
kc="$work/signing.keychain-db"
trap 'security delete-keychain "$kc" 2>/dev/null || true; rm -rf "$work"' EXIT
fail() { echo "$*" >&2; exit 1; }

kcpw=$(openssl rand -hex 24)
security create-keychain -p "$kcpw" "$kc"
security set-keychain-settings -lut 21600 "$kc"
security unlock-keychain -p "$kcpw" "$kc"
for name in APPLICATION INSTALLER; do
  var="APPLE_DEVELOPER_ID_${name}_P12"
  (umask 077 && printf '%s' "${!var}" | base64 --decode > "$work/$name.p12")
  security import "$work/$name.p12" -k "$kc" -f pkcs12 -P "$APPLE_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/productbuild > /dev/null
  rm -f "$work/$name.p12"
done
security set-key-partition-list -S apple-tool:,apple: -s -k "$kcpw" "$kc" > /dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
app=$(security find-identity -v -p codesigning "$kc" | sed -n 's/.*"\(Developer ID Application: .*\)"$/\1/p' | head -n 1)
inst=$(security find-identity -v "$kc" | sed -n 's/.*"\(Developer ID Installer: .*\)"$/\1/p' | head -n 1)
[ -n "$app" ] && [ -n "$inst" ] || fail 'The Developer ID Application and Installer identities did not import.'

key="$work/AuthKey_$ASC_KEY_ID.p8"
(umask 077 && printf '%s\n' "$APPLE_NOTARY_KEY_P8" > "$key")
notary=(--key "$key" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID")

mkdir -p "$out" "$work/scripts"
cp "$here/postinstall" "$work/scripts/postinstall"
chmod 755 "$work/scripts/postinstall"
for arch in arm64 x64; do
  top="$stage/agent-guild-$version-macos-$arch"
  node="$top/agent-guild/bin/node"
  host=$([ "$arch" = x64 ] && echo x86_64 || echo arm64)
  [ -x "$node" ] || fail "There is no Node.js at $node."

  find "$top" -type f ! -path "$node" -print0 | while IFS= read -r -d '' file; do
    if file -b "$file" | grep -q '^Mach-O'; then
      codesign --force --timestamp --options runtime --keychain "$kc" -s "$app" "$file"
    fi
  done
  codesign -d --entitlements - --xml "$node" > "$work/entitlements.plist"
  /usr/libexec/PlistBuddy -c 'Delete :com.apple.security.get-task-allow' "$work/entitlements.plist" 2> /dev/null || true
  codesign --force --timestamp --options runtime --entitlements "$work/entitlements.plist" --keychain "$kc" -s "$app" "$node"
  codesign --verify --strict "$node"
  if codesign -d --entitlements - --xml "$node" 2> /dev/null | grep -q get-task-allow; then fail "$node still asks for get-task-allow."; fi

  pkgbuild --quiet --root "$top" --identifier ai.oddessentials.agent-guild --version "$version" \
    --install-location /.local/share/agent-guild-setup --scripts "$work/scripts" "$work/agent-guild.pkg"
  sed -e "s/@ARCH@/$host/" -e "s/@VERSION@/$version/" "$here/distribution.xml" > "$work/distribution.xml"
  pkg="$out/agent-guild-macos-$arch.pkg"
  productbuild --quiet --distribution "$work/distribution.xml" --package-path "$work" --sign "$inst" --keychain "$kc" --timestamp "$pkg"
  rm -f "$work/agent-guild.pkg"

  result=$(xcrun notarytool submit "$pkg" "${notary[@]}" --wait --timeout 3h --output-format json)
  status=$(plutil -extract status raw -o - - <<< "$result")
  if [ "$status" != Accepted ]; then
    xcrun notarytool log "$(plutil -extract id raw -o - - <<< "$result")" "${notary[@]}" >&2 || true
    fail "Apple's notary service answered $status for $pkg."
  fi
  xcrun stapler staple "$pkg"
  xcrun stapler validate "$pkg"
  pkgutil --check-signature "$pkg" | grep -qF "$inst" || fail "$pkg is not signed by $inst."
  spctl --assess --type install -vv "$pkg" 2>&1 | grep -q 'source=Notarized Developer ID' || fail "Gatekeeper does not accept $pkg as notarized."
done
