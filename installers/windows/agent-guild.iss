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
; Setup never closes or restarts processes itself: StopManager below stops Agent Guild, and PrepareToInstall refuses
; while anything still runs from {app}.
CloseApplications=no
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
  INSTALL_GONE = 0;
  INSTALL_RUNNING = 1;
  INSTALL_UNKNOWN = 2;

type
  { PROCESSENTRY32W in 64-bit Setup (SetupArchitecture=x64). Pascal Script packs records, so Windows'
    alignment padding is written out: 568 bytes. }
  TProcessEntry = record
    dwSize, cntUsage, th32ProcessID, Padding1: DWORD;
    th32DefaultHeapID: Int64;
    th32ModuleID, cntThreads, th32ParentProcessID: DWORD;
    pcPriClassBase: Longint;
    dwFlags: DWORD;
    szExeFile: array [0..259] of Char;
    Padding2: DWORD;
  end;

function CreateToolhelp32Snapshot(Flags, ProcessId: DWORD): NativeInt; external 'CreateToolhelp32Snapshot@kernel32.dll stdcall';
function Process32FirstW(Snapshot: NativeInt; var Entry: TProcessEntry): BOOL; external 'Process32FirstW@kernel32.dll stdcall';
function Process32NextW(Snapshot: NativeInt; var Entry: TProcessEntry): BOOL; external 'Process32NextW@kernel32.dll stdcall';
function OpenProcess(Access: DWORD; Inherit: BOOL; ProcessId: DWORD): NativeInt; external 'OpenProcess@kernel32.dll stdcall';
function QueryFullProcessImageNameW(Process: NativeInt; Flags: DWORD; Name: String; var Size: DWORD): BOOL; external 'QueryFullProcessImageNameW@kernel32.dll stdcall';
function CloseHandle(Handle: NativeInt): BOOL; external 'CloseHandle@kernel32.dll stdcall';

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

procedure LogFailure(const Call: String; Error: Longint);
begin
  Log('Process check: ' + Call + ' failed, Windows error ' + IntToStr(Error));
end;

{ The programs Setup installs and replaces: Node.js, the launcher that starts the manager, and the console host
  node-pty runs for each terminal session. }
function OwnedProgram(const Name: String): Boolean;
begin
  Result := (CompareText(Name, 'node.exe') = 0) or (CompareText(Name, 'agent-guild-start.exe') = 0) or (CompareText(Name, 'OpenConsole.exe') = 0);
end;

{ Whether a process runs one of those programs from the install folder Dir, by its full image path; unknown when that
  cannot be established. Only processes with those names are opened, so the system's own processes, which refuse
  to be opened, are never mistaken for ours. }
function InstallState(const Dir: String): Integer;
var
  Snapshot, Process: NativeInt;
  Entry: TProcessEntry;
  Prefix, Path: String;
  Size: DWORD;
  Error: Longint;
  More, Unknown: Boolean;
begin
  Result := INSTALL_UNKNOWN;
  Unknown := False;
  Prefix := AddBackslash(Dir);
  Snapshot := CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if Snapshot = -1 then
  begin
    LogFailure('CreateToolhelp32Snapshot', DLLGetLastError);
    Log('Process check: unknown');
    Exit;
  end;
  try
    Entry.dwSize := 568;
    More := Process32FirstW(Snapshot, Entry);
    if not More then
    begin
      LogFailure('Process32FirstW', DLLGetLastError);
      Unknown := True;
    end;
    while More do
    begin
      if OwnedProgram(ExeName(Entry)) then
      begin
        Process := OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, Entry.th32ProcessID);
        if Process = 0 then
        begin
          Error := DLLGetLastError;
          { A process that exited since the snapshot is gone; any other failure leaves it unknown. }
          if Error <> ERROR_INVALID_PARAMETER then
          begin
            LogFailure('OpenProcess for process ' + IntToStr(Entry.th32ProcessID), Error);
            Unknown := True;
          end;
        end
        else
          try
            Size := 1024;
            Path := StringOfChar(#0, Size);
            if not QueryFullProcessImageNameW(Process, 0, Path, Size) then
            begin
              LogFailure('QueryFullProcessImageNameW for process ' + IntToStr(Entry.th32ProcessID), DLLGetLastError);
              Unknown := True;
            end
            else if CompareText(Copy(Path, 1, Length(Prefix)), Prefix) = 0 then
            begin
              Log('Process check: running, process ' + IntToStr(Entry.th32ProcessID) + ' is ' + Copy(Path, 1, Size));
              Result := INSTALL_RUNNING;
              Exit;
            end;
          finally
            CloseHandle(Process);
          end;
      end;
      More := Process32NextW(Snapshot, Entry);
      if not More then
      begin
        Error := DLLGetLastError;
        if Error <> ERROR_NO_MORE_FILES then
        begin
          LogFailure('Process32NextW', Error);
          Unknown := True;
        end;
      end;
    end;
    if Unknown then
    begin
      Log('Process check: unknown');
      Result := INSTALL_UNKNOWN;
    end
    else
    begin
      Log('Process check: gone');
      Result := INSTALL_GONE;
    end;
  finally
    CloseHandle(Snapshot);
  end;
end;

{ True only once nothing runs from this install: the manager, everything it started, its sessions' console hosts. }
function StopManager: Boolean;
var
  App, Node, Entry: String;
  Code, I: Integer;
begin
  App := ExpandConstant('{app}');
  Node := App + '\node.exe';
  Entry := App + '\node_modules\@oddessentials\agent-guild\bin\agent-guild.mjs';
  Result := not DirExists(App);
  if Result then
    Exit;
  if FileExists(Node) and FileExists(Entry) then
    Exec(Node, AddQuotes(Entry) + ' stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
  for I := 1 to 20 do
  begin
    Result := InstallState(App) = INSTALL_GONE;
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
