; Dimo installer theme: geometry (96-DPI logical px) + light/dark color tokens.
; Mirrors the approved redesign mock (installer-redesign.html): 520x400 window,
; 40px title bar, 14px control radius, 4px progress track, state color only on
; progress fill / error status.
!ifndef DIMO_INSTALLER_THEME
!define DIMO_INSTALLER_THEME

!define DIMO_WIN_W 520
!define DIMO_WIN_H 400
!define DIMO_TITLE_H 40
!define DIMO_CAPTION_BTN_W 46
!define DIMO_PAD_X 32          ; content inset
!define DIMO_FOOT_X 24         ; footer inset
!define DIMO_FOOT_Y 344        ; footer button row top (400 - 24 - 32)
!define DIMO_BTN_H 32
!define DIMO_BTN_PAD 16
!define DIMO_GHOST_PAD 12
!define DIMO_BTN_GAP 8
!define DIMO_BTN_MIN_W 64
!define DIMO_BIG_BTN_W 200
!define DIMO_BIG_BTN_H 40
!define DIMO_RADIUS 14
!define DIMO_RING 4            ; focus ring: 2px offset + 2px stroke around each button
; Brand lockup (large: welcome / finish / uninstall confirm)
!define DIMO_BRAND_ICON_Y 76
!define DIMO_BRAND_ICON 64
!define DIMO_BRAND_NAME_Y 152
!define DIMO_BRAND_NAME_H 28
!define DIMO_BRAND_SUB_Y 182
; Brand lockup (small: location / progress / error)
!define DIMO_BRAND_SM_ICON_Y 68
!define DIMO_BRAND_SM_ICON 48
!define DIMO_BRAND_SM_NAME_Y 126
!define DIMO_BRAND_SM_NAME_H 24
!define DIMO_BRAND_SM_SUB_Y 152
!define DIMO_SUB_H 16
; Welcome
!define DIMO_WELCOME_BTN_Y 244
!define DIMO_WELCOME_LINK_Y 300
; Location
!define DIMO_LOC_LABEL_Y 216
!define DIMO_LOC_FIELD_Y 240
!define DIMO_LOC_META_Y 284
; Progress
!define DIMO_PROG_LABEL_Y 236
!define DIMO_PROG_LABEL_H 18
!define DIMO_PROG_TRACK_Y 262
!define DIMO_PROG_TRACK_H 4
!define DIMO_PROG_FILE_Y 274
!define DIMO_PROG_FILE_H 16
; Finish / confirm checkbox row
!define DIMO_CHECK_Y 254
!define DIMO_CHECK_H 24
!define DIMO_CHECK_BOX 16

!define DIMO_FONT_LATIN "Segoe UI Variable Text"
!define DIMO_FONT_LATIN_FALLBACK "Segoe UI"
!define DIMO_FONT_CJK "Microsoft YaHei UI"
!define DIMO_FONT_MONO "Cascadia Mono"
!define DIMO_FONT_MONO_FALLBACK "Consolas"

Var DimoTheme
Var DimoDpi
; ARGB (GDI+) tokens
Var DimoBgArgb
Var DimoFgArgb
Var DimoMutArgb
Var DimoHairArgb
Var DimoPriArgb
Var DimoPriHoverArgb
Var DimoPriPressArgb
Var DimoPriFgArgb
Var DimoSecArgb
Var DimoSecHoverArgb
Var DimoTrackArgb
Var DimoFocusArgb
Var DimoErrArgb
Var DimoErrTintArgb
Var DimoFieldArgb
Var DimoShadowArgb
Var DimoCloseHoverArgb
; COLORREF (GDI, 0x00BBGGRR) tokens
Var DimoBgRef
Var DimoFgRef
Var DimoMutRef
Var DimoPriFgRef
Var DimoErrRef

; SetCtlColors takes compile-time colors, so each role branches on the theme.
!macro DimoCtlColors HANDLE LIGHT_FG LIGHT_BG DARK_FG DARK_BG
  ${If} $DimoTheme == "dark"
    SetCtlColors ${HANDLE} ${DARK_FG} ${DARK_BG}
  ${Else}
    SetCtlColors ${HANDLE} ${LIGHT_FG} ${LIGHT_BG}
  ${EndIf}
!macroend
!macro DimoLabelColors HANDLE
  !insertmacro DimoCtlColors ${HANDLE} 171717 FFFFFF F5F5F5 1B1B1B
!macroend
!macro DimoMutedColors HANDLE
  !insertmacro DimoCtlColors ${HANDLE} 6B6B6B FFFFFF A0A0A0 1B1B1B
!macroend
!macro DimoErrorColors HANDLE
  !insertmacro DimoCtlColors ${HANDLE} C4314B FFFFFF F07C8C 1B1B1B
!macroend
!macro DimoFieldColors HANDLE
  !insertmacro DimoCtlColors ${HANDLE} 171717 FFFFFF F5F5F5 181818
!macroend

!macro DimoResolveThemeMacro
  ${If} $DimoTheme == ""
    StrCpy $DimoTheme "auto"
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/THEME=" $DimoTheme
  ${If} ${Errors}
  ${OrIf} $DimoTheme == ""
    StrCpy $DimoTheme "auto"
  ${EndIf}
  ${If} $DimoTheme != "light"
  ${AndIf} $DimoTheme != "dark"
    ClearErrors
    ReadRegDWORD $DimoTheme HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
    ${If} ${Errors}
    ${OrIf} $DimoTheme != 0
      StrCpy $DimoTheme "light"
    ${Else}
      StrCpy $DimoTheme "dark"
    ${EndIf}
  ${EndIf}

  ${If} $DimoTheme == "dark"
    IntOp $DimoBgArgb 0xFF1B1B1B + 0
    IntOp $DimoFgArgb 0xFFF5F5F5 + 0
    IntOp $DimoMutArgb 0xFFA0A0A0 + 0
    IntOp $DimoHairArgb 0xFF363636 + 0
    IntOp $DimoPriArgb 0xFFEDEDED + 0
    IntOp $DimoPriHoverArgb 0xFFFFFFFF + 0
    IntOp $DimoPriPressArgb 0xFFD0D0D0 + 0
    IntOp $DimoPriFgArgb 0xFF141414 + 0
    IntOp $DimoSecArgb 0xFF2A2A2A + 0
    IntOp $DimoSecHoverArgb 0xFF323232 + 0
    IntOp $DimoTrackArgb 0xFF333333 + 0
    IntOp $DimoFocusArgb 0xFFF5F5F5 + 0
    IntOp $DimoErrArgb 0xFFF07C8C + 0
    IntOp $DimoErrTintArgb 0xFF3A2A2D + 0
    IntOp $DimoFieldArgb 0xFF181818 + 0
    IntOp $DimoShadowArgb 0x66000000 + 0
    IntOp $DimoCloseHoverArgb 0xFFC42B1C + 0
    StrCpy $DimoBgRef 0x1B1B1B
    StrCpy $DimoFgRef 0xF5F5F5
    StrCpy $DimoMutRef 0xA0A0A0
    StrCpy $DimoPriFgRef 0x141414
    StrCpy $DimoErrRef 0x8C7CF0
  ${Else}
    IntOp $DimoBgArgb 0xFFFFFFFF + 0
    IntOp $DimoFgArgb 0xFF171717 + 0
    IntOp $DimoMutArgb 0xFF6B6B6B + 0
    IntOp $DimoHairArgb 0xFFE8E8E8 + 0
    IntOp $DimoPriArgb 0xFF1B1B1B + 0
    IntOp $DimoPriHoverArgb 0xFF333333 + 0
    IntOp $DimoPriPressArgb 0xFF000000 + 0
    IntOp $DimoPriFgArgb 0xFFFFFFFF + 0
    IntOp $DimoSecArgb 0xFFFFFFFF + 0
    IntOp $DimoSecHoverArgb 0xFFF5F5F5 + 0
    IntOp $DimoTrackArgb 0xFFEDEDED + 0
    IntOp $DimoFocusArgb 0xFF171717 + 0
    IntOp $DimoErrArgb 0xFFC4314B + 0
    IntOp $DimoErrTintArgb 0xFFFBEFF1 + 0
    IntOp $DimoFieldArgb 0xFFFFFFFF + 0
    IntOp $DimoShadowArgb 0x210D121C + 0
    IntOp $DimoCloseHoverArgb 0xFFC42B1C + 0
    StrCpy $DimoBgRef 0xFFFFFF
    StrCpy $DimoFgRef 0x171717
    StrCpy $DimoMutRef 0x6B6B6B
    StrCpy $DimoPriFgRef 0xFFFFFF
    StrCpy $DimoErrRef 0x4B31C4
  ${EndIf}
!macroend

!endif
