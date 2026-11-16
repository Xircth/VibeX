; Dimo installer drawing primitives.
; Every control face (buttons, checkbox, title-bar glyphs, path field, progress
; bar, error glyph) is rendered by one function, DimoRender, into a device-
; dependent bitmap. Owner-drawn buttons blit it during NM_CUSTOMDRAW; statics on
; the MUI instfiles page (which has no nsDialogs notify routing) show it through
; STM_SETIMAGE. The face is a 24bpp DIB (no alpha channel), which keeps
; statics free of alpha artifacts. Shadows are never stacked: the only window shadow is the DWM one.
;
; None of these helpers touch $0-$9 / $R0-$R9, so they are safe to call from
; sections and from page callbacks that keep values in registers.
!ifndef DIMO_INSTALLER_DRAWING
!define DIMO_INSTALLER_DRAWING

!define /ifndef WM_NOTIFY_OUTER_NEXT 0x408
!define /ifndef PBM_GETPOS 0x0408
!define /ifndef PBM_GETRANGE 0x0407

Var DimoGdiToken
Var DimoFaceLatin
Var DimoFaceUi
Var DimoFaceMono
Var DimoFontTitle
Var DimoFontName
Var DimoFontNameSm
Var DimoFontSub
Var DimoFontBody
Var DimoFontBtn
Var DimoFontBtnLg
Var DimoFontMono
Var DimoBorderArgb
Var DimoBorderRef
Var DimoHoverFgRef
; Render inputs/outputs
Var DimoRKind
Var DimoRText
Var DimoRW
Var DimoRH
Var DimoRState   ; bit 1 hover, 2 pressed, 4 focus, 8 disabled, 16 checked, 32 error
Var DimoRFont
Var DimoRBmp
; Render scratch
Var DimoT0
Var DimoT1
Var DimoT2
Var DimoT3
Var DimoT4
Var DimoT5
Var DimoT6
Var DimoT7
Var DimoT8
Var DimoT9
Var DimoDC
Var DimoOldBmp
Var DimoGfx
Var DimoF0
Var DimoF1
Var DimoF2
Var DimoF3
Var DimoF4
Var DimoPath
Var DimoBrush
Var DimoPen
Var DimoRect
Var DimoFillArgb
Var DimoStrokeArgb
Var DimoTextRef
Var DimoInset
; Placement scratch
Var DimoP0
Var DimoP1
Var DimoP2
Var DimoP3
Var DimoIconBmp
Var DimoIconSmBmp
Var DimoLogFile

!macro DimoScale OUT VALUE
  System::Call 'kernel32::MulDiv(i ${VALUE}, i $DimoDpi, i 96) i.s'
  Pop ${OUT}
!macroend

; Move a control using 96-DPI logical coordinates. Uses dedicated variables so
; callers' registers survive (the previous version clobbered $0-$3).
!macro DimoPlace HWND X Y W H
  !insertmacro DimoScale $DimoP0 ${X}
  !insertmacro DimoScale $DimoP1 ${Y}
  !insertmacro DimoScale $DimoP2 ${W}
  !insertmacro DimoScale $DimoP3 ${H}
  System::Call 'user32::MoveWindow(p ${HWND}, i $DimoP0, i $DimoP1, i $DimoP2, i $DimoP3, i 1)'
!macroend

; Same, but X/W are already device pixels (measured buttons), Y/H logical.
!macro DimoPlaceDevX HWND X Y W H
  !insertmacro DimoScale $DimoP1 ${Y}
  !insertmacro DimoScale $DimoP3 ${H}
  System::Call 'user32::MoveWindow(p ${HWND}, i ${X}, i $DimoP1, i ${W}, i $DimoP3, i 1)'
!macroend

!macro DimoMakeFont OUT SIZE WEIGHT FACE
  System::Call 'kernel32::MulDiv(i -${SIZE}, i $DimoDpi, i 96) i.s'
  Pop $DimoT0
  System::Call 'gdi32::CreateFontW(i $DimoT0, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "${FACE}") p.s'
  Pop ${OUT}
!macroend

; Static control created with CreateWindowEx so it works on both nsDialogs
; pages and the MUI instfiles dialog.
!macro DimoMakeStatic OUT PARENT STYLE TEXT X Y W H
  !insertmacro DimoScale $DimoP0 ${X}
  !insertmacro DimoScale $DimoP1 ${Y}
  !insertmacro DimoScale $DimoP2 ${W}
  !insertmacro DimoScale $DimoP3 ${H}
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i ${STYLE}, i $DimoP0, i $DimoP1, i $DimoP2, i $DimoP3, p ${PARENT}, p 0, p 0, p 0) p.s'
  Pop ${OUT}
!macroend

; Rounded rectangle path. X/Y/W/H/D are device pixels (D = corner diameter).
; GDI+ REAL arguments are passed as IEEE-754 bit patterns through "i": the
; System plugin's "f" type is not reliable (it passes 0 under some hosts).
!define DIMO_F0   0
!define DIMO_F90  0x42B40000
!define DIMO_F180 0x43340000
!define DIMO_F270 0x43870000

; OUT = float bits of the non-negative integer N.
!macro DimoFloatBits OUT N
  StrCpy $DimoF0 ${N}
  StrCpy ${OUT} 0
  ${If} $DimoF0 > 0
    StrCpy $DimoF1 23
    ${DoWhile} $DimoF0 < 0x800000
      IntOp $DimoF0 $DimoF0 << 1
      IntOp $DimoF1 $DimoF1 - 1
    ${Loop}
    ${DoWhile} $DimoF0 >= 0x1000000
      IntOp $DimoF0 $DimoF0 >> 1
      IntOp $DimoF1 $DimoF1 + 1
    ${Loop}
    IntOp $DimoF0 $DimoF0 & 0x7FFFFF
    IntOp $DimoF1 $DimoF1 + 127
    IntOp $DimoF1 $DimoF1 << 23
    IntOp ${OUT} $DimoF1 | $DimoF0
  ${EndIf}
!macroend

!macro DimoRoundPath X Y W H D
  System::Call 'gdiplus::GdipCreatePath(i 0, *p .s)'
  Pop $DimoPath
  IntOp $DimoF3 ${X} + ${W}
  IntOp $DimoF3 $DimoF3 - ${D}
  IntOp $DimoF4 ${Y} + ${H}
  IntOp $DimoF4 $DimoF4 - ${D}
  System::Call 'gdiplus::GdipAddPathArcI(p $DimoPath, i ${X}, i ${Y}, i ${D}, i ${D}, i ${DIMO_F180}, i ${DIMO_F90})'
  System::Call 'gdiplus::GdipAddPathArcI(p $DimoPath, i $DimoF3, i ${Y}, i ${D}, i ${D}, i ${DIMO_F270}, i ${DIMO_F90})'
  System::Call 'gdiplus::GdipAddPathArcI(p $DimoPath, i $DimoF3, i $DimoF4, i ${D}, i ${D}, i ${DIMO_F0}, i ${DIMO_F90})'
  System::Call 'gdiplus::GdipAddPathArcI(p $DimoPath, i ${X}, i $DimoF4, i ${D}, i ${D}, i ${DIMO_F90}, i ${DIMO_F90})'
  System::Call 'gdiplus::GdipClosePathFigure(p $DimoPath)'
!macroend

!macro DimoFillPath ARGB
  System::Call 'gdiplus::GdipCreateSolidFill(i ${ARGB}, *p .s)'
  Pop $DimoBrush
  System::Call 'gdiplus::GdipFillPath(p $DimoGfx, p $DimoBrush, p $DimoPath)'
  System::Call 'gdiplus::GdipDeleteBrush(p $DimoBrush)'
!macroend

!macro DimoStrokePath ARGB WIDTH
  !insertmacro DimoFloatBits $DimoF2 ${WIDTH}
  System::Call 'gdiplus::GdipCreatePen1(i ${ARGB}, i $DimoF2, i 2, *p .s)'
  Pop $DimoPen
  System::Call 'gdiplus::GdipDrawPath(p $DimoGfx, p $DimoPen, p $DimoPath)'
  System::Call 'gdiplus::GdipDeletePen(p $DimoPen)'
!macroend

!macro DimoLine ARGB WIDTH X1 Y1 X2 Y2
  !insertmacro DimoFloatBits $DimoF2 ${WIDTH}
  System::Call 'gdiplus::GdipCreatePen1(i ${ARGB}, i $DimoF2, i 2, *p .s)'
  Pop $DimoPen
  System::Call 'gdiplus::GdipSetPenStartCap(p $DimoPen, i 2)'
  System::Call 'gdiplus::GdipSetPenEndCap(p $DimoPen, i 2)'
  System::Call 'gdiplus::GdipDrawLineI(p $DimoGfx, p $DimoPen, i ${X1}, i ${Y1}, i ${X2}, i ${Y2})'
  System::Call 'gdiplus::GdipDeletePen(p $DimoPen)'
!macroend

!macro DimoFreeBitmap HANDLE
  ${If} ${HANDLE} != ""
  ${AndIf} ${HANDLE} != 0
    System::Call 'gdi32::DeleteObject(p ${HANDLE})'
    StrCpy ${HANDLE} 0
  ${EndIf}
!macroend

; Assign a rendered bitmap to a static and free the one it replaces.
!macro DimoSetStaticBitmap HWND
  SendMessage ${HWND} ${STM_SETIMAGE} ${IMAGE_BITMAP} $DimoRBmp $DimoT0
  ${If} $DimoT0 != 0
    System::Call 'gdi32::DeleteObject(p $DimoT0)'
  ${EndIf}
!macroend

!macro DimoLog TEXT
  FileOpen $DimoLogFile "$PLUGINSDIR\install.log" a
  ${If} $DimoLogFile != ""
    FileSeek $DimoLogFile 0 END
    FileWriteUTF16LE $DimoLogFile "${TEXT}$\r$\n"
    FileClose $DimoLogFile
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; Shared functions, defined once for the installer and once ("un.") for the
; uninstaller.
; ---------------------------------------------------------------------------
!macro DIMO_DEFINE_DRAWING UN

; Pick the first available face; returns it in $DimoT0.
Function ${UN}DimoProbeFace
  Pop $DimoT1 ; fallback
  Pop $DimoT2 ; preferred
  System::Call 'gdi32::CreateFontW(i -12, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "$DimoT2") p.s'
  Pop $DimoT3
  System::Call 'user32::GetDC(p 0) p.s'
  Pop $DimoT4
  System::Call 'gdi32::SelectObject(p $DimoT4, p $DimoT3) p.s'
  Pop $DimoT5
  System::Call 'gdi32::GetTextFaceW(p $DimoT4, i 64, w .s)'
  Pop $DimoT0
  System::Call 'gdi32::SelectObject(p $DimoT4, p $DimoT5)'
  System::Call 'user32::ReleaseDC(p 0, p $DimoT4)'
  System::Call 'gdi32::DeleteObject(p $DimoT3)'
  ${If} $DimoT0 != $DimoT2
    StrCpy $DimoT0 $DimoT1
  ${EndIf}
FunctionEnd

; Resolve DPI, theme, fonts, icons and GDI+. Called once from (un.)onGUIInit.
Function ${UN}DimoInitResources
  !insertmacro DimoResolveThemeMacro
  ${If} $DimoTheme == "dark"
    IntOp $DimoBorderArgb 0xFF474747 + 0
    StrCpy $DimoBorderRef 0x474747
    StrCpy $DimoHoverFgRef 0xFFFFFF
  ${Else}
    IntOp $DimoBorderArgb 0xFFD6D6D6 + 0
    StrCpy $DimoBorderRef 0xD6D6D6
    StrCpy $DimoHoverFgRef 0x171717
  ${EndIf}

  System::Call 'user32::GetDC(p 0) p.s'
  Pop $DimoT0
  System::Call 'gdi32::GetDeviceCaps(p $DimoT0, i 88) i.s'
  Pop $DimoDpi
  System::Call 'user32::ReleaseDC(p 0, p $DimoT0)'
  ${If} $DimoDpi < 96
    StrCpy $DimoDpi 96
  ${EndIf}

  Push "${DIMO_FONT_LATIN}"
  Push "${DIMO_FONT_LATIN_FALLBACK}"
  Call ${UN}DimoProbeFace
  StrCpy $DimoFaceLatin $DimoT0
  Push "${DIMO_FONT_MONO}"
  Push "${DIMO_FONT_MONO_FALLBACK}"
  Call ${UN}DimoProbeFace
  StrCpy $DimoFaceMono $DimoT0
  StrCpy $DimoFaceUi $DimoFaceLatin
  ${If} $LANGUAGE == 2052
    StrCpy $DimoFaceUi "${DIMO_FONT_CJK}"
  ${EndIf}

  !insertmacro DimoMakeFont $DimoFontTitle 12 400 $DimoFaceUi
  !insertmacro DimoMakeFont $DimoFontName 20 600 $DimoFaceLatin
  !insertmacro DimoMakeFont $DimoFontNameSm 18 600 $DimoFaceLatin
  !insertmacro DimoMakeFont $DimoFontSub 13 400 $DimoFaceUi
  !insertmacro DimoMakeFont $DimoFontBody 13 400 $DimoFaceUi
  !insertmacro DimoMakeFont $DimoFontBtn 13 600 $DimoFaceUi
  !insertmacro DimoMakeFont $DimoFontBtnLg 14 600 $DimoFaceUi
  ; GDI has no per-glyph font fallback: monospace faces (Cascadia/Consolas)
  ; lack CJK glyphs, and the detail lines mix localized text with paths.
  ${If} $LANGUAGE = 2052
    !insertmacro DimoMakeFont $DimoFontMono 12 400 $DimoFaceUi
  ${Else}
    !insertmacro DimoMakeFont $DimoFontMono 12 400 $DimoFaceMono
  ${EndIf}

  System::Call '*(i 1, p 0, i 0, i 0) p.s'
  Pop $DimoT0
  System::Call 'gdiplus::GdiplusStartup(*p .s, p $DimoT0, p 0) i.s'
  Pop $DimoT1
  Pop $DimoGdiToken

  System::Free $DimoT0

  ; Logo: one bitmap per DPI bucket at an integer pixel size, never stretched.
  InitPluginsDir
  ${If} $DimoDpi < 108
    !insertmacro DimoExtractIcons 64 48
  ${ElseIf} $DimoDpi < 132
    !insertmacro DimoExtractIcons 80 60
  ${ElseIf} $DimoDpi < 168
    !insertmacro DimoExtractIcons 96 72
  ${Else}
    !insertmacro DimoExtractIcons 128 96
  ${EndIf}
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\dimo-icon.bmp", i 0, i 0, i 0, i 0x10) p.s'
  Pop $DimoIconBmp
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\dimo-icon-sm.bmp", i 0, i 0, i 0, i 0x10) p.s'
  Pop $DimoIconSmBmp
FunctionEnd

; Frameless window chrome: size, center, DWM rounding + shadow, dark frame.
Function ${UN}DimoSetupWindow
  HideWindow
  IntOp $DimoT0 0x960A0000 + 0 ; WS_POPUP|WS_VISIBLE|WS_CLIPSIBLINGS|WS_SYSMENU|WS_MINIMIZEBOX
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i $DimoT0)'
  !insertmacro DimoScale $DimoP2 ${DIMO_WIN_W}
  !insertmacro DimoScale $DimoP3 ${DIMO_WIN_H}
  System::Call 'user32::GetSystemMetrics(i 0) i.s'
  Pop $DimoP0
  System::Call 'user32::GetSystemMetrics(i 1) i.s'
  Pop $DimoP1
  IntOp $DimoP0 $DimoP0 - $DimoP2
  IntOp $DimoP0 $DimoP0 / 2
  IntOp $DimoP1 $DimoP1 - $DimoP3
  IntOp $DimoP1 $DimoP1 / 2
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i $DimoP0, i $DimoP1, i $DimoP2, i $DimoP3, i 0x0024)'
  ; Windows 11: DWMWA_WINDOW_CORNER_PREFERENCE (33) = DWMWCP_ROUND (2). Windows 10 ignores it.
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4)'
  ${If} $DimoTheme == "dark"
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  ${EndIf}
  ; 1px extended frame lets DWM draw its single native shadow under a popup window.
  System::Call '*(i 1, i 1, i 1, i 1) p.s'
  Pop $DimoT0
  System::Call 'dwmapi::DwmExtendFrameIntoClientArea(p $HWNDPARENT, p $DimoT0)'
  System::Free $DimoT0
  !insertmacro DimoLabelColors $HWNDPARENT
  Call ${UN}DimoHideOuterControls
FunctionEnd

; Hide stock MUI buttons/banners. Called on every page, not only at startup,
; because MUI re-shows Back/Next/Cancel whenever it switches pages.
Function ${UN}DimoHideOuterControls
  !insertmacro DimoHideItem 1
  !insertmacro DimoHideItem 2
  !insertmacro DimoHideItem 3
  !insertmacro DimoHideItem 1028
  !insertmacro DimoHideItem 1256
  !insertmacro DimoHideItem 1034
  !insertmacro DimoHideItem 1035
  !insertmacro DimoHideItem 1036
  !insertmacro DimoHideItem 1037
  !insertmacro DimoHideItem 1038
  !insertmacro DimoHideItem 1039
FunctionEnd

; Measure $DimoRText in $DimoRFont -> $DimoRW (device px).
Function ${UN}DimoMeasure
  System::Call 'user32::GetDC(p 0) p.s'
  Pop $DimoT4
  System::Call 'gdi32::SelectObject(p $DimoT4, p $DimoRFont) p.s'
  Pop $DimoT5
  System::Call '*(i 0, i 0) p.s'
  Pop $DimoT6
  StrLen $DimoT3 $DimoRText
  System::Call 'gdi32::GetTextExtentPoint32W(p $DimoT4, w "$DimoRText", i $DimoT3, p $DimoT6)'
  System::Call '*$DimoT6(i .s, i)'
  Pop $DimoRW
  System::Free $DimoT6
  System::Call 'gdi32::SelectObject(p $DimoT4, p $DimoT5)'
  System::Call 'user32::ReleaseDC(p 0, p $DimoT4)'
FunctionEnd

; Width of a button control (face + focus-ring margin) for $DimoRText/$DimoRKind.
Function ${UN}DimoButtonWidth
  ${If} $DimoRFont == ""
    StrCpy $DimoRFont $DimoFontBtn
  ${EndIf}
  Call ${UN}DimoMeasure
  ${If} $DimoRKind == "ghost"
    !insertmacro DimoScale $DimoT0 ${DIMO_GHOST_PAD}
  ${Else}
    !insertmacro DimoScale $DimoT0 ${DIMO_BTN_PAD}
  ${EndIf}
  IntOp $DimoRW $DimoRW + $DimoT0
  IntOp $DimoRW $DimoRW + $DimoT0
  !insertmacro DimoScale $DimoT0 ${DIMO_BTN_MIN_W}
  ${If} $DimoRW < $DimoT0
    StrCpy $DimoRW $DimoT0
  ${EndIf}
  !insertmacro DimoScale $DimoT0 ${DIMO_RING}
  IntOp $DimoRW $DimoRW + $DimoT0
  IntOp $DimoRW $DimoRW + $DimoT0
FunctionEnd

; Render a control face. Inputs: $DimoRKind $DimoRText $DimoRW $DimoRH
; $DimoRState $DimoRFont. Output: $DimoRBmp (caller owns it).
Function ${UN}DimoRender
  System::Call 'user32::GetDC(p 0) p.s'
  Pop $DimoT0
  System::Call 'gdi32::CreateCompatibleDC(p $DimoT0) p.s'
  Pop $DimoDC
  ; 24bpp top-down DIB section: no alpha channel. A CreateCompatibleBitmap DDB is
  ; 32bpp on modern displays; GDI (FillRect/DrawText) leaves its alpha byte at 0
  ; while GDI+ writes 0xFF, so comctl32 v6 statics (SS_BITMAP) alpha-blend it and
  ; every GDI-filled pixel shows the static's default COLOR_BTNFACE (#F0F0F0)
  ; background instead of the installer background.
  IntOp $DimoT1 0 - $DimoRH
  System::Call '*(i 40, i $DimoRW, i $DimoT1, &i2 1, &i2 24, i 0, i 0, i 0, i 0, i 0, i 0) p.s'
  Pop $DimoT1
  System::Call 'gdi32::CreateDIBSection(p $DimoT0, p $DimoT1, i 0, p 0, p 0, i 0) p.s'
  Pop $DimoRBmp
  System::Free $DimoT1
  System::Call 'user32::ReleaseDC(p 0, p $DimoT0)'
  System::Call 'gdi32::SelectObject(p $DimoDC, p $DimoRBmp) p.s'
  Pop $DimoOldBmp
  System::Call '*(i 0, i 0, i $DimoRW, i $DimoRH) p.s'
  Pop $DimoRect

  ; Background
  StrCpy $DimoT0 $DimoBgRef
  ${If} $DimoRKind == "field"
  ${OrIf} $DimoRKind == "fieldfocus"
    StrCpy $DimoT0 $DimoBgRef
  ${EndIf}
  ${If} $DimoRKind == "close"
    IntOp $DimoT1 $DimoRState & 3
    ${If} $DimoT1 != 0
      StrCpy $DimoT0 0x1C2BC4
    ${EndIf}
  ${EndIf}
  System::Call 'gdi32::CreateSolidBrush(i $DimoT0) p.s'
  Pop $DimoT1
  System::Call 'user32::FillRect(p $DimoDC, p $DimoRect, p $DimoT1)'
  System::Call 'gdi32::DeleteObject(p $DimoT1)'

  System::Call 'gdiplus::GdipCreateFromHDC(p $DimoDC, *p .s) i.s'
  Pop $DimoT1
  Pop $DimoGfx
  System::Call 'gdiplus::GdipSetSmoothingMode(p $DimoGfx, i 4)'
  System::Call 'gdiplus::GdipSetPixelOffsetMode(p $DimoGfx, i 4)'

  !insertmacro DimoScale $DimoT9 1 ; 1 logical px (pen width)
  IntOp $DimoT2 $DimoRState & 1
  IntOp $DimoT3 $DimoRState & 2
  IntOp $DimoT4 $DimoRState & 4
  IntOp $DimoT5 $DimoRState & 8
  StrCpy $DimoTextRef $DimoFgRef
  StrCpy $DimoInset 0

  ${If} $DimoRKind == "pri"
  ${OrIf} $DimoRKind == "sec"
  ${OrIf} $DimoRKind == "danger"
  ${OrIf} $DimoRKind == "ghost"
    !insertmacro DimoScale $DimoInset ${DIMO_RING}
    IntOp $DimoT0 $DimoInset * 2
    IntOp $DimoT6 $DimoRW - $DimoT0 ; body width
    IntOp $DimoT8 $DimoRH - $DimoT0 ; body height
    !insertmacro DimoScale $DimoT1 ${DIMO_RADIUS}
    IntOp $DimoT1 $DimoT1 * 2
    ${If} $DimoT1 > $DimoT8
      StrCpy $DimoT1 $DimoT8
    ${EndIf}
    StrCpy $DimoFillArgb ""
    StrCpy $DimoStrokeArgb ""
    ${If} $DimoRKind == "pri"
      StrCpy $DimoFillArgb $DimoPriArgb
      ${If} $DimoT2 != 0
        StrCpy $DimoFillArgb $DimoPriHoverArgb
      ${EndIf}
      ${If} $DimoT3 != 0
        StrCpy $DimoFillArgb $DimoPriPressArgb
      ${EndIf}
      StrCpy $DimoTextRef $DimoPriFgRef
    ${ElseIf} $DimoRKind == "sec"
      StrCpy $DimoFillArgb $DimoSecArgb
      ${If} $DimoT2 != 0
      ${OrIf} $DimoT3 != 0
        StrCpy $DimoFillArgb $DimoSecHoverArgb
      ${EndIf}
      StrCpy $DimoStrokeArgb $DimoBorderArgb
    ${ElseIf} $DimoRKind == "danger"
      StrCpy $DimoFillArgb $DimoBgArgb
      ${If} $DimoT2 != 0
      ${OrIf} $DimoT3 != 0
        StrCpy $DimoFillArgb $DimoErrTintArgb
      ${EndIf}
      StrCpy $DimoStrokeArgb $DimoErrArgb
      StrCpy $DimoTextRef $DimoErrRef
    ${Else}
      ${If} $DimoT2 != 0
      ${OrIf} $DimoT3 != 0
        StrCpy $DimoFillArgb $DimoSecHoverArgb
      ${EndIf}
      ${If} $DimoRText == "$(DIMO_VIEW_LOG)"
        StrCpy $DimoTextRef $DimoMutRef
      ${EndIf}
    ${EndIf}
    ${If} $DimoT5 != 0
      StrCpy $DimoTextRef $DimoMutRef
      ${If} $DimoRKind == "pri"
        StrCpy $DimoFillArgb $DimoTrackArgb
      ${EndIf}
    ${EndIf}
    ; Body
    ${If} $DimoFillArgb != ""
      !insertmacro DimoRoundPath $DimoInset $DimoInset $DimoT6 $DimoT8 $DimoT1
      !insertmacro DimoFillPath $DimoFillArgb
      System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    ${EndIf}
    ${If} $DimoStrokeArgb != ""
      ; 1px hairline centered inside the body edge
      IntOp $DimoT0 $DimoT9 / 2
      IntOp $DimoT0 $DimoInset + $DimoT0
      IntOp $DimoT6 $DimoT6 - $DimoT9
      IntOp $DimoT8 $DimoT8 - $DimoT9
      !insertmacro DimoRoundPath $DimoT0 $DimoT0 $DimoT6 $DimoT8 $DimoT1
      !insertmacro DimoStrokePath $DimoStrokeArgb $DimoT9
      System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    ${EndIf}
    ; Focus ring: 2px stroke, 2px outside the body (fills the reserved margin)
    ${If} $DimoT4 != 0
    ${AndIf} $DimoT5 == 0
      !insertmacro DimoScale $DimoT0 1
      !insertmacro DimoScale $DimoT6 2
      IntOp $DimoT8 $DimoT0 * 2
      IntOp $DimoT7 $DimoRW - $DimoT8
      IntOp $DimoT8 $DimoRH - $DimoT8
      IntOp $DimoT1 $DimoT1 + $DimoInset
      IntOp $DimoT1 $DimoT1 + $DimoInset
      IntOp $DimoT1 $DimoT1 - $DimoT0
      IntOp $DimoT1 $DimoT1 - $DimoT0
      StrCpy $DimoT3 $DimoT7
      !insertmacro DimoRoundPath $DimoT0 $DimoT0 $DimoT3 $DimoT8 $DimoT1
      !insertmacro DimoStrokePath $DimoFocusArgb $DimoT6
      System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    ${EndIf}

  ${ElseIf} $DimoRKind == "link"
    StrCpy $DimoTextRef $DimoMutRef
    ${If} $DimoT2 != 0
    ${OrIf} $DimoT4 != 0
      StrCpy $DimoTextRef $DimoHoverFgRef
    ${EndIf}
    ${If} $DimoT4 != 0
      ; underline as keyboard focus indicator for the text link
      !insertmacro DimoScale $DimoT0 6
      IntOp $DimoT1 $DimoRH - $DimoT0
      !insertmacro DimoScale $DimoT0 2
      IntOp $DimoT6 $DimoRW - $DimoT0
      !insertmacro DimoLine $DimoFocusArgb $DimoT0 $DimoT0 $DimoT1 $DimoT6 $DimoT1
    ${EndIf}

  ${ElseIf} $DimoRKind == "min"
  ${OrIf} $DimoRKind == "close"
    StrCpy $DimoT0 $DimoMutArgb
    ${If} $DimoRKind == "min"
      ${If} $DimoT2 != 0
      ${OrIf} $DimoT3 != 0
        StrCpy $DimoFillArgb $DimoSecHoverArgb
        System::Call 'gdiplus::GdipGraphicsClear(p $DimoGfx, i $DimoFillArgb)'
        StrCpy $DimoT0 $DimoFgArgb
      ${EndIf}
    ${Else}
      ${If} $DimoT2 != 0
      ${OrIf} $DimoT3 != 0
        StrCpy $DimoT0 -1
      ${EndIf}
    ${EndIf}
    ${If} $DimoT5 != 0
      StrCpy $DimoT0 $DimoHairArgb
    ${EndIf}
    IntOp $DimoT6 $DimoRW / 2
    IntOp $DimoT8 $DimoRH / 2
    !insertmacro DimoScale $DimoT1 5
    IntOp $DimoP0 $DimoT6 - $DimoT1
    IntOp $DimoP1 $DimoT6 + $DimoT1
    IntOp $DimoP2 $DimoT8 - $DimoT1
    IntOp $DimoP3 $DimoT8 + $DimoT1
    ${If} $DimoRKind == "min"
      !insertmacro DimoLine $DimoT0 $DimoT9 $DimoP0 $DimoT8 $DimoP1 $DimoT8
    ${Else}
      !insertmacro DimoLine $DimoT0 $DimoT9 $DimoP0 $DimoP2 $DimoP1 $DimoP3
      !insertmacro DimoLine $DimoT0 $DimoT9 $DimoP0 $DimoP3 $DimoP1 $DimoP2
    ${EndIf}
    ${If} $DimoT4 != 0
      !insertmacro DimoScale $DimoT6 2
      IntOp $DimoT7 $DimoRW - $DimoT6
      IntOp $DimoT7 $DimoT7 - $DimoT6
      IntOp $DimoT8 $DimoRH - $DimoT6
      IntOp $DimoT8 $DimoT8 - $DimoT6
      !insertmacro DimoScale $DimoT1 8
      !insertmacro DimoRoundPath $DimoT6 $DimoT6 $DimoT7 $DimoT8 $DimoT1
      !insertmacro DimoStrokePath $DimoFocusArgb $DimoT6
      System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    ${EndIf}
    StrCpy $DimoRText ""

  ${ElseIf} $DimoRKind == "check"
    ; 16px box (4px radius) at x=3, vertically centered; label 26px from left.
    !insertmacro DimoScale $DimoT6 ${DIMO_CHECK_BOX}
    !insertmacro DimoScale $DimoP0 3
    IntOp $DimoT1 $DimoRH - $DimoT6
    IntOp $DimoT1 $DimoT1 / 2
    !insertmacro DimoScale $DimoT8 8
    ${If} $DimoT4 != 0
      !insertmacro DimoScale $DimoT0 2
      IntOp $DimoP1 $DimoP0 - $DimoT0
      IntOp $DimoP2 $DimoT1 - $DimoT0
      IntOp $DimoP3 $DimoT0 * 2
      IntOp $DimoT3 $DimoT8 + $DimoP3
      IntOp $DimoP3 $DimoP3 + $DimoT6
      !insertmacro DimoRoundPath $DimoP1 $DimoP2 $DimoP3 $DimoP3 $DimoT3
      !insertmacro DimoStrokePath $DimoFocusArgb $DimoT0
      System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    ${EndIf}
    IntOp $DimoT7 $DimoRState & 16
    ${If} $DimoT7 != 0
      !insertmacro DimoRoundPath $DimoP0 $DimoT1 $DimoT6 $DimoT6 $DimoT8
      !insertmacro DimoFillPath $DimoPriArgb
      System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
      ; check mark (4,8) -> (7,11) -> (12,5) in box units
      !insertmacro DimoScale $DimoP1 4
      IntOp $DimoP1 $DimoP1 + $DimoP0
      !insertmacro DimoScale $DimoP2 8
      IntOp $DimoP2 $DimoP2 + $DimoT1
      !insertmacro DimoScale $DimoP3 7
      IntOp $DimoP3 $DimoP3 + $DimoP0
      !insertmacro DimoScale $DimoT2 11
      IntOp $DimoT2 $DimoT2 + $DimoT1
      !insertmacro DimoScale $DimoT3 2
      !insertmacro DimoLine $DimoPriFgArgb $DimoT3 $DimoP1 $DimoP2 $DimoP3 $DimoT2
      !insertmacro DimoScale $DimoP1 12
      IntOp $DimoP1 $DimoP1 + $DimoP0
      !insertmacro DimoScale $DimoP2 5
      IntOp $DimoP2 $DimoP2 + $DimoT1
      !insertmacro DimoLine $DimoPriFgArgb $DimoT3 $DimoP3 $DimoT2 $DimoP1 $DimoP2
    ${Else}
      IntOp $DimoT2 $DimoT9 / 2
      IntOp $DimoP1 $DimoP0 + $DimoT2
      IntOp $DimoP2 $DimoT1 + $DimoT2
      IntOp $DimoP3 $DimoT6 - $DimoT9
      !insertmacro DimoRoundPath $DimoP1 $DimoP2 $DimoP3 $DimoP3 $DimoT8
      !insertmacro DimoStrokePath $DimoBorderArgb $DimoT9
      System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    ${EndIf}
    !insertmacro DimoScale $DimoT0 27
    System::Call '*$DimoRect(i $DimoT0)'

  ${ElseIf} $DimoRKind == "field"
  ${OrIf} $DimoRKind == "fieldfocus"
    ; Path field frame with folder glyph; focus = 2px focus-color ring.
    !insertmacro DimoScale $DimoT1 20 ; diameter 2*10
    StrCpy $DimoT0 $DimoT9
    IntOp $DimoT6 $DimoRW - $DimoT9
    IntOp $DimoT8 $DimoRH - $DimoT9
    IntOp $DimoT2 $DimoT9 / 2
    !insertmacro DimoRoundPath $DimoT2 $DimoT2 $DimoT6 $DimoT8 $DimoT1
    !insertmacro DimoFillPath $DimoFieldArgb
    ${If} $DimoRKind == "fieldfocus"
      System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
      !insertmacro DimoScale $DimoT0 2
      IntOp $DimoT2 $DimoT0 / 2
      IntOp $DimoT6 $DimoRW - $DimoT0
      IntOp $DimoT8 $DimoRH - $DimoT0
      !insertmacro DimoRoundPath $DimoT2 $DimoT2 $DimoT6 $DimoT8 $DimoT1
      !insertmacro DimoStrokePath $DimoFocusArgb $DimoT0
    ${Else}
      !insertmacro DimoStrokePath $DimoBorderArgb $DimoT9
    ${EndIf}
    System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    ; folder glyph (16x12) at x=12, vertically centered
    !insertmacro DimoScale $DimoP0 12
    !insertmacro DimoScale $DimoP2 16
    !insertmacro DimoScale $DimoP3 12
    IntOp $DimoP1 $DimoRH - $DimoP3
    IntOp $DimoP1 $DimoP1 / 2
    !insertmacro DimoScale $DimoT1 4
    !insertmacro DimoRoundPath $DimoP0 $DimoP1 $DimoP2 $DimoP3 $DimoT1
    !insertmacro DimoStrokePath $DimoMutArgb $DimoT9
    System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    !insertmacro DimoScale $DimoT2 3
    IntOp $DimoT3 $DimoP1 + $DimoT2
    !insertmacro DimoScale $DimoT2 7
    IntOp $DimoT6 $DimoP0 + $DimoT2
    IntOp $DimoT7 $DimoP0 + $DimoP2
    !insertmacro DimoLine $DimoMutArgb $DimoT9 $DimoP0 $DimoT3 $DimoT7 $DimoT3
    StrCpy $DimoRText ""

  ${ElseIf} $DimoRKind == "bar"
    ; 4px rounded track + fill. $DimoRText = permille (0-1000).
    System::Call 'gdiplus::GdipGraphicsClear(p $DimoGfx, i $DimoBgArgb)'
    StrCpy $DimoT1 $DimoRH
    !insertmacro DimoRoundPath 0 0 $DimoRW $DimoRH $DimoT1
    !insertmacro DimoFillPath $DimoTrackArgb
    System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    IntOp $DimoT6 $DimoRW * $DimoRText
    IntOp $DimoT6 $DimoT6 / 1000
    ${If} $DimoT6 > $DimoRW
      StrCpy $DimoT6 $DimoRW
    ${EndIf}
    ${If} $DimoT6 < $DimoRH
    ${AndIf} $DimoRText > 0
      StrCpy $DimoT6 $DimoRH
    ${EndIf}
    ${If} $DimoT6 > 0
      StrCpy $DimoFillArgb $DimoPriArgb
      IntOp $DimoT0 $DimoRState & 32
      ${If} $DimoT0 != 0
        StrCpy $DimoFillArgb $DimoErrArgb
      ${EndIf}
      !insertmacro DimoRoundPath 0 0 $DimoT6 $DimoRH $DimoT1
      !insertmacro DimoFillPath $DimoFillArgb
      System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    ${EndIf}
    StrCpy $DimoRText ""

  ${ElseIf} $DimoRKind == "erricon"
    ; filled circle with "!" in the error color
    System::Call 'gdiplus::GdipCreatePath(i 0, *p .s)'
    Pop $DimoPath
    IntOp $DimoT6 $DimoRH - 1
    System::Call 'gdiplus::GdipAddPathEllipseI(p $DimoPath, i 0, i 0, i $DimoT6, i $DimoT6)'
    !insertmacro DimoFillPath $DimoErrArgb
    System::Call 'gdiplus::GdipDeletePath(p $DimoPath)'
    IntOp $DimoT6 $DimoRH / 2
    !insertmacro DimoScale $DimoT1 3
    !insertmacro DimoScale $DimoT2 8
    !insertmacro DimoScale $DimoT3 10
    !insertmacro DimoScale $DimoT0 2
    !insertmacro DimoLine $DimoBgArgb $DimoT0 $DimoT6 $DimoT1 $DimoT6 $DimoT2
    !insertmacro DimoLine $DimoBgArgb $DimoT0 $DimoT6 $DimoT3 $DimoT6 $DimoT3
    StrCpy $DimoRText ""
  ${EndIf}

  System::Call 'gdiplus::GdipDeleteGraphics(p $DimoGfx)'

  ${If} $DimoRText != ""
    System::Call 'gdi32::SetBkMode(p $DimoDC, i 1)'
    System::Call 'gdi32::SetTextColor(p $DimoDC, i $DimoTextRef)'
    System::Call 'gdi32::SelectObject(p $DimoDC, p $DimoRFont) p.s'
    Pop $DimoT0
    ${If} $DimoRKind == "check"
      System::Call 'user32::DrawTextW(p $DimoDC, w "$DimoRText", i -1, p $DimoRect, i 0x24)'
    ${Else}
      System::Call 'user32::DrawTextW(p $DimoDC, w "$DimoRText", i -1, p $DimoRect, i 0x25)'
    ${EndIf}
    System::Call 'gdi32::SelectObject(p $DimoDC, p $DimoT0)'
  ${EndIf}

  System::Free $DimoRect
  System::Call 'gdi32::SelectObject(p $DimoDC, p $DimoOldBmp)'
  System::Call 'gdi32::DeleteDC(p $DimoDC)'
FunctionEnd

; NM_CUSTOMDRAW handler shared by every owner-drawn nsDialogs control.
; The control kind is stored with nsDialogs::SetUserData.
Function ${UN}DimoPaint
  Pop $DimoT0 ; hwnd
  Pop $DimoT1 ; code
  Pop $DimoT2 ; NMHDR*
  ${If} $DimoT1 != -12
    Return
  ${EndIf}
  System::Call '*$DimoT2(p, p, i, i .s, p .s, i, i, i, i, p, i .s)'
  ; System pushes ".s" outputs so the first listed field is on top.
  Pop $DimoT3 ; dwDrawStage
  Pop $DimoT4 ; hdc
  Pop $DimoT5 ; uItemState
  ${If} $DimoT3 != 1
    Return
  ${EndIf}
  nsDialogs::GetUserData $DimoT0
  Pop $DimoRKind
  ${NSD_GetText} $DimoT0 $DimoRText
  System::Call '*(i 0, i 0, i 0, i 0) p.s'
  Pop $DimoT6
  System::Call 'user32::GetClientRect(p $DimoT0, p $DimoT6)'
  System::Call '*$DimoT6(i, i, i .s, i .s)'
  Pop $DimoRW
  Pop $DimoRH
  System::Free $DimoT6
  StrCpy $DimoRState 0
  IntOp $DimoT6 $DimoT5 & 0x40
  ${If} $DimoT6 != 0
    IntOp $DimoRState $DimoRState | 1
  ${EndIf}
  IntOp $DimoT6 $DimoT5 & 0x01
  ${If} $DimoT6 != 0
    IntOp $DimoRState $DimoRState | 2
  ${EndIf}
  IntOp $DimoT6 $DimoT5 & 0x10
  ${If} $DimoT6 != 0
    IntOp $DimoRState $DimoRState | 4
  ${EndIf}
  IntOp $DimoT6 $DimoT5 & 0x04
  ${If} $DimoT6 != 0
    IntOp $DimoRState $DimoRState | 8
  ${EndIf}
  StrCpy $DimoRFont $DimoFontBtn
  ${If} $DimoRKind == "check"
    SendMessage $DimoT0 ${BM_GETCHECK} 0 0 $DimoT6
    ${If} $DimoT6 == ${BST_CHECKED}
      IntOp $DimoRState $DimoRState | 16
    ${EndIf}
    StrCpy $DimoRFont $DimoFontBody
  ${ElseIf} $DimoRKind == "link"
    StrCpy $DimoRFont $DimoFontBody
  ${ElseIf} $DimoRKind == "prilg"
    StrCpy $DimoRKind "pri"
    StrCpy $DimoRFont $DimoFontBtnLg
  ${EndIf}
  Push $DimoT4
  Call ${UN}DimoRender
  Pop $DimoT4
  System::Call 'gdi32::CreateCompatibleDC(p $DimoT4) p.s'
  Pop $DimoT6
  System::Call 'gdi32::SelectObject(p $DimoT6, p $DimoRBmp) p.s'
  Pop $DimoT7
  System::Call 'gdi32::BitBlt(p $DimoT4, i 0, i 0, i $DimoRW, i $DimoRH, p $DimoT6, i 0, i 0, i 0x00CC0020)'
  System::Call 'gdi32::SelectObject(p $DimoT6, p $DimoT7)'
  System::Call 'gdi32::DeleteDC(p $DimoT6)'
  System::Call 'gdi32::DeleteObject(p $DimoRBmp)'
  ${NSD_Return} 4
FunctionEnd

Function ${UN}DimoDragWindow
  Pop $DimoT0
  System::Call 'user32::ReleaseCapture()'
  SendMessage $HWNDPARENT ${WM_NCLBUTTONDOWN} 2 0
FunctionEnd

Function ${UN}DimoMinimizeWindow
  Pop $DimoT0
  ShowWindow $HWNDPARENT 6
FunctionEnd

Function ${UN}DimoCloseWindow
  Pop $DimoT0
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0)'
FunctionEnd

Function ${UN}DimoGuiEnd
  !insertmacro DimoFreeBitmap $DimoIconBmp
  !insertmacro DimoFreeBitmap $DimoIconSmBmp
  ${If} $DimoGdiToken != ""
    System::Call 'gdiplus::GdiplusShutdown(p $DimoGdiToken)'
  ${EndIf}
FunctionEnd

!macroend

!macro DimoHideItem ID
  GetDlgItem $DimoT0 $HWNDPARENT ${ID}
  ShowWindow $DimoT0 0
!macroend

!macro DimoExtractIconPair THEME BIG SMALL
  File "/oname=$PLUGINSDIR\dimo-icon.bmp" "${DIMO_INSTALLER_DIR}\assets\icon-${THEME}-${BIG}.bmp"
  File "/oname=$PLUGINSDIR\dimo-icon-sm.bmp" "${DIMO_INSTALLER_DIR}\assets\icon-${THEME}-${SMALL}.bmp"
!macroend

!macro DimoExtractIcons BIG SMALL
  ${If} $DimoTheme == "dark"
    !insertmacro DimoExtractIconPair dark ${BIG} ${SMALL}
  ${Else}
    !insertmacro DimoExtractIconPair light ${BIG} ${SMALL}
  ${EndIf}
!macroend

!endif
