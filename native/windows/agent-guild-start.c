// agent-guild-start <program> [arguments...]
// Starts <program> detached, with this process's environment and working folder but none of its handles, prints
// its pid and exits. Node.js's spawn always lets a child inherit every inheritable handle, so a manager it started
// kept a pipe of whoever ran the launcher open for as long as it ran.
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

// Appends arg quoted so that CommandLineToArgvW and the C runtime read it back unchanged.
static wchar_t *append_quoted(wchar_t *out, const wchar_t *arg) {
  *out++ = L'"';
  for (const wchar_t *p = arg;; p++) {
    size_t slashes = 0;
    while (*p == L'\\') { p++; slashes++; }
    if (*p == L'\0') {
      for (size_t i = 0; i < slashes * 2; i++) *out++ = L'\\';
      break;
    }
    if (*p == L'"') {
      for (size_t i = 0; i < slashes * 2 + 1; i++) *out++ = L'\\';
    } else {
      for (size_t i = 0; i < slashes; i++) *out++ = L'\\';
    }
    *out++ = *p;
  }
  *out++ = L'"';
  return out;
}

int wmain(int argc, wchar_t **argv) {
  if (argc < 2) {
    fwprintf(stderr, L"Usage: agent-guild-start <program> [arguments...]\n");
    return 2;
  }
  size_t size = 1;
  for (int i = 1; i < argc; i++) size += wcslen(argv[i]) * 2 + 3;
  wchar_t *line = calloc(size, sizeof(wchar_t));
  if (!line) return 1;
  wchar_t *end = line;
  for (int i = 1; i < argc; i++) {
    if (i > 1) *end++ = L' ';
    end = append_quoted(end, argv[i]);
  }
  *end = L'\0';

  STARTUPINFOW startup = { sizeof startup };
  PROCESS_INFORMATION started;
  if (!CreateProcessW(argv[1], line, NULL, NULL, FALSE,
      DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, NULL, NULL, &startup, &started)) {
    fwprintf(stderr, L"agent-guild-start: could not start %ls (Windows error %lu)\n", argv[1], GetLastError());
    return 1;
  }
  CloseHandle(started.hThread);
  CloseHandle(started.hProcess);
  wprintf(L"%lu\n", started.dwProcessId);
  return 0;
}
