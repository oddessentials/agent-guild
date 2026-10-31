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

const
  TH32CS_SNAPPROCESS = $2;
  PROCESS_QUERY_LIMITED_INFORMATION = $1000;
  ERROR_INVALID_PARAMETER = 87;
  ERROR_NO_MORE_FILES = 18;
  NODE_GONE = 0;
  NODE_RUNNING = 1;
  NODE_UNKNOWN = 2;

type
  { PROCESSENTRY32W as a 32-bit process, which Setup is, sees it: 556 bytes. }
  TProcessEntry = record
    dwSize, cntUsage, th32ProcessID, th32DefaultHeapID, th32ModuleID, cntThreads, th32ParentProcessID: DWORD;
    pcPriClassBase: Longint;
    dwFlags: DWORD;
    szExeFile: array [0..259] of Char;
  end;

function CreateToolhelp32Snapshot(Flags, ProcessId: DWORD): Longint; external 'CreateToolhelp32Snapshot@kernel32.dll stdcall';
function Process32FirstW(Snapshot: Longint; var Entry: TProcessEntry): BOOL; external 'Process32FirstW@kernel32.dll stdcall';
function Process32NextW(Snapshot: Longint; var Entry: TProcessEntry): BOOL; external 'Process32NextW@kernel32.dll stdcall';
function OpenProcess(Access: DWORD; Inherit: BOOL; ProcessId: DWORD): Longint; external 'OpenProcess@kernel32.dll stdcall';
function QueryFullProcessImageNameW(Process: Longint; Flags: DWORD; Name: String; var Size: DWORD): BOOL; external 'QueryFullProcessImageNameW@kernel32.dll stdcall';
function CloseHandle(Handle: Longint): BOOL; external 'CloseHandle@kernel32.dll stdcall';

function ExeName(const Entry: TProcessEntry): String;
var
  I: Integer;
begin
  Result := '';
  I := 0;
  while (I < 260) and (Entry.szExeFile[I] <> #0) do
  begin
    Result := Result + Entry.szExeFile[I];
    I := I + 1;
  end;
end;

{ Whether a process runs Node, the install's node.exe, by its full path; unknown when that cannot be established. }
function NodeState(const Node: String): Integer;
var
  Snapshot, Process: Longint;
  Entry: TProcessEntry;
  Path: String;
  Size: DWORD;
  More, Unknown: Boolean;
begin
  Result := NODE_UNKNOWN;
  Snapshot := CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if Snapshot = -1 then
    Exit;
  try
    Entry.dwSize := 556;
    More := Process32FirstW(Snapshot, Entry);
    if not More then
      Exit;
    Unknown := False;
    while More do
    begin
      if CompareText(ExeName(Entry), 'node.exe') = 0 then
      begin
        Process := OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, Entry.th32ProcessID);
        if Process = 0 then
        begin
          { A process that exited since the snapshot is gone; any other failure leaves it unknown. }
          if DLLGetLastError <> ERROR_INVALID_PARAMETER then
            Unknown := True;
        end
        else
          try
            Size := 1024;
            Path := StringOfChar(#0, Size);
            if not QueryFullProcessImageNameW(Process, 0, Path, Size) then
              Unknown := True
            else if SamePath(Copy(Path, 1, Size), Node) then
            begin
              Result := NODE_RUNNING;
              Exit;
            end;
          finally
            CloseHandle(Process);
          end;
      end;
      More := Process32NextW(Snapshot, Entry);
    end;
    if Unknown or (DLLGetLastError <> ERROR_NO_MORE_FILES) then
      Result := NODE_UNKNOWN
    else
      Result := NODE_GONE;
  finally
    CloseHandle(Snapshot);
  end;
end;

{ True only once no process runs this install's Node.js: the manager and everything it started have exited. }
function StopManager: Boolean;
var
  Node, Entry: String;
  Code, I: Integer;
begin
  Node := ExpandConstant('{app}\node.exe');
  Entry := ExpandConstant('{app}\node_modules\@oddessentials\agent-guild\bin\agent-guild.mjs');
  Result := not FileExists(Node);
  if Result then
    Exit;
  if FileExists(Entry) then
    Exec(Node, AddQuotes(Entry) + ' stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
  for I := 1 to 20 do
  begin
    Result := NodeState(Node) = NODE_GONE;
    if Result then
      Exit;
    Sleep(500);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if StopManager then
    Result := ''
  else
    Result := 'Agent Guild is still running, or Setup could not confirm that it stopped. Close it, then run Setup again.';
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
    if not StopManager then
    begin
      SuppressibleMsgBox('Agent Guild is still running, or Uninstall could not confirm that it stopped. Close it, then uninstall again.', mbError, MB_OK, IDOK);
      Abort;
    end;
    RemoveFromPath(ExpandConstant('{app}\launcher'));
  end;
end;
