; VibeX Tahoe Installer Theme & Geometry (96-DPI logical pixels)
!ifndef VIBEX_INSTALLER_THEME
!define VIBEX_INSTALLER_THEME

!define VIBEX_WIN_W 480
!define VIBEX_WIN_H 410
!define VIBEX_BRAND_Y 84
!define VIBEX_BRAND_H 124
!define VIBEX_ROW_A_Y 272
!define VIBEX_ROW_B_Y 324
!define VIBEX_BTN_W 120
!define VIBEX_BTN_H 40
!define VIBEX_BTN_RADIUS 20
!define VIBEX_SMALL_RADIUS 16
!define VIBEX_PROGRESS_X 44
!define VIBEX_PROGRESS_Y 292
!define VIBEX_PROGRESS_W 392
!define VIBEX_PROGRESS_H 6
!define VIBEX_STATUS_Y 310
!define VIBEX_STATUS_H 22
!define VIBEX_FONT_NAME "Microsoft YaHei UI"
!define VIBEX_BTN_FONT_SIZE 14
!define VIBEX_SMALL_FONT_SIZE 13

Var VibeXTheme
Var VibeXDpi
Var VibeXWinW
Var VibeXWinH
Var VibeXBgArgb
Var VibeXBgColorref
Var VibeXTextColorref
Var VibeXMutedColorref
Var VibeXPrimaryArgb
Var VibeXPrimaryHoverArgb
Var VibeXPrimaryPressedArgb
Var VibeXPrimaryColorref
Var VibeXButtonTextColorref
Var VibeXControlHoverArgb
Var VibeXTrackColorref
Var VibeXBorderArgb

!macro VibeXControlColors HANDLE
  ${If} $VibeXTheme == "dark"
    SetCtlColors ${HANDLE} FAFAFA 1B1B1B
  ${Else}
    SetCtlColors ${HANDLE} 171717 FFFFFF
  ${EndIf}
!macroend

!macro VibeXMutedControlColors HANDLE
  ${If} $VibeXTheme == "dark"
    SetCtlColors ${HANDLE} A3A3A3 1B1B1B
  ${Else}
    SetCtlColors ${HANDLE} 525252 FFFFFF
  ${EndIf}
!macroend

!macro VibeXResolveThemeMacro
  ${If} $VibeXTheme == ""
    StrCpy $VibeXTheme "auto"
  ${EndIf}
  ${GetOptions} $CMDLINE "/THEME=" $0
  ${IfNot} ${Errors}
    ${If} $0 == "light"
    ${OrIf} $0 == "dark"
    ${OrIf} $0 == "auto"
      StrCpy $VibeXTheme $0
    ${EndIf}
  ${EndIf}
  ${If} $VibeXTheme == "auto"
    ClearErrors
    ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
    ${If} ${Errors}
      StrCpy $0 1
    ${EndIf}
    ${If} $0 == 0
      StrCpy $VibeXTheme "dark"
    ${Else}
      StrCpy $VibeXTheme "light"
    ${EndIf}
  ${EndIf}

  ${If} $VibeXTheme == "dark"
    ; Dark Tahoe tokens: canvas #1B1B1B, primary #E7EBEF (COLORREF 0xEFEBE7), fg #0E1319 (COLORREF 0x19130E)
    StrCpy $VibeXBgArgb 0xFF1B1B1B
    StrCpy $VibeXBgColorref 0x1B1B1B
    StrCpy $VibeXTextColorref 0xFAFAFA
    StrCpy $VibeXMutedColorref 0xA3A3A3
    StrCpy $VibeXPrimaryArgb 0xFFE7EBEF
    StrCpy $VibeXPrimaryHoverArgb 0xFFDBE2E8
    StrCpy $VibeXPrimaryPressedArgb 0xFFCFD8E0
    StrCpy $VibeXPrimaryColorref 0xEFEBE7
    StrCpy $VibeXButtonTextColorref 0x19130E
    StrCpy $VibeXControlHoverArgb 0xFF262626
    StrCpy $VibeXTrackColorref 0x404040
    StrCpy $VibeXBorderArgb 0xFF525252
  ${Else}
    ; Light Tahoe tokens: canvas #FFFFFF, primary #1B1B1B (COLORREF 0x1B1B1B), fg #FFFFFF
    StrCpy $VibeXBgArgb 0xFFFFFFFF
    StrCpy $VibeXBgColorref 0xFFFFFF
    StrCpy $VibeXTextColorref 0x171717
    StrCpy $VibeXMutedColorref 0x525252
    StrCpy $VibeXPrimaryArgb 0xFF1B1B1B
    StrCpy $VibeXPrimaryHoverArgb 0xFF2D3135
    StrCpy $VibeXPrimaryPressedArgb 0xFF000000
    StrCpy $VibeXPrimaryColorref 0x1B1B1B
    StrCpy $VibeXButtonTextColorref 0xFFFFFF
    StrCpy $VibeXControlHoverArgb 0xFFF5F5F5
    StrCpy $VibeXTrackColorref 0xE5E5E5
    StrCpy $VibeXBorderArgb 0xFFD4D4D4
  ${EndIf}
!macroend

!endif
