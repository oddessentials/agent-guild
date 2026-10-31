; iscc /DVersion=<version> /DStage=<scripts/installers.mjs windows folder> /DOutput=<folder> [/DSign /Sagentguild=<sign command>] agent-guild.iss

[Setup]
AppId={{0903365D-E571-437D-A577-9CA14968997B}
AppName=Agent Guild
AppVersion={#Version}
AppPublisher=Odd Essentials
AppPublisherURL=https://oddessentials.ai
AppSupportURL=https://github.com/oddessentials/agent-guild/issues
DefaultDirName={autopf}\Agent Guild
PrivilegesRequired=lowest
DisableDirPage=yes
DisableProgramGroupPage=yes
SetupArchitecture=x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
ChangesEnvironment=yes
OutputDir={#Output}
OutputBaseFilename=agent-guild-windows-setup
SetupIconFile={#Stage}\agent-guild.ico
UninstallDisplayIcon={app}\agent-guild.ico
UninstallDisplayName=Agent Guild
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
#ifdef Sign
SignTool=agentguild
#endif

[Messages]
ConfirmUninstall=Are you sure you want to remove %1? Command-line tools installed into its folder are removed with it. Your Agent Guild data and settings are kept.

[Dirs]
Name: "{app}\launcher"

[InstallDelete]
Type: filesandordirs; Name: "{app}\node_modules\@oddessentials\agent-guild"
Type: filesandordirs; Name: "{app}\node_modules\npm"
Type: filesandordirs; Name: "{app}\node_modules\corepack"

[Files]
Source: "{#Stage}\app\*"; DestDir: "{app}"; Excludes: "\node.exe"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Stage}\node-x64\node.exe"; DestDir: "{app}"; Check: not IsArm64; Flags: ignoreversion
Source: "{#Stage}\node-arm64\node.exe"; DestDir: "{app}"; Check: IsArm64; Flags: ignoreversion
Source: "{#Stage}\agent-guild.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Agent Guild"; Filename: "{app}\agent-guild.cmd"; Parameters: "open"; IconFilename: "{app}\agent-guild.ico"; Flags: runminimized

[Run]
Filename: "{app}\node.exe"; Parameters: """{app}\node_modules\@oddessentials\agent-guild\src\manager\launchers.mjs"""; Flags: runhidden
Filename: "{app}\agent-guild.cmd"; Parameters: "open"; Description: "Open Agent Guild"; Flags: postinstall nowait skipifsilent runminimized

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function SamePath(const A, B: String): Boolean;
begin
  Result := CompareText(RemoveBackslashUnlessRoot(Trim(A)), RemoveBackslashUnlessRoot(Trim(B))) = 0;
end;

function PathEntries(const Path: String): TArrayOfString;
var
  Rest: String;
  I: Integer;
begin
  SetArrayLength(Result, 0);
  Rest := Path + ';';
  while Rest <> '' do
  begin
    I := Pos(';', Rest);
    if Trim(Copy(Rest, 1, I - 1)) <> '' then
    begin
      SetArrayLength(Result, GetArrayLength(Result) + 1);
      Result[GetArrayLength(Result) - 1] := Copy(Rest, 1, I - 1);
    end;
    Rest := Copy(Rest, I + 1, Length(Rest));
  end;
end;

function UserPath: String;
var
  Path: String;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Path) then
    Path := '';
  Result := Path;
end;

procedure SetUserPath(const Entries: TArrayOfString);
var
  Path: String;
  I: Integer;
begin
  Path := '';
  for I := 0 to GetArrayLength(Entries) - 1 do
  begin
    if Path <> '' then
      Path := Path + ';';
    Path := Path + Entries[I];
  end;
  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Path);
end;

procedure AddToPath(const Dir: String);
var
  Entries: TArrayOfString;
  I: Integer;
begin
  Entries := PathEntries(UserPath);
  for I := 0 to GetArrayLength(Entries) - 1 do
    if SamePath(Entries[I], Dir) then
      Exit;
  SetArrayLength(Entries, GetArrayLength(Entries) + 1);
  Entries[GetArrayLength(Entries) - 1] := Dir;
  SetUserPath(Entries);
end;

procedure RemoveFromPath(const Dir: String);
var
  Entries, Kept: TArrayOfString;
  I: Integer;
begin
  Entries := PathEntries(UserPath);
  SetArrayLength(Kept, 0);
  for I := 0 to GetArrayLength(Entries) - 1 do
    if not SamePath(Entries[I], Dir) then
    begin
      SetArrayLength(Kept, GetArrayLength(Kept) + 1);
      Kept[GetArrayLength(Kept) - 1] := Entries[I];
    end;
  if GetArrayLength(Kept) <> GetArrayLength(Entries) then
    SetUserPath(Kept);
end;

procedure StopManager;
var
  Node, Entry: String;
  Code: Integer;
begin
  Node := ExpandConstant('{app}\node.exe');
  Entry := ExpandConstant('{app}\node_modules\@oddessentials\agent-guild\bin\agent-guild.mjs');
  if FileExists(Node) and FileExists(Entry) then
    Exec(Node, AddQuotes(Entry) + ' stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopManager;
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddToPath(ExpandConstant('{app}\launcher'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    StopManager;
    RemoveFromPath(ExpandConstant('{app}\launcher'));
  end;
end;
