; GDI+ Antialiased Controls for VibeX Minimal NSIS Installer
!ifndef VIBEX_INSTALLER_DRAWING
!define VIBEX_INSTALLER_DRAWING

Var VibeXGdiToken
Var VibeXEditFrameBitmap
Var VibeXFont
Var VibeXSmallFont

!macro VibeXPlace HWND X Y W H
  System::Call 'kernel32::MulDiv(i ${X}, i $VibeXDpi, i 96) i.r0'
  System::Call 'kernel32::MulDiv(i ${Y}, i $VibeXDpi, i 96) i.r1'
  System::Call 'kernel32::MulDiv(i ${W}, i $VibeXDpi, i 96) i.r2'
  System::Call 'kernel32::MulDiv(i ${H}, i $VibeXDpi, i 96) i.r3'
  System::Call 'user32::MoveWindow(p ${HWND}, i r0, i r1, i r2, i r3, i 1)'
!macroend

!macro VibeXPixelFont HANDLE SIZE WEIGHT
  System::Call 'kernel32::MulDiv(i -${SIZE}, i $VibeXDpi, i 96) i.r0'
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "${VIBEX_FONT_NAME}") p.s'
  Pop ${HANDLE}
!macroend

; Produces a closed rounded rectangle in GDI+. Inputs and output must not use $0/$1.
!macro VibeXRoundPath PATH WIDTH HEIGHT DIAMETER
  System::Call 'gdiplus::GdipCreatePath(i 0, *p .s)'
  Pop ${PATH}
  IntOp $0 ${WIDTH} - ${DIAMETER}
  IntOp $1 ${HEIGHT} - ${DIAMETER}
  System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i 0, i 0, i ${DIAMETER}, i ${DIAMETER}, i 0x43340000, i 0x42B40000)'
  System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i r0, i 0, i ${DIAMETER}, i ${DIAMETER}, i 0x43870000, i 0x42B40000)'
  System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i r0, i r1, i ${DIAMETER}, i ${DIAMETER}, i 0, i 0x42B40000)'
  System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i 0, i r1, i ${DIAMETER}, i ${DIAMETER}, i 0x42B40000, i 0x42B40000)'
  System::Call 'gdiplus::GdipClosePathFigure(p ${PATH})'
!macroend

!macro VibeXDrawEditFrameMacro FRAME_HWND
  System::Call 'kernel32::MulDiv(i 316, i $VibeXDpi, i 96) i.R7'
  System::Call 'kernel32::MulDiv(i 34, i $VibeXDpi, i 96) i.R8'
  System::Call 'kernel32::MulDiv(i ${VIBEX_SMALL_RADIUS}, i $VibeXDpi, i 96) i.R3'
  System::Call 'gdiplus::GdipCreateBitmapFromScan0(i R7, i R8, i 0, i 0x26200A, p 0, *p .R5)'
  System::Call 'gdiplus::GdipGetImageGraphicsContext(p R5, *p .R4)'
  System::Call 'gdiplus::GdipGraphicsClear(p R4, i $VibeXBgArgb)'
  System::Call 'gdiplus::GdipSetSmoothingMode(p R4, i 4)'
  IntOp $R7 $R7 - 1
  IntOp $R8 $R8 - 1
  !insertmacro VibeXRoundPath $R6 $R7 $R8 $R3
  System::Call 'gdiplus::GdipCreatePen1(i $VibeXBorderArgb, i 0x3F800000, i 2, *p .R1)'
  System::Call 'gdiplus::GdipDrawPath(p R4, p R1, p R6)'
  System::Call 'gdiplus::GdipCreateHBITMAPFromBitmap(p R5, *p .s, i $VibeXBgArgb)'
  Pop $VibeXEditFrameBitmap
  SendMessage ${FRAME_HWND} ${STM_SETIMAGE} ${IMAGE_BITMAP} $VibeXEditFrameBitmap
  System::Call 'gdiplus::GdipDeletePen(p R1)'
  System::Call 'gdiplus::GdipDeletePath(p R6)'
  System::Call 'gdiplus::GdipDeleteGraphics(p R4)'
  System::Call 'gdiplus::GdipDisposeImage(p R5)'
!macroend

!endif
