; VibeX installer theme: geometry (96-DPI logical px) + light/dark color tokens.
; Mirrors the approved redesign mock (installer-redesign.html): 520x400 window,
; 40px title bar, 14px control radius, 4px progress track, state color only on
; progress fill / error status.
!ifndef VIBEX_INSTALLER_THEME
!define VIBEX_INSTALLER_THEME

!define VIBEX_WIN_W 520
!define VIBEX_WIN_H 400
!define VIBEX_TITLE_H 40
!define VIBEX_CAPTION_BTN_W 46
!define VIBEX_PAD_X 32          ; content inset
!define VIBEX_FOOT_X 24         ; footer inset
!define VIBEX_FOOT_Y 344        ; footer button row top (400 - 24 - 32)
!define VIBEX_BTN_H 32
!define VIBEX_BTN_PAD 16
!define VIBEX_GHOST_PAD 12
!define VIBEX_BTN_GAP 8
!define VIBEX_BTN_MIN_W 64
!define VIBEX_BIG_BTN_W 200
!define VIBEX_BIG_BTN_H 40
!define VIBEX_RADIUS 14
!define VIBEX_RING 4            ; focus ring: 2px offset + 2px stroke around each button
; Brand lockup (large: welcome / finish / uninstall confirm)
!define VIBEX_BRAND_ICON_Y 76
!define VIBEX_BRAND_ICON 64
!define VIBEX_BRAND_NAME_Y 152
!define VIBEX_BRAND_NAME_H 28
!define VIBEX_BRAND_SUB_Y 182
; Brand lockup (small: location / progress / error)
!define VIBEX_BRAND_SM_ICON_Y 68
!define VIBEX_BRAND_SM_ICON 48
!define VIBEX_BRAND_SM_NAME_Y 126
!define VIBEX_BRAND_SM_NAME_H 24
!define VIBEX_BRAND_SM_SUB_Y 152
!define VIBEX_SUB_H 16
; Welcome
!define VIBEX_WELCOME_BTN_Y 244
!define VIBEX_WELCOME_LINK_Y 300
; Location
!define VIBEX_LOC_LABEL_Y 216
!define VIBEX_LOC_FIELD_Y 240
!define VIBEX_LOC_META_Y 284
; Progress
!define VIBEX_PROG_LABEL_Y 236
!define VIBEX_PROG_LABEL_H 18
!define VIBEX_PROG_TRACK_Y 262
!define VIBEX_PROG_TRACK_H 4
!define VIBEX_PROG_FILE_Y 274
!define VIBEX_PROG_FILE_H 16
; Finish / confirm checkbox row
!define VIBEX_CHECK_Y 254
!define VIBEX_CHECK_H 24
!define VIBEX_CHECK_BOX 16

!define VIBEX_FONT_LATIN "Segoe UI Variable Text"
!define VIBEX_FONT_LATIN_FALLBACK "Segoe UI"
!define VIBEX_FONT_CJK "Microsoft YaHei UI"
!define VIBEX_FONT_MONO "Cascadia Mono"
!define VIBEX_FONT_MONO_FALLBACK "Consolas"

Var VibeXTheme
Var VibeXDpi
; ARGB (GDI+) tokens
Var VibeXBgArgb
Var VibeXFgArgb
Var VibeXMutArgb
Var VibeXHairArgb
Var VibeXPriArgb
Var VibeXPriHoverArgb
Var VibeXPriPressArgb
Var VibeXPriFgArgb
Var VibeXSecArgb
Var VibeXSecHoverArgb
Var VibeXTrackArgb
Var VibeXFocusArgb
Var VibeXErrArgb
Var VibeXErrTintArgb
Var VibeXFieldArgb
Var VibeXShadowArgb
Var VibeXCloseHoverArgb
; COLORREF (GDI, 0x00BBGGRR) tokens
Var VibeXBgRef
Var VibeXFgRef
Var VibeXMutRef
Var VibeXPriFgRef
Var VibeXErrRef

; SetCtlColors takes compile-time colors, so each role branches on the theme.
!macro VibeXCtlColors HANDLE LIGHT_FG LIGHT_BG DARK_FG DARK_BG
  ${If} $VibeXTheme == "dark"
    SetCtlColors ${HANDLE} ${DARK_FG} ${DARK_BG}
  ${Else}
    SetCtlColors ${HANDLE} ${LIGHT_FG} ${LIGHT_BG}
  ${EndIf}
!macroend
!macro VibeXLabelColors HANDLE
  !insertmacro VibeXCtlColors ${HANDLE} 171717 FFFFFF F5F5F5 1F1F1F
!macroend
!macro VibeXMutedColors HANDLE
  !insertmacro VibeXCtlColors ${HANDLE} 6B6B6B FFFFFF A0A0A0 1F1F1F
!macroend
!macro VibeXErrorColors HANDLE
  !insertmacro VibeXCtlColors ${HANDLE} C4314B FFFFFF F07C8C 1F1F1F
!macroend
!macro VibeXFieldColors HANDLE
  !insertmacro VibeXCtlColors ${HANDLE} 171717 FFFFFF F5F5F5 181818
!macroend

!macro VibeXResolveThemeMacro
  ${If} $VibeXTheme == ""
    StrCpy $VibeXTheme "auto"
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/THEME=" $VibeXTheme
  ${If} ${Errors}
  ${OrIf} $VibeXTheme == ""
    StrCpy $VibeXTheme "auto"
  ${EndIf}
  ${If} $VibeXTheme != "light"
  ${AndIf} $VibeXTheme != "dark"
    ClearErrors
    ReadRegDWORD $VibeXTheme HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
    ${If} ${Errors}
    ${OrIf} $VibeXTheme != 0
      StrCpy $VibeXTheme "light"
    ${Else}
      StrCpy $VibeXTheme "dark"
    ${EndIf}
  ${EndIf}

  ${If} $VibeXTheme == "dark"
    IntOp $VibeXBgArgb 0xFF1F1F1F + 0
    IntOp $VibeXFgArgb 0xFFF5F5F5 + 0
    IntOp $VibeXMutArgb 0xFFA0A0A0 + 0
    IntOp $VibeXHairArgb 0xFF363636 + 0
    IntOp $VibeXPriArgb 0xFFEDEDED + 0
    IntOp $VibeXPriHoverArgb 0xFFFFFFFF + 0
    IntOp $VibeXPriPressArgb 0xFFD0D0D0 + 0
    IntOp $VibeXPriFgArgb 0xFF141414 + 0
    IntOp $VibeXSecArgb 0xFF2A2A2A + 0
    IntOp $VibeXSecHoverArgb 0xFF323232 + 0
    IntOp $VibeXTrackArgb 0xFF333333 + 0
    IntOp $VibeXFocusArgb 0xFF7FB2F0 + 0
    IntOp $VibeXErrArgb 0xFFF07C8C + 0
    IntOp $VibeXErrTintArgb 0xFF3A2A2D + 0
    IntOp $VibeXFieldArgb 0xFF181818 + 0
    IntOp $VibeXShadowArgb 0x66000000 + 0
    IntOp $VibeXCloseHoverArgb 0xFFC42B1C + 0
    StrCpy $VibeXBgRef 0x1F1F1F
    StrCpy $VibeXFgRef 0xF5F5F5
    StrCpy $VibeXMutRef 0xA0A0A0
    StrCpy $VibeXPriFgRef 0x141414
    StrCpy $VibeXErrRef 0x8C7CF0
  ${Else}
    IntOp $VibeXBgArgb 0xFFFFFFFF + 0
    IntOp $VibeXFgArgb 0xFF171717 + 0
    IntOp $VibeXMutArgb 0xFF6B6B6B + 0
    IntOp $VibeXHairArgb 0xFFE8E8E8 + 0
    IntOp $VibeXPriArgb 0xFF1B1B1B + 0
    IntOp $VibeXPriHoverArgb 0xFF333333 + 0
    IntOp $VibeXPriPressArgb 0xFF000000 + 0
    IntOp $VibeXPriFgArgb 0xFFFFFFFF + 0
    IntOp $VibeXSecArgb 0xFFFFFFFF + 0
    IntOp $VibeXSecHoverArgb 0xFFF5F5F5 + 0
    IntOp $VibeXTrackArgb 0xFFEDEDED + 0
    IntOp $VibeXFocusArgb 0xFF2B6CB0 + 0
    IntOp $VibeXErrArgb 0xFFC4314B + 0
    IntOp $VibeXErrTintArgb 0xFFFBEFF1 + 0
    IntOp $VibeXFieldArgb 0xFFFFFFFF + 0
    IntOp $VibeXShadowArgb 0x210D121C + 0
    IntOp $VibeXCloseHoverArgb 0xFFC42B1C + 0
    StrCpy $VibeXBgRef 0xFFFFFF
    StrCpy $VibeXFgRef 0x171717
    StrCpy $VibeXMutRef 0x6B6B6B
    StrCpy $VibeXPriFgRef 0xFFFFFF
    StrCpy $VibeXErrRef 0x4B31C4
  ${EndIf}
!macroend

!endif
