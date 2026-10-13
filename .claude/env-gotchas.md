Node v24.14.0 の `node --test` は子プロセス生成で sandbox の `spawn EPERM` になることがある。個別テストは `node test/<name>.test.js` で直接実行する。
Git for Windows の bash.exe と tail.exe は sandbox で `CreateFileMapping` / Win32 error 5 になることがある。代わりに PowerShell を使う。
