; Aerus AI Usage HUD installer. Per-user install (no administrator rights needed).
; Build with packaging\build-installer.ps1, which passes STAGE_DIR, OUTPUT_DIR and APP_VERSION.

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef STAGE_DIR
  !error "STAGE_DIR must point at the published application folder"
!endif
!ifndef OUTPUT_DIR
  !error "OUTPUT_DIR must point at the installer output folder"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "1.0.2"
!endif

!define APP_NAME "Aerus AI Usage HUD"
!define APP_EXE "Aerus AI Usage HUD.exe"
!define PUBLISHER "Aerus Creations"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AerusAIUsageHUD"
!define MUTEX_NAME "Local\Aerus.UsageHud.Desktop.SingleInstance"
!define WEBVIEW2_GUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${APP_NAME}"
OutFile "${OUTPUT_DIR}\AerusAIUsageHUD-Setup-v${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUnInstDetails show
Icon "${STAGE_DIR}\assets\aerus-usage-hud.ico"
UninstallIcon "${STAGE_DIR}\assets\aerus-usage-hud.ico"

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "${APP_NAME} setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) ${PUBLISHER}"

!define MUI_ABORTWARNING
!define MUI_ICON "${STAGE_DIR}\assets\aerus-usage-hud.ico"
!define MUI_UNICON "${STAGE_DIR}\assets\aerus-usage-hud.ico"
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APP_NAME} ${APP_VERSION} Setup"
!define MUI_WELCOMEPAGE_TEXT "This installs ${APP_NAME} for the current Windows user. It includes its own Node.js runtime, so you do not need to install anything else.$\r$\n$\r$\nThe HUD reads your local Codex and Claude Code history. Nothing is uploaded."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APP_NAME}"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} is installed. Use the Start menu or the desktop shortcut to open it."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; Do not replace files while the app is open. The user closes it normally.
  System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "${MUTEX_NAME}") p.r0'
  StrCmp $0 0 app_closed
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_ICONEXCLAMATION|MB_OK "Please close ${APP_NAME} before installing or updating it, then run Setup again."
    Abort
  app_closed:
FunctionEnd

Function un.onInit
  System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "${MUTEX_NAME}") p.r0'
  StrCmp $0 0 un_app_closed
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_ICONEXCLAMATION|MB_OK "Please close ${APP_NAME} before uninstalling it."
    Abort
  un_app_closed:
FunctionEnd

Section "${APP_NAME} (required)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0 SW_SHOWNORMAL "" "Local Codex and Claude token usage"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

; Checked by default. Untick it to skip the Desktop icon.
Section "Desktop shortcut" SecDesktop
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0 SW_SHOWNORMAL "" "Local Codex and Claude token usage"
SectionEnd

Section "Uninstall"
  ; The program folder is ours alone, so remove it whole.
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; Your usage ledger and WebView2 profile live in %LOCALAPPDATA%\Aerus\AI Usage HUD and are kept on purpose.
  ; The ledger holds Claude history that Claude Code may have already deleted.
SectionEnd
