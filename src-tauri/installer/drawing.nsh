; VibeX installer drawing primitives.
; Every control face (buttons, checkbox, title-bar glyphs, path field, progress
; bar, error glyph) is rendered by one function, VibeXRender, into a device-
; dependent bitmap. Owner-drawn buttons blit it during NM_CUSTOMDRAW; statics on
; the MUI instfiles page (which has no nsDialogs notify routing) show it through
; STM_SETIMAGE. Using a DDB instead of a 32bpp DIB keeps statics free of alpha
; artifacts. Shadows are never stacked: the only window shadow is the DWM one.
;
; None of these helpers touch $0-$9 / $R0-$R9, so they are safe to call from
; sections and from page callbacks that keep values in registers.
!ifndef VIBEX_INSTALLER_DRAWING
!define VIBEX_INSTALLER_DRAWING

!define /ifndef WM_NOTIFY_OUTER_NEXT 0x408
!define /ifndef PBM_GETPOS 0x0408
!define /ifndef PBM_GETRANGE 0x0407

Var VibeXGdiToken
Var VibeXFaceLatin
Var VibeXFaceUi
Var VibeXFaceMono
Var VibeXFontTitle
Var VibeXFontName
Var VibeXFontNameSm
Var VibeXFontSub
Var VibeXFontBody
Var VibeXFontBtn
Var VibeXFontBtnLg
Var VibeXFontMono
Var VibeXBorderArgb
Var VibeXBorderRef
Var VibeXHoverFgRef
; Render inputs/outputs
Var VibeXRKind
Var VibeXRText
Var VibeXRW
Var VibeXRH
Var VibeXRState   ; bit 1 hover, 2 pressed, 4 focus, 8 disabled, 16 checked, 32 error
Var VibeXRFont
Var VibeXRBmp
; Render scratch
Var VibeXT0
Var VibeXT1
Var VibeXT2
Var VibeXT3
Var VibeXT4
Var VibeXT5
Var VibeXT6
Var VibeXT7
Var VibeXT8
Var VibeXT9
Var VibeXDC
Var VibeXOldBmp
Var VibeXGfx
Var VibeXF0
Var VibeXF1
Var VibeXF2
Var VibeXF3
Var VibeXF4
Var VibeXPath
Var VibeXBrush
Var VibeXPen
Var VibeXRect
Var VibeXFillArgb
Var VibeXStrokeArgb
Var VibeXTextRef
Var VibeXInset
; Placement scratch
Var VibeXP0
Var VibeXP1
Var VibeXP2
Var VibeXP3
Var VibeXIconBmp
Var VibeXIconSmBmp
Var VibeXLogFile

!macro VibeXScale OUT VALUE
  System::Call 'kernel32::MulDiv(i ${VALUE}, i $VibeXDpi, i 96) i.s'
  Pop ${OUT}
!macroend

; Move a control using 96-DPI logical coordinates. Uses dedicated variables so
; callers' registers survive (the previous version clobbered $0-$3).
!macro VibeXPlace HWND X Y W H
  !insertmacro VibeXScale $VibeXP0 ${X}
  !insertmacro VibeXScale $VibeXP1 ${Y}
  !insertmacro VibeXScale $VibeXP2 ${W}
  !insertmacro VibeXScale $VibeXP3 ${H}
  System::Call 'user32::MoveWindow(p ${HWND}, i $VibeXP0, i $VibeXP1, i $VibeXP2, i $VibeXP3, i 1)'
!macroend

; Same, but X/W are already device pixels (measured buttons), Y/H logical.
!macro VibeXPlaceDevX HWND X Y W H
  !insertmacro VibeXScale $VibeXP1 ${Y}
  !insertmacro VibeXScale $VibeXP3 ${H}
  System::Call 'user32::MoveWindow(p ${HWND}, i ${X}, i $VibeXP1, i ${W}, i $VibeXP3, i 1)'
!macroend

!macro VibeXMakeFont OUT SIZE WEIGHT FACE
  System::Call 'kernel32::MulDiv(i -${SIZE}, i $VibeXDpi, i 96) i.s'
  Pop $VibeXT0
  System::Call 'gdi32::CreateFontW(i $VibeXT0, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "${FACE}") p.s'
  Pop ${OUT}
!macroend

; Static control created with CreateWindowEx so it works on both nsDialogs
; pages and the MUI instfiles dialog.
!macro VibeXMakeStatic OUT PARENT STYLE TEXT X Y W H
  !insertmacro VibeXScale $VibeXP0 ${X}
  !insertmacro VibeXScale $VibeXP1 ${Y}
  !insertmacro VibeXScale $VibeXP2 ${W}
  !insertmacro VibeXScale $VibeXP3 ${H}
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "${TEXT}", i ${STYLE}, i $VibeXP0, i $VibeXP1, i $VibeXP2, i $VibeXP3, p ${PARENT}, p 0, p 0, p 0) p.s'
  Pop ${OUT}
!macroend

; Rounded rectangle path. X/Y/W/H/D are device pixels (D = corner diameter).
; GDI+ REAL arguments are passed as IEEE-754 bit patterns through "i": the
; System plugin's "f" type is not reliable (it passes 0 under some hosts).
!define VIBEX_F0   0
!define VIBEX_F90  0x42B40000
!define VIBEX_F180 0x43340000
!define VIBEX_F270 0x43870000

; OUT = float bits of the non-negative integer N.
!macro VibeXFloatBits OUT N
  StrCpy $VibeXF0 ${N}
  StrCpy ${OUT} 0
  ${If} $VibeXF0 > 0
    StrCpy $VibeXF1 23
    ${DoWhile} $VibeXF0 < 0x800000
      IntOp $VibeXF0 $VibeXF0 << 1
      IntOp $VibeXF1 $VibeXF1 - 1
    ${Loop}
    ${DoWhile} $VibeXF0 >= 0x1000000
      IntOp $VibeXF0 $VibeXF0 >> 1
      IntOp $VibeXF1 $VibeXF1 + 1
    ${Loop}
    IntOp $VibeXF0 $VibeXF0 & 0x7FFFFF
    IntOp $VibeXF1 $VibeXF1 + 127
    IntOp $VibeXF1 $VibeXF1 << 23
    IntOp ${OUT} $VibeXF1 | $VibeXF0
  ${EndIf}
!macroend

!macro VibeXRoundPath X Y W H D
  System::Call 'gdiplus::GdipCreatePath(i 0, *p .s)'
  Pop $VibeXPath
  IntOp $VibeXF3 ${X} + ${W}
  IntOp $VibeXF3 $VibeXF3 - ${D}
  IntOp $VibeXF4 ${Y} + ${H}
  IntOp $VibeXF4 $VibeXF4 - ${D}
  System::Call 'gdiplus::GdipAddPathArcI(p $VibeXPath, i ${X}, i ${Y}, i ${D}, i ${D}, i ${VIBEX_F180}, i ${VIBEX_F90})'
  System::Call 'gdiplus::GdipAddPathArcI(p $VibeXPath, i $VibeXF3, i ${Y}, i ${D}, i ${D}, i ${VIBEX_F270}, i ${VIBEX_F90})'
  System::Call 'gdiplus::GdipAddPathArcI(p $VibeXPath, i $VibeXF3, i $VibeXF4, i ${D}, i ${D}, i ${VIBEX_F0}, i ${VIBEX_F90})'
  System::Call 'gdiplus::GdipAddPathArcI(p $VibeXPath, i ${X}, i $VibeXF4, i ${D}, i ${D}, i ${VIBEX_F90}, i ${VIBEX_F90})'
  System::Call 'gdiplus::GdipClosePathFigure(p $VibeXPath)'
!macroend

!macro VibeXFillPath ARGB
  System::Call 'gdiplus::GdipCreateSolidFill(i ${ARGB}, *p .s)'
  Pop $VibeXBrush
  System::Call 'gdiplus::GdipFillPath(p $VibeXGfx, p $VibeXBrush, p $VibeXPath)'
  System::Call 'gdiplus::GdipDeleteBrush(p $VibeXBrush)'
!macroend

!macro VibeXStrokePath ARGB WIDTH
  !insertmacro VibeXFloatBits $VibeXF2 ${WIDTH}
  System::Call 'gdiplus::GdipCreatePen1(i ${ARGB}, i $VibeXF2, i 2, *p .s)'
  Pop $VibeXPen
  System::Call 'gdiplus::GdipDrawPath(p $VibeXGfx, p $VibeXPen, p $VibeXPath)'
  System::Call 'gdiplus::GdipDeletePen(p $VibeXPen)'
!macroend

!macro VibeXLine ARGB WIDTH X1 Y1 X2 Y2
  !insertmacro VibeXFloatBits $VibeXF2 ${WIDTH}
  System::Call 'gdiplus::GdipCreatePen1(i ${ARGB}, i $VibeXF2, i 2, *p .s)'
  Pop $VibeXPen
  System::Call 'gdiplus::GdipSetPenStartCap(p $VibeXPen, i 2)'
  System::Call 'gdiplus::GdipSetPenEndCap(p $VibeXPen, i 2)'
  System::Call 'gdiplus::GdipDrawLineI(p $VibeXGfx, p $VibeXPen, i ${X1}, i ${Y1}, i ${X2}, i ${Y2})'
  System::Call 'gdiplus::GdipDeletePen(p $VibeXPen)'
!macroend

!macro VibeXFreeBitmap HANDLE
  ${If} ${HANDLE} != ""
  ${AndIf} ${HANDLE} != 0
    System::Call 'gdi32::DeleteObject(p ${HANDLE})'
    StrCpy ${HANDLE} 0
  ${EndIf}
!macroend

; Assign a rendered bitmap to a static and free the one it replaces.
!macro VibeXSetStaticBitmap HWND
  SendMessage ${HWND} ${STM_SETIMAGE} ${IMAGE_BITMAP} $VibeXRBmp $VibeXT0
  ${If} $VibeXT0 != 0
    System::Call 'gdi32::DeleteObject(p $VibeXT0)'
  ${EndIf}
!macroend

!macro VibeXLog TEXT
  FileOpen $VibeXLogFile "$PLUGINSDIR\install.log" a
  ${If} $VibeXLogFile != ""
    FileSeek $VibeXLogFile 0 END
    FileWriteUTF16LE $VibeXLogFile "${TEXT}$\r$\n"
    FileClose $VibeXLogFile
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; Shared functions, defined once for the installer and once ("un.") for the
; uninstaller.
; ---------------------------------------------------------------------------
!macro VIBEX_DEFINE_DRAWING UN

; Pick the first available face; returns it in $VibeXT0.
Function ${UN}VibeXProbeFace
  Pop $VibeXT1 ; fallback
  Pop $VibeXT2 ; preferred
  System::Call 'gdi32::CreateFontW(i -12, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "$VibeXT2") p.s'
  Pop $VibeXT3
  System::Call 'user32::GetDC(p 0) p.s'
  Pop $VibeXT4
  System::Call 'gdi32::SelectObject(p $VibeXT4, p $VibeXT3) p.s'
  Pop $VibeXT5
  System::Call 'gdi32::GetTextFaceW(p $VibeXT4, i 64, w .s)'
  Pop $VibeXT0
  System::Call 'gdi32::SelectObject(p $VibeXT4, p $VibeXT5)'
  System::Call 'user32::ReleaseDC(p 0, p $VibeXT4)'
  System::Call 'gdi32::DeleteObject(p $VibeXT3)'
  ${If} $VibeXT0 != $VibeXT2
    StrCpy $VibeXT0 $VibeXT1
  ${EndIf}
FunctionEnd

; Resolve DPI, theme, fonts, icons and GDI+. Called once from (un.)onGUIInit.
Function ${UN}VibeXInitResources
  !insertmacro VibeXResolveThemeMacro
  ${If} $VibeXTheme == "dark"
    IntOp $VibeXBorderArgb 0xFF474747 + 0
    StrCpy $VibeXBorderRef 0x474747
    StrCpy $VibeXHoverFgRef 0xFFFFFF
  ${Else}
    IntOp $VibeXBorderArgb 0xFFD6D6D6 + 0
    StrCpy $VibeXBorderRef 0xD6D6D6
    StrCpy $VibeXHoverFgRef 0x171717
  ${EndIf}

  System::Call 'user32::GetDC(p 0) p.s'
  Pop $VibeXT0
  System::Call 'gdi32::GetDeviceCaps(p $VibeXT0, i 88) i.s'
  Pop $VibeXDpi
  System::Call 'user32::ReleaseDC(p 0, p $VibeXT0)'
  ${If} $VibeXDpi < 96
    StrCpy $VibeXDpi 96
  ${EndIf}

  Push "${VIBEX_FONT_LATIN}"
  Push "${VIBEX_FONT_LATIN_FALLBACK}"
  Call ${UN}VibeXProbeFace
  StrCpy $VibeXFaceLatin $VibeXT0
  Push "${VIBEX_FONT_MONO}"
  Push "${VIBEX_FONT_MONO_FALLBACK}"
  Call ${UN}VibeXProbeFace
  StrCpy $VibeXFaceMono $VibeXT0
  StrCpy $VibeXFaceUi $VibeXFaceLatin
  ${If} $LANGUAGE == 2052
    StrCpy $VibeXFaceUi "${VIBEX_FONT_CJK}"
  ${EndIf}

  !insertmacro VibeXMakeFont $VibeXFontTitle 12 400 $VibeXFaceUi
  !insertmacro VibeXMakeFont $VibeXFontName 20 600 $VibeXFaceLatin
  !insertmacro VibeXMakeFont $VibeXFontNameSm 18 600 $VibeXFaceLatin
  !insertmacro VibeXMakeFont $VibeXFontSub 12 400 $VibeXFaceUi
  !insertmacro VibeXMakeFont $VibeXFontBody 13 400 $VibeXFaceUi
  !insertmacro VibeXMakeFont $VibeXFontBtn 13 600 $VibeXFaceUi
  !insertmacro VibeXMakeFont $VibeXFontBtnLg 14 600 $VibeXFaceUi
  ; GDI has no per-glyph font fallback: monospace faces (Cascadia/Consolas)
  ; lack CJK glyphs, and the detail lines mix localized text with paths.
  ${If} $LANGUAGE = 2052
    !insertmacro VibeXMakeFont $VibeXFontMono 11 400 $VibeXFaceUi
  ${Else}
    !insertmacro VibeXMakeFont $VibeXFontMono 11 400 $VibeXFaceMono
  ${EndIf}

  System::Call '*(i 1, p 0, i 0, i 0) p.s'
  Pop $VibeXT0
  System::Call 'gdiplus::GdiplusStartup(*p .s, p $VibeXT0, p 0) i.s'
  Pop $VibeXT1
  Pop $VibeXGdiToken

  System::Free $VibeXT0

  ; Logo: one bitmap per DPI bucket at an integer pixel size, never stretched.
  InitPluginsDir
  ${If} $VibeXDpi < 108
    !insertmacro VibeXExtractIcons 64 48
  ${ElseIf} $VibeXDpi < 132
    !insertmacro VibeXExtractIcons 80 60
  ${ElseIf} $VibeXDpi < 168
    !insertmacro VibeXExtractIcons 96 72
  ${Else}
    !insertmacro VibeXExtractIcons 128 96
  ${EndIf}
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\vibex-icon.bmp", i 0, i 0, i 0, i 0x10) p.s'
  Pop $VibeXIconBmp
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\vibex-icon-sm.bmp", i 0, i 0, i 0, i 0x10) p.s'
  Pop $VibeXIconSmBmp
FunctionEnd

; Frameless window chrome: size, center, DWM rounding + shadow, dark frame.
Function ${UN}VibeXSetupWindow
  HideWindow
  IntOp $VibeXT0 0x960A0000 + 0 ; WS_POPUP|WS_VISIBLE|WS_CLIPSIBLINGS|WS_SYSMENU|WS_MINIMIZEBOX
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i $VibeXT0)'
  !insertmacro VibeXScale $VibeXP2 ${VIBEX_WIN_W}
  !insertmacro VibeXScale $VibeXP3 ${VIBEX_WIN_H}
  System::Call 'user32::GetSystemMetrics(i 0) i.s'
  Pop $VibeXP0
  System::Call 'user32::GetSystemMetrics(i 1) i.s'
  Pop $VibeXP1
  IntOp $VibeXP0 $VibeXP0 - $VibeXP2
  IntOp $VibeXP0 $VibeXP0 / 2
  IntOp $VibeXP1 $VibeXP1 - $VibeXP3
  IntOp $VibeXP1 $VibeXP1 / 2
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i $VibeXP0, i $VibeXP1, i $VibeXP2, i $VibeXP3, i 0x0024)'
  ; Windows 11: DWMWA_WINDOW_CORNER_PREFERENCE (33) = DWMWCP_ROUND (2). Windows 10 ignores it.
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4)'
  ${If} $VibeXTheme == "dark"
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  ${EndIf}
  ; 1px extended frame lets DWM draw its single native shadow under a popup window.
  System::Call '*(i 1, i 1, i 1, i 1) p.s'
  Pop $VibeXT0
  System::Call 'dwmapi::DwmExtendFrameIntoClientArea(p $HWNDPARENT, p $VibeXT0)'
  System::Free $VibeXT0
  !insertmacro VibeXLabelColors $HWNDPARENT
  Call ${UN}VibeXHideOuterControls
FunctionEnd

; Hide stock MUI buttons/banners. Called on every page, not only at startup,
; because MUI re-shows Back/Next/Cancel whenever it switches pages.
Function ${UN}VibeXHideOuterControls
  !insertmacro VibeXHideItem 1
  !insertmacro VibeXHideItem 2
  !insertmacro VibeXHideItem 3
  !insertmacro VibeXHideItem 1028
  !insertmacro VibeXHideItem 1256
  !insertmacro VibeXHideItem 1034
  !insertmacro VibeXHideItem 1035
  !insertmacro VibeXHideItem 1036
  !insertmacro VibeXHideItem 1037
  !insertmacro VibeXHideItem 1038
  !insertmacro VibeXHideItem 1039
FunctionEnd

; Measure $VibeXRText in $VibeXRFont -> $VibeXRW (device px).
Function ${UN}VibeXMeasure
  System::Call 'user32::GetDC(p 0) p.s'
  Pop $VibeXT4
  System::Call 'gdi32::SelectObject(p $VibeXT4, p $VibeXRFont) p.s'
  Pop $VibeXT5
  System::Call '*(i 0, i 0) p.s'
  Pop $VibeXT6
  StrLen $VibeXT3 $VibeXRText
  System::Call 'gdi32::GetTextExtentPoint32W(p $VibeXT4, w "$VibeXRText", i $VibeXT3, p $VibeXT6)'
  System::Call '*$VibeXT6(i .s, i)'
  Pop $VibeXRW
  System::Free $VibeXT6
  System::Call 'gdi32::SelectObject(p $VibeXT4, p $VibeXT5)'
  System::Call 'user32::ReleaseDC(p 0, p $VibeXT4)'
FunctionEnd

; Width of a button control (face + focus-ring margin) for $VibeXRText/$VibeXRKind.
Function ${UN}VibeXButtonWidth
  ${If} $VibeXRFont == ""
    StrCpy $VibeXRFont $VibeXFontBtn
  ${EndIf}
  Call ${UN}VibeXMeasure
  ${If} $VibeXRKind == "ghost"
    !insertmacro VibeXScale $VibeXT0 ${VIBEX_GHOST_PAD}
  ${Else}
    !insertmacro VibeXScale $VibeXT0 ${VIBEX_BTN_PAD}
  ${EndIf}
  IntOp $VibeXRW $VibeXRW + $VibeXT0
  IntOp $VibeXRW $VibeXRW + $VibeXT0
  !insertmacro VibeXScale $VibeXT0 ${VIBEX_BTN_MIN_W}
  ${If} $VibeXRW < $VibeXT0
    StrCpy $VibeXRW $VibeXT0
  ${EndIf}
  !insertmacro VibeXScale $VibeXT0 ${VIBEX_RING}
  IntOp $VibeXRW $VibeXRW + $VibeXT0
  IntOp $VibeXRW $VibeXRW + $VibeXT0
FunctionEnd

; Render a control face. Inputs: $VibeXRKind $VibeXRText $VibeXRW $VibeXRH
; $VibeXRState $VibeXRFont. Output: $VibeXRBmp (caller owns it).
Function ${UN}VibeXRender
  System::Call 'user32::GetDC(p 0) p.s'
  Pop $VibeXT0
  System::Call 'gdi32::CreateCompatibleDC(p $VibeXT0) p.s'
  Pop $VibeXDC
  System::Call 'gdi32::CreateCompatibleBitmap(p $VibeXT0, i $VibeXRW, i $VibeXRH) p.s'
  Pop $VibeXRBmp
  System::Call 'user32::ReleaseDC(p 0, p $VibeXT0)'
  System::Call 'gdi32::SelectObject(p $VibeXDC, p $VibeXRBmp) p.s'
  Pop $VibeXOldBmp
  System::Call '*(i 0, i 0, i $VibeXRW, i $VibeXRH) p.s'
  Pop $VibeXRect

  ; Background
  StrCpy $VibeXT0 $VibeXBgRef
  ${If} $VibeXRKind == "field"
  ${OrIf} $VibeXRKind == "fieldfocus"
    StrCpy $VibeXT0 $VibeXBgRef
  ${EndIf}
  ${If} $VibeXRKind == "close"
    IntOp $VibeXT1 $VibeXRState & 3
    ${If} $VibeXT1 != 0
      StrCpy $VibeXT0 0x1C2BC4
    ${EndIf}
  ${EndIf}
  System::Call 'gdi32::CreateSolidBrush(i $VibeXT0) p.s'
  Pop $VibeXT1
  System::Call 'user32::FillRect(p $VibeXDC, p $VibeXRect, p $VibeXT1)'
  System::Call 'gdi32::DeleteObject(p $VibeXT1)'

  System::Call 'gdiplus::GdipCreateFromHDC(p $VibeXDC, *p .s) i.s'
  Pop $VibeXT1
  Pop $VibeXGfx
  System::Call 'gdiplus::GdipSetSmoothingMode(p $VibeXGfx, i 4)'
  System::Call 'gdiplus::GdipSetPixelOffsetMode(p $VibeXGfx, i 4)'

  !insertmacro VibeXScale $VibeXT9 1 ; 1 logical px (pen width)
  IntOp $VibeXT2 $VibeXRState & 1
  IntOp $VibeXT3 $VibeXRState & 2
  IntOp $VibeXT4 $VibeXRState & 4
  IntOp $VibeXT5 $VibeXRState & 8
  StrCpy $VibeXTextRef $VibeXFgRef
  StrCpy $VibeXInset 0

  ${If} $VibeXRKind == "pri"
  ${OrIf} $VibeXRKind == "sec"
  ${OrIf} $VibeXRKind == "danger"
  ${OrIf} $VibeXRKind == "ghost"
    !insertmacro VibeXScale $VibeXInset ${VIBEX_RING}
    IntOp $VibeXT0 $VibeXInset * 2
    IntOp $VibeXT6 $VibeXRW - $VibeXT0 ; body width
    IntOp $VibeXT8 $VibeXRH - $VibeXT0 ; body height
    !insertmacro VibeXScale $VibeXT1 ${VIBEX_RADIUS}
    IntOp $VibeXT1 $VibeXT1 * 2
    ${If} $VibeXT1 > $VibeXT8
      StrCpy $VibeXT1 $VibeXT8
    ${EndIf}
    StrCpy $VibeXFillArgb ""
    StrCpy $VibeXStrokeArgb ""
    ${If} $VibeXRKind == "pri"
      StrCpy $VibeXFillArgb $VibeXPriArgb
      ${If} $VibeXT2 != 0
        StrCpy $VibeXFillArgb $VibeXPriHoverArgb
      ${EndIf}
      ${If} $VibeXT3 != 0
        StrCpy $VibeXFillArgb $VibeXPriPressArgb
      ${EndIf}
      StrCpy $VibeXTextRef $VibeXPriFgRef
    ${ElseIf} $VibeXRKind == "sec"
      StrCpy $VibeXFillArgb $VibeXSecArgb
      ${If} $VibeXT2 != 0
      ${OrIf} $VibeXT3 != 0
        StrCpy $VibeXFillArgb $VibeXSecHoverArgb
      ${EndIf}
      StrCpy $VibeXStrokeArgb $VibeXBorderArgb
    ${ElseIf} $VibeXRKind == "danger"
      StrCpy $VibeXFillArgb $VibeXBgArgb
      ${If} $VibeXT2 != 0
      ${OrIf} $VibeXT3 != 0
        StrCpy $VibeXFillArgb $VibeXErrTintArgb
      ${EndIf}
      StrCpy $VibeXStrokeArgb $VibeXErrArgb
      StrCpy $VibeXTextRef $VibeXErrRef
    ${Else}
      ${If} $VibeXT2 != 0
      ${OrIf} $VibeXT3 != 0
        StrCpy $VibeXFillArgb $VibeXSecHoverArgb
      ${EndIf}
      ${If} $VibeXRText == "$(VIBEX_VIEW_LOG)"
        StrCpy $VibeXTextRef $VibeXMutRef
      ${EndIf}
    ${EndIf}
    ${If} $VibeXT5 != 0
      StrCpy $VibeXTextRef $VibeXMutRef
      ${If} $VibeXRKind == "pri"
        StrCpy $VibeXFillArgb $VibeXTrackArgb
      ${EndIf}
    ${EndIf}
    ; Body
    ${If} $VibeXFillArgb != ""
      !insertmacro VibeXRoundPath $VibeXInset $VibeXInset $VibeXT6 $VibeXT8 $VibeXT1
      !insertmacro VibeXFillPath $VibeXFillArgb
      System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    ${EndIf}
    ${If} $VibeXStrokeArgb != ""
      ; 1px hairline centered inside the body edge
      IntOp $VibeXT0 $VibeXT9 / 2
      IntOp $VibeXT0 $VibeXInset + $VibeXT0
      IntOp $VibeXT6 $VibeXT6 - $VibeXT9
      IntOp $VibeXT8 $VibeXT8 - $VibeXT9
      !insertmacro VibeXRoundPath $VibeXT0 $VibeXT0 $VibeXT6 $VibeXT8 $VibeXT1
      !insertmacro VibeXStrokePath $VibeXStrokeArgb $VibeXT9
      System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    ${EndIf}
    ; Focus ring: 2px stroke, 2px outside the body (fills the reserved margin)
    ${If} $VibeXT4 != 0
    ${AndIf} $VibeXT5 == 0
      !insertmacro VibeXScale $VibeXT0 1
      !insertmacro VibeXScale $VibeXT6 2
      IntOp $VibeXT8 $VibeXT0 * 2
      IntOp $VibeXT7 $VibeXRW - $VibeXT8
      IntOp $VibeXT8 $VibeXRH - $VibeXT8
      IntOp $VibeXT1 $VibeXT1 + $VibeXInset
      IntOp $VibeXT1 $VibeXT1 + $VibeXInset
      IntOp $VibeXT1 $VibeXT1 - $VibeXT0
      IntOp $VibeXT1 $VibeXT1 - $VibeXT0
      StrCpy $VibeXT3 $VibeXT7
      !insertmacro VibeXRoundPath $VibeXT0 $VibeXT0 $VibeXT3 $VibeXT8 $VibeXT1
      !insertmacro VibeXStrokePath $VibeXFocusArgb $VibeXT6
      System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    ${EndIf}

  ${ElseIf} $VibeXRKind == "link"
    StrCpy $VibeXTextRef $VibeXMutRef
    ${If} $VibeXT2 != 0
    ${OrIf} $VibeXT4 != 0
      StrCpy $VibeXTextRef $VibeXHoverFgRef
    ${EndIf}
    ${If} $VibeXT4 != 0
      ; underline as keyboard focus indicator for the text link
      !insertmacro VibeXScale $VibeXT0 6
      IntOp $VibeXT1 $VibeXRH - $VibeXT0
      !insertmacro VibeXScale $VibeXT0 2
      IntOp $VibeXT6 $VibeXRW - $VibeXT0
      !insertmacro VibeXLine $VibeXFocusArgb $VibeXT0 $VibeXT0 $VibeXT1 $VibeXT6 $VibeXT1
    ${EndIf}

  ${ElseIf} $VibeXRKind == "min"
  ${OrIf} $VibeXRKind == "close"
    StrCpy $VibeXT0 $VibeXMutArgb
    ${If} $VibeXRKind == "min"
      ${If} $VibeXT2 != 0
      ${OrIf} $VibeXT3 != 0
        StrCpy $VibeXFillArgb $VibeXSecHoverArgb
        System::Call 'gdiplus::GdipGraphicsClear(p $VibeXGfx, i $VibeXFillArgb)'
        StrCpy $VibeXT0 $VibeXFgArgb
      ${EndIf}
    ${Else}
      ${If} $VibeXT2 != 0
      ${OrIf} $VibeXT3 != 0
        StrCpy $VibeXT0 -1
      ${EndIf}
    ${EndIf}
    ${If} $VibeXT5 != 0
      StrCpy $VibeXT0 $VibeXHairArgb
    ${EndIf}
    IntOp $VibeXT6 $VibeXRW / 2
    IntOp $VibeXT8 $VibeXRH / 2
    !insertmacro VibeXScale $VibeXT1 5
    IntOp $VibeXP0 $VibeXT6 - $VibeXT1
    IntOp $VibeXP1 $VibeXT6 + $VibeXT1
    IntOp $VibeXP2 $VibeXT8 - $VibeXT1
    IntOp $VibeXP3 $VibeXT8 + $VibeXT1
    ${If} $VibeXRKind == "min"
      !insertmacro VibeXLine $VibeXT0 $VibeXT9 $VibeXP0 $VibeXT8 $VibeXP1 $VibeXT8
    ${Else}
      !insertmacro VibeXLine $VibeXT0 $VibeXT9 $VibeXP0 $VibeXP2 $VibeXP1 $VibeXP3
      !insertmacro VibeXLine $VibeXT0 $VibeXT9 $VibeXP0 $VibeXP3 $VibeXP1 $VibeXP2
    ${EndIf}
    ${If} $VibeXT4 != 0
      !insertmacro VibeXScale $VibeXT6 2
      IntOp $VibeXT7 $VibeXRW - $VibeXT6
      IntOp $VibeXT7 $VibeXT7 - $VibeXT6
      IntOp $VibeXT8 $VibeXRH - $VibeXT6
      IntOp $VibeXT8 $VibeXT8 - $VibeXT6
      !insertmacro VibeXScale $VibeXT1 8
      !insertmacro VibeXRoundPath $VibeXT6 $VibeXT6 $VibeXT7 $VibeXT8 $VibeXT1
      !insertmacro VibeXStrokePath $VibeXFocusArgb $VibeXT6
      System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    ${EndIf}
    StrCpy $VibeXRText ""

  ${ElseIf} $VibeXRKind == "check"
    ; 16px box (4px radius) at x=3, vertically centered; label 26px from left.
    !insertmacro VibeXScale $VibeXT6 ${VIBEX_CHECK_BOX}
    !insertmacro VibeXScale $VibeXP0 3
    IntOp $VibeXT1 $VibeXRH - $VibeXT6
    IntOp $VibeXT1 $VibeXT1 / 2
    !insertmacro VibeXScale $VibeXT8 8
    ${If} $VibeXT4 != 0
      !insertmacro VibeXScale $VibeXT0 2
      IntOp $VibeXP1 $VibeXP0 - $VibeXT0
      IntOp $VibeXP2 $VibeXT1 - $VibeXT0
      IntOp $VibeXP3 $VibeXT0 * 2
      IntOp $VibeXT3 $VibeXT8 + $VibeXP3
      IntOp $VibeXP3 $VibeXP3 + $VibeXT6
      !insertmacro VibeXRoundPath $VibeXP1 $VibeXP2 $VibeXP3 $VibeXP3 $VibeXT3
      !insertmacro VibeXStrokePath $VibeXFocusArgb $VibeXT0
      System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    ${EndIf}
    IntOp $VibeXT7 $VibeXRState & 16
    ${If} $VibeXT7 != 0
      !insertmacro VibeXRoundPath $VibeXP0 $VibeXT1 $VibeXT6 $VibeXT6 $VibeXT8
      !insertmacro VibeXFillPath $VibeXPriArgb
      System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
      ; check mark (4,8) -> (7,11) -> (12,5) in box units
      !insertmacro VibeXScale $VibeXP1 4
      IntOp $VibeXP1 $VibeXP1 + $VibeXP0
      !insertmacro VibeXScale $VibeXP2 8
      IntOp $VibeXP2 $VibeXP2 + $VibeXT1
      !insertmacro VibeXScale $VibeXP3 7
      IntOp $VibeXP3 $VibeXP3 + $VibeXP0
      !insertmacro VibeXScale $VibeXT2 11
      IntOp $VibeXT2 $VibeXT2 + $VibeXT1
      !insertmacro VibeXScale $VibeXT3 2
      !insertmacro VibeXLine $VibeXPriFgArgb $VibeXT3 $VibeXP1 $VibeXP2 $VibeXP3 $VibeXT2
      !insertmacro VibeXScale $VibeXP1 12
      IntOp $VibeXP1 $VibeXP1 + $VibeXP0
      !insertmacro VibeXScale $VibeXP2 5
      IntOp $VibeXP2 $VibeXP2 + $VibeXT1
      !insertmacro VibeXLine $VibeXPriFgArgb $VibeXT3 $VibeXP3 $VibeXT2 $VibeXP1 $VibeXP2
    ${Else}
      IntOp $VibeXT2 $VibeXT9 / 2
      IntOp $VibeXP1 $VibeXP0 + $VibeXT2
      IntOp $VibeXP2 $VibeXT1 + $VibeXT2
      IntOp $VibeXP3 $VibeXT6 - $VibeXT9
      !insertmacro VibeXRoundPath $VibeXP1 $VibeXP2 $VibeXP3 $VibeXP3 $VibeXT8
      !insertmacro VibeXStrokePath $VibeXBorderArgb $VibeXT9
      System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    ${EndIf}
    !insertmacro VibeXScale $VibeXT0 27
    System::Call '*$VibeXRect(i $VibeXT0)'

  ${ElseIf} $VibeXRKind == "field"
  ${OrIf} $VibeXRKind == "fieldfocus"
    ; Path field frame with folder glyph; focus = 2px focus-color ring.
    !insertmacro VibeXScale $VibeXT1 20 ; diameter 2*10
    StrCpy $VibeXT0 $VibeXT9
    IntOp $VibeXT6 $VibeXRW - $VibeXT9
    IntOp $VibeXT8 $VibeXRH - $VibeXT9
    IntOp $VibeXT2 $VibeXT9 / 2
    !insertmacro VibeXRoundPath $VibeXT2 $VibeXT2 $VibeXT6 $VibeXT8 $VibeXT1
    !insertmacro VibeXFillPath $VibeXFieldArgb
    ${If} $VibeXRKind == "fieldfocus"
      System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
      !insertmacro VibeXScale $VibeXT0 2
      IntOp $VibeXT2 $VibeXT0 / 2
      IntOp $VibeXT6 $VibeXRW - $VibeXT0
      IntOp $VibeXT8 $VibeXRH - $VibeXT0
      !insertmacro VibeXRoundPath $VibeXT2 $VibeXT2 $VibeXT6 $VibeXT8 $VibeXT1
      !insertmacro VibeXStrokePath $VibeXFocusArgb $VibeXT0
    ${Else}
      !insertmacro VibeXStrokePath $VibeXBorderArgb $VibeXT9
    ${EndIf}
    System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    ; folder glyph (16x12) at x=12, vertically centered
    !insertmacro VibeXScale $VibeXP0 12
    !insertmacro VibeXScale $VibeXP2 16
    !insertmacro VibeXScale $VibeXP3 12
    IntOp $VibeXP1 $VibeXRH - $VibeXP3
    IntOp $VibeXP1 $VibeXP1 / 2
    !insertmacro VibeXScale $VibeXT1 4
    !insertmacro VibeXRoundPath $VibeXP0 $VibeXP1 $VibeXP2 $VibeXP3 $VibeXT1
    !insertmacro VibeXStrokePath $VibeXMutArgb $VibeXT9
    System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    !insertmacro VibeXScale $VibeXT2 3
    IntOp $VibeXT3 $VibeXP1 + $VibeXT2
    !insertmacro VibeXScale $VibeXT2 7
    IntOp $VibeXT6 $VibeXP0 + $VibeXT2
    IntOp $VibeXT7 $VibeXP0 + $VibeXP2
    !insertmacro VibeXLine $VibeXMutArgb $VibeXT9 $VibeXP0 $VibeXT3 $VibeXT7 $VibeXT3
    StrCpy $VibeXRText ""

  ${ElseIf} $VibeXRKind == "bar"
    ; 4px rounded track + fill. $VibeXRText = permille (0-1000).
    System::Call 'gdiplus::GdipGraphicsClear(p $VibeXGfx, i $VibeXBgArgb)'
    StrCpy $VibeXT1 $VibeXRH
    !insertmacro VibeXRoundPath 0 0 $VibeXRW $VibeXRH $VibeXT1
    !insertmacro VibeXFillPath $VibeXTrackArgb
    System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    IntOp $VibeXT6 $VibeXRW * $VibeXRText
    IntOp $VibeXT6 $VibeXT6 / 1000
    ${If} $VibeXT6 > $VibeXRW
      StrCpy $VibeXT6 $VibeXRW
    ${EndIf}
    ${If} $VibeXT6 < $VibeXRH
    ${AndIf} $VibeXRText > 0
      StrCpy $VibeXT6 $VibeXRH
    ${EndIf}
    ${If} $VibeXT6 > 0
      StrCpy $VibeXFillArgb $VibeXPriArgb
      IntOp $VibeXT0 $VibeXRState & 32
      ${If} $VibeXT0 != 0
        StrCpy $VibeXFillArgb $VibeXErrArgb
      ${EndIf}
      !insertmacro VibeXRoundPath 0 0 $VibeXT6 $VibeXRH $VibeXT1
      !insertmacro VibeXFillPath $VibeXFillArgb
      System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    ${EndIf}
    StrCpy $VibeXRText ""

  ${ElseIf} $VibeXRKind == "erricon"
    ; filled circle with "!" in the error color
    System::Call 'gdiplus::GdipCreatePath(i 0, *p .s)'
    Pop $VibeXPath
    IntOp $VibeXT6 $VibeXRH - 1
    System::Call 'gdiplus::GdipAddPathEllipseI(p $VibeXPath, i 0, i 0, i $VibeXT6, i $VibeXT6)'
    !insertmacro VibeXFillPath $VibeXErrArgb
    System::Call 'gdiplus::GdipDeletePath(p $VibeXPath)'
    IntOp $VibeXT6 $VibeXRH / 2
    !insertmacro VibeXScale $VibeXT1 3
    !insertmacro VibeXScale $VibeXT2 8
    !insertmacro VibeXScale $VibeXT3 10
    !insertmacro VibeXScale $VibeXT0 2
    !insertmacro VibeXLine $VibeXBgArgb $VibeXT0 $VibeXT6 $VibeXT1 $VibeXT6 $VibeXT2
    !insertmacro VibeXLine $VibeXBgArgb $VibeXT0 $VibeXT6 $VibeXT3 $VibeXT6 $VibeXT3
    StrCpy $VibeXRText ""
  ${EndIf}

  System::Call 'gdiplus::GdipDeleteGraphics(p $VibeXGfx)'

  ${If} $VibeXRText != ""
    System::Call 'gdi32::SetBkMode(p $VibeXDC, i 1)'
    System::Call 'gdi32::SetTextColor(p $VibeXDC, i $VibeXTextRef)'
    System::Call 'gdi32::SelectObject(p $VibeXDC, p $VibeXRFont) p.s'
    Pop $VibeXT0
    ${If} $VibeXRKind == "check"
      System::Call 'user32::DrawTextW(p $VibeXDC, w "$VibeXRText", i -1, p $VibeXRect, i 0x24)'
    ${Else}
      System::Call 'user32::DrawTextW(p $VibeXDC, w "$VibeXRText", i -1, p $VibeXRect, i 0x25)'
    ${EndIf}
    System::Call 'gdi32::SelectObject(p $VibeXDC, p $VibeXT0)'
  ${EndIf}

  System::Free $VibeXRect
  System::Call 'gdi32::SelectObject(p $VibeXDC, p $VibeXOldBmp)'
  System::Call 'gdi32::DeleteDC(p $VibeXDC)'
FunctionEnd

; NM_CUSTOMDRAW handler shared by every owner-drawn nsDialogs control.
; The control kind is stored with nsDialogs::SetUserData.
Function ${UN}VibeXPaint
  Pop $VibeXT0 ; hwnd
  Pop $VibeXT1 ; code
  Pop $VibeXT2 ; NMHDR*
  ${If} $VibeXT1 != -12
    Return
  ${EndIf}
  System::Call '*$VibeXT2(p, p, i, i .s, p .s, i, i, i, i, p, i .s)'
  ; System pushes ".s" outputs so the first listed field is on top.
  Pop $VibeXT3 ; dwDrawStage
  Pop $VibeXT4 ; hdc
  Pop $VibeXT5 ; uItemState
  ${If} $VibeXT3 != 1
    Return
  ${EndIf}
  nsDialogs::GetUserData $VibeXT0
  Pop $VibeXRKind
  ${NSD_GetText} $VibeXT0 $VibeXRText
  System::Call '*(i 0, i 0, i 0, i 0) p.s'
  Pop $VibeXT6
  System::Call 'user32::GetClientRect(p $VibeXT0, p $VibeXT6)'
  System::Call '*$VibeXT6(i, i, i .s, i .s)'
  Pop $VibeXRW
  Pop $VibeXRH
  System::Free $VibeXT6
  StrCpy $VibeXRState 0
  IntOp $VibeXT6 $VibeXT5 & 0x40
  ${If} $VibeXT6 != 0
    IntOp $VibeXRState $VibeXRState | 1
  ${EndIf}
  IntOp $VibeXT6 $VibeXT5 & 0x01
  ${If} $VibeXT6 != 0
    IntOp $VibeXRState $VibeXRState | 2
  ${EndIf}
  IntOp $VibeXT6 $VibeXT5 & 0x10
  ${If} $VibeXT6 != 0
    IntOp $VibeXRState $VibeXRState | 4
  ${EndIf}
  IntOp $VibeXT6 $VibeXT5 & 0x04
  ${If} $VibeXT6 != 0
    IntOp $VibeXRState $VibeXRState | 8
  ${EndIf}
  StrCpy $VibeXRFont $VibeXFontBtn
  ${If} $VibeXRKind == "check"
    SendMessage $VibeXT0 ${BM_GETCHECK} 0 0 $VibeXT6
    ${If} $VibeXT6 == ${BST_CHECKED}
      IntOp $VibeXRState $VibeXRState | 16
    ${EndIf}
    StrCpy $VibeXRFont $VibeXFontBody
  ${ElseIf} $VibeXRKind == "link"
    StrCpy $VibeXRFont $VibeXFontBody
  ${ElseIf} $VibeXRKind == "prilg"
    StrCpy $VibeXRKind "pri"
    StrCpy $VibeXRFont $VibeXFontBtnLg
  ${EndIf}
  Push $VibeXT4
  Call ${UN}VibeXRender
  Pop $VibeXT4
  System::Call 'gdi32::CreateCompatibleDC(p $VibeXT4) p.s'
  Pop $VibeXT6
  System::Call 'gdi32::SelectObject(p $VibeXT6, p $VibeXRBmp) p.s'
  Pop $VibeXT7
  System::Call 'gdi32::BitBlt(p $VibeXT4, i 0, i 0, i $VibeXRW, i $VibeXRH, p $VibeXT6, i 0, i 0, i 0x00CC0020)'
  System::Call 'gdi32::SelectObject(p $VibeXT6, p $VibeXT7)'
  System::Call 'gdi32::DeleteDC(p $VibeXT6)'
  System::Call 'gdi32::DeleteObject(p $VibeXRBmp)'
  ${NSD_Return} 4
FunctionEnd

Function ${UN}VibeXDragWindow
  Pop $VibeXT0
  System::Call 'user32::ReleaseCapture()'
  SendMessage $HWNDPARENT ${WM_NCLBUTTONDOWN} 2 0
FunctionEnd

Function ${UN}VibeXMinimizeWindow
  Pop $VibeXT0
  ShowWindow $HWNDPARENT 6
FunctionEnd

Function ${UN}VibeXCloseWindow
  Pop $VibeXT0
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0)'
FunctionEnd

Function ${UN}VibeXGuiEnd
  !insertmacro VibeXFreeBitmap $VibeXIconBmp
  !insertmacro VibeXFreeBitmap $VibeXIconSmBmp
  ${If} $VibeXGdiToken != ""
    System::Call 'gdiplus::GdiplusShutdown(p $VibeXGdiToken)'
  ${EndIf}
FunctionEnd

!macroend

!macro VibeXHideItem ID
  GetDlgItem $VibeXT0 $HWNDPARENT ${ID}
  ShowWindow $VibeXT0 0
!macroend

!macro VibeXExtractIconPair THEME BIG SMALL
  File "/oname=$PLUGINSDIR\vibex-icon.bmp" "${VIBEX_INSTALLER_DIR}\assets\icon-${THEME}-${BIG}.bmp"
  File "/oname=$PLUGINSDIR\vibex-icon-sm.bmp" "${VIBEX_INSTALLER_DIR}\assets\icon-${THEME}-${SMALL}.bmp"
!macroend

!macro VibeXExtractIcons BIG SMALL
  ${If} $VibeXTheme == "dark"
    !insertmacro VibeXExtractIconPair dark ${BIG} ${SMALL}
  ${Else}
    !insertmacro VibeXExtractIconPair light ${BIG} ${SMALL}
  ${EndIf}
!macroend

!endif
