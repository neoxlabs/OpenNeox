!ifndef NEOX_PROCESS_CHECK_INCLUDED
!define NEOX_PROCESS_CHECK_INCLUDED

# electron-builder inserts this in BOTH checkAppRunning and un.checkAppRunning.
# Keep the script embedded in each binary: no node_modules patches or installed helper.
!macro customCheckAppRunning
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=neox-process-check.ps1 "${BUILD_RESOURCES_DIR}\windows-process-check.ps1"
  # `.R1` = $R1. 2026-10-10: 原来写成 `.rR1`, System 插件不认, $R1 从没被写 —— 脚本收到的
  # InstallerProcessId 不是数字, 参数绑定失败 (日志都来不及写) → 3.10.4/3.10.5 静默升级一律退出码 2。
  System::Call 'kernel32::GetCurrentProcessId() i .R1'
  GetTempFileName $R2 "$TEMP"
  # Keep the atomically created file (no filename race or orphan placeholder).
  # It survives PLUGINSDIR cleanup so support can inspect failed updates.
  # 32-bit NSIS must prefer the native OS PowerShell, with a real 32-bit fallback.
  StrCpy $R3 "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R3 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"

  neox_process_retry:
    DetailPrint "Checking installation-directory processes; diagnostic log: $R2"
    # -File parameters are data, not executable PowerShell source. The final "."
    # prevents a trailing directory backslash from escaping the closing quote.
    nsExec::ExecToLog /TIMEOUT=120000 '"$R3" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\neox-process-check.ps1" -Mode Close -InstallDirectory "$INSTDIR\." -InstallerProcessId $R1 -UninstallerName "${UNINSTALL_FILENAME}" -LogPath "$R2"'
    Pop $R0
    StrCmp $R0 "0" neox_process_done
    DetailPrint "Process check failed (code=$R0). See $R2 for PID/path or query errors."
    # Fail closed on missing/blocked PowerShell as well as remaining processes.
    # Silent upgrades must return an error, not block on a hidden retry dialog.
    IfSilent neox_process_abort
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Neox 安装目录的进程检查或关闭失败（代码：$R0）。$\r$\n请查看日志中的进程 PID、路径或查询错误：$\r$\n$R2$\r$\n$\r$\n关闭相关程序或解决查询错误后重试；取消将停止安装，不会忽略检查。" IDRETRY neox_process_retry
  neox_process_abort:
    SetErrorLevel 2
    Quit
  neox_process_done:
    SetOutPath "$INSTDIR"
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
!macroend

# 旧版卸载器失败时不退出, 直接覆盖安装 (2026-10-10)。
#   3.10.4/3.10.5 的卸载器带着上面那个 `.rR1` bug, 进程检查必败 → 在删任何文件之前就退出非 0;
#   electron-builder 默认据此 SetErrorLevel 2 + Quit, 于是这两个版本永远升级不上来。
#   本安装器自己的 customCheckAppRunning 已经确认安装目录没有进程在跑, 覆盖是安全的。
!macro neoxTolerateOldUninstaller
  IfErrors 0 +3
    DetailPrint "Old uninstaller could not be launched; installing over the existing files."
    Goto +3
  StrCmp $R0 "0" +2
    DetailPrint "Old uninstaller exited with code $R0; installing over the existing files."
  ClearErrors
!macroend
!macro customUnInstallCheck
  !insertmacro neoxTolerateOldUninstaller
!macroend
!macro customUnInstallCheckCurrentUser
  !insertmacro neoxTolerateOldUninstaller
!macroend

; 装完刷新 Windows 图标缓存: 换标 (2026-10-16 n 结) 后覆盖升级, 桌面 / 开始菜单 / 任务栏快捷方式
; 仍会从 IconCache.db 读到旧图标, 直到重启资源管理器。SHCNE_ASSOCCHANGED 通知壳层重读, ie4uinit 再清一遍。
!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend

!endif
