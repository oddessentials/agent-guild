$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class GuildFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);

  public static string Pick(string start, string title) {
    var dialog = (IFileDialog)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | 0x20 | 0x40 | 0x800);
    dialog.SetTitle(title);
    if (!string.IsNullOrEmpty(start)) {
      try {
        IShellItem folder;
        Guid iid = typeof(IShellItem).GUID;
        SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
        dialog.SetFolder(folder);
      } catch {}
    }
    // A dialog from a background process opens behind the browser. An invisible owner that takes
    // the foreground brings it to the front, just inside the window that asked.
    using (var owner = new Form { TopMost = true, ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None, Opacity = 0, StartPosition = FormStartPosition.Manual }) {
      IntPtr asking = GetForegroundWindow();
      RECT r;
      if (GetWindowRect(asking, out r)) owner.SetBounds(r.L + 48, r.T + 48, 1, 1);
      else owner.StartPosition = FormStartPosition.CenterScreen;
      owner.Show();
      uint front = GetWindowThreadProcessId(asking, IntPtr.Zero), self = GetCurrentThreadId();
      AttachThreadInput(self, front, true);
      SetForegroundWindow(owner.Handle);
      AttachThreadInput(self, front, false);
      if (dialog.Show(owner.Handle) != 0) return null;
    }
    IShellItem picked;
    dialog.GetResult(out picked);
    string path;
    picked.GetDisplayName(0x80058000, out path);
    return path;
  }
}
'@
$picked = [GuildFolderPicker]::Pick($env:AGENT_GUILD_PICK_START, $env:AGENT_GUILD_PICK_TITLE)
if ($picked) { [Console]::Out.Write($picked) }
