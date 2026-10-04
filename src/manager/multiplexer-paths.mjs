import path from 'node:path';
import { homeDir } from './install-channels.mjs';
import { expandWindowsVars } from './shell-env.mjs';

export function envValue(env, name) {
  return env[Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase())];
}

export function pathIdentity(file, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const value = p.normalize(file.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
  return platform === 'win32' ? value.toLowerCase() : value;
}

export function herdrLayout(env, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const home = homeDir(env, platform);
  if (platform !== 'win32') {
    const bin = p.join(home, '.local/bin');
    return { home, bin, launcher: p.join(bin, 'herdr'), remove: [p.join(bin, 'herdr')], links: [] };
  }
  const root = p.join(home, '.herdr');
  const standalone = p.join(root, 'packages/standalone');
  const bin = p.join(envValue(env, 'LOCALAPPDATA') || p.join(home, 'AppData/Local'), 'Programs/Herdr/bin');
  const current = p.join(standalone, 'current');
  const releases = p.join(standalone, 'releases');
  return {
    home: root, bin, current, releases, standalone, launcher: p.join(current, 'herdr.exe'),
    remove: [standalone], links: [bin],
    pathEntries: { exact: [bin, current], parent: releases },
  };
}

export function ownsPathEntry(entry, rules, env = {}) {
  const normalized = pathIdentity(expandWindowsVars(entry.trim().replace(/^"(.*)"$/, '$1'), env), 'win32');
  return rules.exact.some((p) => normalized === pathIdentity(p, 'win32'))
    || pathIdentity(path.win32.dirname(normalized), 'win32') === pathIdentity(rules.parent, 'win32');
}

/** Only herdr's versioned entries are replaced from the registry; other inherited PATH entries stay. */
export function reconcileHerdrPath(current, env) {
  const rules = herdrLayout(env, 'win32').pathEntries;
  return current.split(';').filter((entry) => !ownsPathEntry(entry, rules, env)).join(';');
}

// This same filter is tested against strings without changing the user's registry.
export const WINDOWS_PATH_FILTER = String.raw`
function Remove-OwnedPathEntries($PathValue, $Rules) {
  function Normalize-Entry([string]$Value) {
    $value = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"')).TrimEnd('\')
    try { [System.IO.Path]::GetFullPath($value).TrimEnd('\') } catch { $value }
  }
  $owned = @($Rules.exact | ForEach-Object { Normalize-Entry $_ })
  $ownedParent = Normalize-Entry $Rules.parent
  $kept = @($PathValue.Split(';') | Where-Object {
    $segment = Normalize-Entry $_
    try { $parent = [System.IO.Path]::GetDirectoryName($segment) } catch { $parent = $null }
    -not ($owned -icontains $segment) -and $parent -ine $ownedParent
  })
  return ($kept -join ';')
}
`;

export function windowsPathCleanupScript(rules) {
  const encoded = Buffer.from(JSON.stringify(rules)).toString('base64');
  return WINDOWS_PATH_FILTER + String.raw`
$ErrorActionPreference = 'Stop'
$rules = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('` + encoded + String.raw`')) | ConvertFrom-Json
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -ne $key) {
  try {
    $value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $value) {
      $kind = $key.GetValueKind('Path')
      $next = Remove-OwnedPathEntries $value $rules
      if ($next -cne $value) { $key.SetValue('Path', $next, $kind) }
    }
  } finally { $key.Dispose() }
}
`;
}
