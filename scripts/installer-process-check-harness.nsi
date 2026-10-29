Unicode true
!include "LogicLib.nsh"
!ifndef BUILD_RESOURCES_DIR
  !define BUILD_RESOURCES_DIR "..\build"
!endif
!define UNINSTALL_FILENAME "Uninstall Neox.exe"
!include "${BUILD_RESOURCES_DIR}\installer-process-check.nsh"
Name "Neox process check compile-only harness"
OutFile "$%TEMP%\neox-process-check-harness.exe"
RequestExecutionLevel user
Function checkAppRunning
  !insertmacro customCheckAppRunning
FunctionEnd
Function un.checkAppRunning
  !insertmacro customCheckAppRunning
FunctionEnd
Section
  # Retain generated code for compile validation, but never execute Close mode.
  Goto skip_check
  Call checkAppRunning
  skip_check:
  WriteUninstaller "$TEMP\neox-process-check-harness-uninstall.exe"
SectionEnd
Section "Uninstall"
  Goto skip_un_check
  Call un.checkAppRunning
  skip_un_check:
SectionEnd
