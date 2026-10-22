; VibeX Minimal Installer Pages (Modeled after deepseek-harness pages.nsh)
!ifndef VIBEX_INSTALLER_PAGES
!define VIBEX_INSTALLER_PAGES

!define /ifndef WM_NOTIFY_OUTER_NEXT 0x408
!define /ifndef PBM_SETBARCOLOR 0x0409
!define /ifndef PBM_SETBKCOLOR 0x2001

Var VibeXDialog
Var VibeXPhase
Var VibeXAction
Var VibeXHasExisting
Var VibeXExpanded
Var VibeXBrandImage
Var VibeXPrimaryBtn
Var VibeXSecondaryBtn
Var VibeXChooseBtn
Var VibeXBrowseBtn
Var VibeXEdit
Var VibeXEditFrame
Var VibeXLaunchCheck
Var VibeXStatusLabel
Var VibeXMinBtn
Var VibeXCloseBtn
Var VibeXInstFilesDialog
Var VibeXProgressBrandBmp
Var VibeXProgressBrandCtrl

Function VibeXGuiInit
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Return
  ${EndIf}

  !insertmacro VibeXResolveThemeMacro

  ; Hide window until initial custom page is constructed
  HideWindow

  ; Pop-up style with minimize and system menu for taskbar & DWM shadow
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i 0x960A0000)'
  System::Call 'user32::GetDC(p $HWNDPARENT) p.r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 88) i.s'
  Pop $VibeXDpi
  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'

  System::Call 'kernel32::MulDiv(i ${VIBEX_WIN_W}, i $VibeXDpi, i 96) i.s'
  Pop $VibeXWinW
  System::Call 'kernel32::MulDiv(i ${VIBEX_WIN_H}, i $VibeXDpi, i 96) i.s'
  Pop $VibeXWinH

  ; Center window on primary monitor
  System::Call 'user32::GetSystemMetrics(i 0) i.r0'
  System::Call 'user32::GetSystemMetrics(i 1) i.r1'
  IntOp $0 $0 - $VibeXWinW
  IntOp $0 $0 / 2
  IntOp $1 $1 - $VibeXWinH
  IntOp $1 $1 / 2
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r1, i $VibeXWinW, i $VibeXWinH, i 0x0024)'

  ; Enable Windows 11 rounded corners (DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2)
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4)'

  ; Hide all stock outer NSIS dialog buttons and banners
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1034
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1036
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1037
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1038
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 0

  !insertmacro VibeXControlColors $HWNDPARENT

  ; Extract brand bitmaps into $PLUGINSDIR
  InitPluginsDir
  File "/oname=$PLUGINSDIR\brand-light.bmp" "${VIBEX_INSTALLER_DIR}\assets\brand-light.bmp"
  File "/oname=$PLUGINSDIR\brand-light-2x.bmp" "${VIBEX_INSTALLER_DIR}\assets\brand-light-2x.bmp"
  File "/oname=$PLUGINSDIR\brand-dark.bmp" "${VIBEX_INSTALLER_DIR}\assets\brand-dark.bmp"
  File "/oname=$PLUGINSDIR\brand-dark-2x.bmp" "${VIBEX_INSTALLER_DIR}\assets\brand-dark-2x.bmp"
FunctionEnd

Function VibeXDetectExisting
  StrCpy $VibeXHasExisting 0
  StrCpy $0 0
  vibex_wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" vibex_wix_done
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 vibex_wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 vibex_wix_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    StrCpy $VibeXHasExisting 1
    Return
  vibex_wix_done:

  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} "$R0$R1" != ""
    StrCpy $VibeXHasExisting 1
  ${EndIf}
FunctionEnd

Function VibeXPageWelcomeOrMaintain
  Call VibeXDetectExisting

  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    StrCpy $VibeXAction "install"
    ${If} $VibeXHasExisting = 1
      StrCpy $VibeXAction "reinstall"
    ${EndIf}
    Abort
  ${EndIf}

  ${If} $VibeXHasExisting = 1
    StrCpy $VibeXPhase "existing"
    StrCpy $VibeXAction "reinstall"
  ${Else}
    StrCpy $VibeXPhase "welcome"
    StrCpy $VibeXAction "install"
  ${EndIf}

  Call VibeXCreateInteractivePage
FunctionEnd

Function VibeXPageWelcomeLeave
  ${If} $VibeXPhase == "welcome"
    ${NSD_GetText} $VibeXEdit $INSTDIR
    ${If} $INSTDIR == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(VIBEX_PATH_INVALID)"
      Abort
    ${EndIf}
  ${EndIf}

  ; If reinstalling over a previous WiX MSI installation, remove the old MSI first
  ${If} $VibeXAction == "reinstall"
  ${AndIf} $WixMode = 1
    ReadRegStr $R1 HKLM "$R6" "UninstallString"
    ${If} $R1 != ""
      HideWindow
      ExecWait '$R1' $0
      BringToFront
    ${EndIf}
  ${EndIf}
FunctionEnd

Function VibeXPageFinish
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    Abort
  ${EndIf}

  StrCpy $VibeXPhase "finish"
  Call VibeXCreateInteractivePage
FunctionEnd

Function VibeXPageFinishLeave
  ${If} $VibeXAction != "uninstall"
    ${NSD_GetState} $VibeXLaunchCheck $0
    HideWindow
    ${If} $0 == ${BST_CHECKED}
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    ${EndIf}
  ${EndIf}
FunctionEnd

Function VibeXCreateInteractivePage
  nsDialogs::Create 1018
  Pop $VibeXDialog
  ${If} $VibeXDialog == error
    Abort
  ${EndIf}

  !insertmacro VibeXPlace $VibeXDialog 0 0 ${VIBEX_WIN_W} ${VIBEX_WIN_H}
  !insertmacro VibeXControlColors $HWNDPARENT
  !insertmacro VibeXControlColors $VibeXDialog
  !insertmacro VibeXPixelFont $VibeXFont ${VIBEX_BTN_FONT_SIZE} 600
  !insertmacro VibeXPixelFont $VibeXSmallFont ${VIBEX_SMALL_FONT_SIZE} 400

  System::Call '*(i 1, p 0, i 0, i 0) p.r0'
  System::Call 'gdiplus::GdiplusStartup(*p .r1, p r0, p 0) i.r2'
  StrCpy $VibeXGdiToken $1
  System::Free $0

  ; Top draggable region + Minimize & Close controls
  ${NSD_CreateLabel} 0 0 0 0 ""
  Pop $4
  !insertmacro VibeXPlace $4 0 0 396 44
  ${NSD_AddStyle} $4 ${SS_NOTIFY}
  ${NSD_OnClick} $4 VibeXDragWindow
  !insertmacro VibeXControlColors $4

  ${NSD_CreateButton} 0 0 0 0 "−"
  Pop $VibeXMinBtn
  !insertmacro VibeXPlace $VibeXMinBtn 396 8 36 28
  ${NSD_OnClick} $VibeXMinBtn VibeXMinimizeWindow
  ${NSD_OnNotify} $VibeXMinBtn VibeXPaintButton

  ${NSD_CreateButton} 0 0 0 0 "×"
  Pop $VibeXCloseBtn
  !insertmacro VibeXPlace $VibeXCloseBtn 436 8 36 28
  ${NSD_OnClick} $VibeXCloseBtn VibeXCloseWindow
  ${NSD_OnNotify} $VibeXCloseBtn VibeXPaintButton

  ; Centered Brand Lockup (Logo on top + VibeX text below)
  ${NSD_CreateBitmap} 0 0 0 0 ""
  Pop $4
  !insertmacro VibeXPlace $4 0 ${VIBEX_BRAND_Y} ${VIBEX_WIN_W} ${VIBEX_BRAND_H}
  StrCpy $5 "brand-light"
  ${If} $VibeXTheme == "dark"
    StrCpy $5 "brand-dark"
  ${EndIf}
  ${If} $VibeXDpi <= 96
    ${NSD_SetStretchedImage} $4 "$PLUGINSDIR\$5.bmp" $VibeXBrandImage
  ${Else}
    ${NSD_SetStretchedImage} $4 "$PLUGINSDIR\$5-2x.bmp" $VibeXBrandImage
  ${EndIf}

  ; Status / Path Caption Label (used in Existing & Uninstall Finish views)
  ${NSD_CreateLabel} 0 0 0 0 "$INSTDIR"
  Pop $VibeXStatusLabel
  !insertmacro VibeXPlace $VibeXStatusLabel 44 278 392 22
  ${NSD_AddStyle} $VibeXStatusLabel ${SS_CENTER}|${SS_CENTERIMAGE}
  SendMessage $VibeXStatusLabel ${WM_SETFONT} $VibeXSmallFont 1
  !insertmacro VibeXMutedControlColors $VibeXStatusLabel

  ; Welcome: "选择安装位置" Ghost Button
  ${NSD_CreateButton} 0 0 0 0 "$(VIBEX_CHOOSE_PATH)"
  Pop $VibeXChooseBtn
  !insertmacro VibeXPlace $VibeXChooseBtn 172 274 136 28
  ${NSD_OnClick} $VibeXChooseBtn VibeXExpandPath
  ${NSD_OnNotify} $VibeXChooseBtn VibeXPaintButton

  ; Welcome: Expanded Path Edit Frame + Input + Browse Button
  ${NSD_CreateBitmap} 0 0 0 0 ""
  Pop $VibeXEditFrame
  !insertmacro VibeXPlace $VibeXEditFrame 44 ${VIBEX_ROW_A_Y} 316 34
  !insertmacro VibeXDrawEditFrameMacro $VibeXEditFrame

  ${NSD_CreateText} 0 0 0 0 "$INSTDIR"
  Pop $VibeXEdit
  System::Call 'user32::GetWindowLongW(p $VibeXEdit, i -16) i.r0'
  IntOp $0 $0 & 0xFF7FFFFF
  System::Call 'user32::SetWindowLongW(p $VibeXEdit, i -16, i r0)'
  System::Call 'user32::GetWindowLongW(p $VibeXEdit, i -20) i.r0'
  IntOp $0 $0 & 0xFFFFFDFF
  System::Call 'user32::SetWindowLongW(p $VibeXEdit, i -20, i r0)'
  SendMessage $VibeXEdit ${WM_SETFONT} $VibeXSmallFont 1
  !insertmacro VibeXPlace $VibeXEdit 54 279 296 20
  System::Call 'user32::SetWindowPos(p $VibeXEdit, p 0, i 0, i 0, i 0, i 0, i 0x33)'
  SendMessage $VibeXEdit ${EM_SETLIMITTEXT} 240 0
  !insertmacro VibeXControlColors $VibeXEdit

  ${NSD_CreateButton} 0 0 0 0 "$(VIBEX_BROWSE)"
  Pop $VibeXBrowseBtn
  !insertmacro VibeXPlace $VibeXBrowseBtn 368 ${VIBEX_ROW_A_Y} 68 34
  ${NSD_OnClick} $VibeXBrowseBtn VibeXBrowsePath
  ${NSD_OnNotify} $VibeXBrowseBtn VibeXPaintButton

  ; Finish: "立即启动" Custom Checkbox
  ${NSD_CreateCheckbox} 0 0 0 0 "$(VIBEX_LAUNCH_NOW)"
  Pop $VibeXLaunchCheck
  SendMessage $VibeXLaunchCheck ${WM_SETFONT} $VibeXSmallFont 1
  !insertmacro VibeXPlace $VibeXLaunchCheck 188 274 108 28
  !insertmacro VibeXControlColors $VibeXLaunchCheck
  ${NSD_OnNotify} $VibeXLaunchCheck VibeXPaintCheckbox
  ${NSD_Check} $VibeXLaunchCheck

  ; Primary Action Button (Install Now / Reinstall / Finish)
  ${NSD_CreateButton} 0 0 0 0 "$(VIBEX_INSTALL_NOW)"
  Pop $VibeXPrimaryBtn
  !insertmacro VibeXPlace $VibeXPrimaryBtn 180 ${VIBEX_ROW_B_Y} ${VIBEX_BTN_W} ${VIBEX_BTN_H}
  SendMessage $VibeXPrimaryBtn ${WM_SETFONT} $VibeXFont 1
  ${NSD_OnClick} $VibeXPrimaryBtn VibeXOnPrimaryClick
  ${NSD_OnNotify} $VibeXPrimaryBtn VibeXPaintButton

  ; Secondary Action Button (Uninstall on Existing installation view)
  ${NSD_CreateButton} 0 0 0 0 "$(VIBEX_UNINSTALL)"
  Pop $VibeXSecondaryBtn
  !insertmacro VibeXPlace $VibeXSecondaryBtn 246 ${VIBEX_ROW_B_Y} ${VIBEX_BTN_W} ${VIBEX_BTN_H}
  SendMessage $VibeXSecondaryBtn ${WM_SETFONT} $VibeXFont 1
  ${NSD_OnClick} $VibeXSecondaryBtn VibeXOnSecondaryClick
  ${NSD_OnNotify} $VibeXSecondaryBtn VibeXPaintButton

  Call VibeXRenderPhase
  ShowWindow $VibeXDialog 5
  ShowWindow $HWNDPARENT 5
  nsDialogs::Show

  ${NSD_FreeImage} $VibeXBrandImage
  ${NSD_FreeImage} $VibeXEditFrameBitmap
  System::Call 'gdiplus::GdiplusShutdown(p $VibeXGdiToken)'
  System::Call 'gdi32::DeleteObject(p $VibeXFont)'
  System::Call 'gdi32::DeleteObject(p $VibeXSmallFont)'
FunctionEnd

Function VibeXRenderPhase
  ShowWindow $VibeXStatusLabel 0
  ShowWindow $VibeXChooseBtn 0
  ShowWindow $VibeXEditFrame 0
  ShowWindow $VibeXEdit 0
  ShowWindow $VibeXBrowseBtn 0
  ShowWindow $VibeXLaunchCheck 0
  ShowWindow $VibeXSecondaryBtn 0

  ${If} $VibeXPhase == "welcome"
    ${NSD_SetText} $VibeXPrimaryBtn "$(VIBEX_INSTALL_NOW)"
    !insertmacro VibeXPlace $VibeXPrimaryBtn 180 ${VIBEX_ROW_B_Y} ${VIBEX_BTN_W} ${VIBEX_BTN_H}
    ${If} $VibeXExpanded == 1
      ShowWindow $VibeXEditFrame 5
      ShowWindow $VibeXEdit 5
      ShowWindow $VibeXBrowseBtn 5
    ${Else}
      ShowWindow $VibeXChooseBtn 5
    ${EndIf}
  ${ElseIf} $VibeXPhase == "existing"
    ${NSD_SetText} $VibeXStatusLabel "$INSTDIR"
    ShowWindow $VibeXStatusLabel 5
    ${NSD_SetText} $VibeXPrimaryBtn "$(VIBEX_REINSTALL)"
    !insertmacro VibeXPlace $VibeXPrimaryBtn 114 ${VIBEX_ROW_B_Y} ${VIBEX_BTN_W} ${VIBEX_BTN_H}
    ShowWindow $VibeXSecondaryBtn 5
  ${ElseIf} $VibeXPhase == "finish"
    ${NSD_SetText} $VibeXPrimaryBtn "$(VIBEX_FINISH)"
    !insertmacro VibeXPlace $VibeXPrimaryBtn 180 ${VIBEX_ROW_B_Y} ${VIBEX_BTN_W} ${VIBEX_BTN_H}
    ${If} $VibeXAction == "uninstall"
      ${NSD_SetText} $VibeXStatusLabel "$(VIBEX_UNINSTALLED_DONE)"
      ShowWindow $VibeXStatusLabel 5
    ${Else}
      ShowWindow $VibeXLaunchCheck 5
    ${EndIf}
  ${EndIf}
FunctionEnd

Function VibeXExpandPath
  Pop $0
  StrCpy $VibeXExpanded 1
  Call VibeXRenderPhase
  SendMessage $VibeXEdit ${EM_SETSEL} 0 0
  System::Call 'user32::SetFocus(p $VibeXEdit)'
FunctionEnd

Function VibeXBrowsePath
  Pop $0
  ${NSD_GetText} $VibeXEdit $INSTDIR
  nsDialogs::SelectFolderDialog "$(VIBEX_CHOOSE_PATH)" "$INSTDIR"
  Pop $0
  ${If} $0 != "error"
    StrCpy $INSTDIR "$0"
    ${NSD_SetText} $VibeXEdit "$0"
  ${EndIf}
FunctionEnd

Function VibeXOnPrimaryClick
  Pop $0
  ${If} $VibeXPhase == "existing"
    StrCpy $VibeXAction "reinstall"
  ${EndIf}
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

Function VibeXOnSecondaryClick
  Pop $0
  StrCpy $VibeXAction "uninstall"
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

Function VibeXDragWindow
  Pop $0
  System::Call 'user32::ReleaseCapture()'
  SendMessage $HWNDPARENT ${WM_NCLBUTTONDOWN} 2 0
FunctionEnd

Function VibeXMinimizeWindow
  Pop $0
  ShowWindow $HWNDPARENT 6
FunctionEnd

Function VibeXCloseWindow
  Pop $0
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_CLOSE}, p 0, p 0)'
FunctionEnd

; Custom owner-draw button handler (NM_CUSTOMDRAW = -12)
Function VibeXPaintButton
  Pop $R0
  Pop $R1
  Pop $R2
  ${If} $R1 != -12
    Return
  ${EndIf}
  System::Call '*$R2(p, p, i, i .R3, p .R4, i .R5, i .R6, i .R7, i .R8, p, i .R9)'
  ${If} $R3 != 1
    Return
  ${EndIf}
  System::Call 'gdi32::SaveDC(p R4)'
  System::Alloc 16
  Pop $R2
  System::Call 'user32::GetClientRect(p R0, p R2)'
  System::Call 'gdi32::CreateSolidBrush(i $VibeXBgColorref) p.R3'
  System::Call 'user32::FillRect(p R4, p R2, p R3)'
  System::Call 'gdi32::DeleteObject(p R3)'

  StrCpy $R3 $VibeXBgArgb
  ${If} $R0 == $VibeXPrimaryBtn
    StrCpy $R3 $VibeXPrimaryArgb
    IntOp $R1 $R9 & 64
    ${If} $R1 != 0
      StrCpy $R3 $VibeXPrimaryHoverArgb
    ${EndIf}
    IntOp $R1 $R9 & 1
    ${If} $R1 != 0
      StrCpy $R3 $VibeXPrimaryPressedArgb
    ${EndIf}
  ${Else}
    IntOp $R1 $R9 & 65
    ${If} $R1 != 0
      StrCpy $R3 $VibeXControlHoverArgb
    ${EndIf}
  ${EndIf}

  System::Call 'gdiplus::GdipCreateSolidFill(i R3, *p .R1)'
  System::Call 'gdiplus::GdipCreateFromHDC(p R4, *p .R5)'
  System::Call 'gdiplus::GdipSetSmoothingMode(p R5, i 4)'
  System::Call 'gdiplus::GdipSetPixelOffsetMode(p R5, i 4)'
  System::Call 'kernel32::MulDiv(i ${VIBEX_BTN_RADIUS}, i $VibeXDpi, i 96) i.R3'
  ${If} $R0 == $VibeXBrowseBtn
  ${OrIf} $R0 == $VibeXChooseBtn
  ${OrIf} $R0 == $VibeXMinBtn
  ${OrIf} $R0 == $VibeXCloseBtn
    System::Call 'kernel32::MulDiv(i ${VIBEX_SMALL_RADIUS}, i $VibeXDpi, i 96) i.R3'
  ${EndIf}
  !insertmacro VibeXRoundPath $R6 $R7 $R8 $R3
  System::Call 'gdiplus::GdipFillPath(p R5, p R1, p R6)'

  ${If} $R0 == $VibeXBrowseBtn
  ${OrIf} $R0 == $VibeXSecondaryBtn
    System::Call 'gdiplus::GdipCreatePen1(i $VibeXBorderArgb, i 0x3F800000, i 2, *p .r2)'
    System::Call 'gdiplus::GdipDrawPath(p R5, p r2, p R6)'
    System::Call 'gdiplus::GdipDeletePen(p r2)'
  ${EndIf}

  System::Call 'gdiplus::GdipDeletePath(p R6)'
  System::Call 'gdiplus::GdipDeleteGraphics(p R5)'
  System::Call 'gdiplus::GdipDeleteBrush(p R1)'
  System::Call 'gdi32::SetBkMode(p R4, i 1)'

  ${If} $R0 == $VibeXPrimaryBtn
    System::Call 'gdi32::SetTextColor(p R4, i $VibeXButtonTextColorref)'
  ${ElseIf} $R0 == $VibeXChooseBtn
    System::Call 'gdi32::SetTextColor(p R4, i $VibeXMutedColorref)'
  ${Else}
    System::Call 'gdi32::SetTextColor(p R4, i $VibeXTextColorref)'
  ${EndIf}

  System::Call 'gdi32::SelectObject(p R4, p $VibeXFont)'
  ${If} $R0 == $VibeXChooseBtn
  ${OrIf} $R0 == $VibeXBrowseBtn
    System::Call 'gdi32::SelectObject(p R4, p $VibeXSmallFont)'
  ${EndIf}

  ${NSD_GetText} $R0 $R3
  System::Call 'user32::DrawTextW(p R4, w R3, i -1, p R2, i 0x25)'
  System::Call 'gdi32::RestoreDC(p R4, i -1)'
  System::Free $R2
  ${NSD_Return} 4
FunctionEnd

; Custom owner-draw checkbox handler (18x18 rounded 6px box + checkmark)
Function VibeXPaintCheckbox
  Pop $R0
  Pop $R1
  Pop $R2
  ${If} $R1 != -12
    Return
  ${EndIf}
  System::Call '*$R2(p, p, i, i .R3, p .R4, i, i, i, i, p, i .R9)'
  ${If} $R3 != 1
    Return
  ${EndIf}
  System::Call 'gdi32::SaveDC(p R4)'
  System::Alloc 16
  Pop $R2
  System::Call 'user32::GetClientRect(p R0, p R2)'
  System::Call 'gdi32::CreateSolidBrush(i $VibeXBgColorref) p.R3'
  System::Call 'user32::FillRect(p R4, p R2, p R3)'
  System::Call 'gdi32::DeleteObject(p R3)'
  System::Call 'kernel32::MulDiv(i 6, i $VibeXDpi, i 96) i.r2'
  System::Call 'kernel32::MulDiv(i 5, i $VibeXDpi, i 96) i.r3'
  System::Call 'gdi32::SetViewportOrgEx(p R4, i r2, i r3, p 0)'
  System::Call 'gdiplus::GdipCreateFromHDC(p R4, *p .R5)'
  System::Call 'gdiplus::GdipSetSmoothingMode(p R5, i 4)'
  System::Call 'kernel32::MulDiv(i 18, i $VibeXDpi, i 96) i.R7'
  StrCpy $R8 $R7
  System::Call 'kernel32::MulDiv(i 6, i $VibeXDpi, i 96) i.R3'
  !insertmacro VibeXRoundPath $R6 $R7 $R8 $R3
  ${NSD_GetState} $R0 $R8
  StrCpy $R3 $VibeXBgArgb
  ${If} $R8 == ${BST_CHECKED}
    StrCpy $R3 $VibeXPrimaryArgb
  ${EndIf}
  System::Call 'gdiplus::GdipCreateSolidFill(i R3, *p .R1)'
  System::Call 'gdiplus::GdipFillPath(p R5, p R1, p R6)'
  System::Call 'gdiplus::GdipDeleteBrush(p R1)'
  ${If} $R8 != ${BST_CHECKED}
    System::Call 'gdiplus::GdipCreatePen1(i $VibeXBorderArgb, i 0x3F800000, i 2, *p .R1)'
    System::Call 'gdiplus::GdipDrawPath(p R5, p R1, p R6)'
    System::Call 'gdiplus::GdipDeletePen(p R1)'
  ${EndIf}
  System::Call 'gdiplus::GdipDeletePath(p R6)'
  System::Call 'gdiplus::GdipDeleteGraphics(p R5)'
  ${If} $R8 == ${BST_CHECKED}
    System::Call 'kernel32::MulDiv(i 2, i $VibeXDpi, i 96) i.r0'
    System::Call 'gdi32::CreatePen(i 0, i r0, i $VibeXButtonTextColorref) p.R1'
    System::Call 'gdi32::SelectObject(p R4, p R1) p.R3'
    System::Call 'kernel32::MulDiv(i 4, i $VibeXDpi, i 96) i.r0'
    System::Call 'kernel32::MulDiv(i 9, i $VibeXDpi, i 96) i.r1'
    System::Call 'gdi32::MoveToEx(p R4, i r0, i r1, p 0)'
    System::Call 'kernel32::MulDiv(i 8, i $VibeXDpi, i 96) i.r0'
    System::Call 'kernel32::MulDiv(i 13, i $VibeXDpi, i 96) i.r1'
    System::Call 'gdi32::LineTo(p R4, i r0, i r1)'
    System::Call 'kernel32::MulDiv(i 14, i $VibeXDpi, i 96) i.r0'
    System::Call 'kernel32::MulDiv(i 5, i $VibeXDpi, i 96) i.r1'
    System::Call 'gdi32::LineTo(p R4, i r0, i r1)'
    System::Call 'gdi32::SelectObject(p R4, p R3)'
    System::Call 'gdi32::DeleteObject(p R1)'
  ${EndIf}
  System::Call 'gdi32::SetViewportOrgEx(p R4, i 0, i 0, p 0)'
  System::Call 'kernel32::MulDiv(i 30, i $VibeXDpi, i 96) i.r0'
  System::Call '*$R2(i r0)'
  System::Call 'gdi32::SetBkMode(p R4, i 1)'
  System::Call 'gdi32::SetTextColor(p R4, i $VibeXTextColorref)'
  System::Call 'gdi32::SelectObject(p R4, p $VibeXSmallFont)'
  System::Call 'user32::DrawTextW(p R4, w "$(VIBEX_LAUNCH_NOW)", i -1, p R2, i 0x24)'
  System::Call 'gdi32::RestoreDC(p R4, i -1)'
  System::Free $R2
  ${NSD_Return} 4
FunctionEnd

; Customize the MUI_PAGE_INSTFILES progress view to match the minimal canvas
Function VibeXInstFilesShow
  SetAutoClose true
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Return
  ${EndIf}

  FindWindow $VibeXInstFilesDialog "#32770" "" $HWNDPARENT
  !insertmacro VibeXPlace $VibeXInstFilesDialog 0 0 ${VIBEX_WIN_W} ${VIBEX_WIN_H}
  !insertmacro VibeXControlColors $HWNDPARENT
  !insertmacro VibeXControlColors $VibeXInstFilesDialog
  !insertmacro VibeXPixelFont $VibeXSmallFont ${VIBEX_SMALL_FONT_SIZE} 400

  ; Hide stock Details button (1027) and Details ListView (1016)
  GetDlgItem $0 $VibeXInstFilesDialog 1027
  ShowWindow $0 0
  GetDlgItem $0 $VibeXInstFilesDialog 1016
  ShowWindow $0 0

  ; Place centered Brand Lockup (Logo + VibeX text below) at exact same Y coordinate
  System::Call 'kernel32::MulDiv(i 0, i $VibeXDpi, i 96) i.r0'
  System::Call 'kernel32::MulDiv(i ${VIBEX_BRAND_Y}, i $VibeXDpi, i 96) i.r1'
  System::Call 'kernel32::MulDiv(i ${VIBEX_WIN_W}, i $VibeXDpi, i 96) i.r2'
  System::Call 'kernel32::MulDiv(i ${VIBEX_BRAND_H}, i $VibeXDpi, i 96) i.r3'
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5000000E, i r0, i r1, i r2, i r3, p $VibeXInstFilesDialog, p 0, p 0, p 0) p.s'
  Pop $VibeXProgressBrandCtrl
  StrCpy $5 "brand-light"
  ${If} $VibeXTheme == "dark"
    StrCpy $5 "brand-dark"
  ${EndIf}
  ${If} $VibeXDpi <= 96
    ${NSD_SetStretchedImage} $VibeXProgressBrandCtrl "$PLUGINSDIR\$5.bmp" $VibeXProgressBrandBmp
  ${Else}
    ${NSD_SetStretchedImage} $VibeXProgressBrandCtrl "$PLUGINSDIR\$5-2x.bmp" $VibeXProgressBrandBmp
  ${EndIf}

  ; Style and place the 6px slim progress bar
  GetDlgItem $0 $VibeXInstFilesDialog 1004
  !insertmacro VibeXPlace $0 ${VIBEX_PROGRESS_X} ${VIBEX_PROGRESS_Y} ${VIBEX_PROGRESS_W} ${VIBEX_PROGRESS_H}
  System::Call 'uxtheme::SetWindowTheme(p $0, w "", w "")'
  ; Remove sunken 3D border (WS_EX_STATICEDGE)
  System::Call 'user32::GetWindowLongW(p $0, i -20) i.r1'
  IntOp $1 $1 & 0xFFFDFFFF
  System::Call 'user32::SetWindowLongW(p $0, i -20, i r1)'
  SendMessage $0 ${PBM_SETBKCOLOR} 0 $VibeXTrackColorref
  SendMessage $0 ${PBM_SETBARCOLOR} 0 $VibeXPrimaryColorref

  ; Style and center the single-line stage status caption below the progress bar
  GetDlgItem $0 $VibeXInstFilesDialog 1006
  System::Call 'user32::GetWindowLongW(p $0, i -16) i.r1'
  IntOp $1 $1 | 1 ; SS_CENTER
  System::Call 'user32::SetWindowLongW(p $0, i -16, i r1)'
  !insertmacro VibeXPlace $0 ${VIBEX_PROGRESS_X} ${VIBEX_STATUS_Y} ${VIBEX_PROGRESS_W} ${VIBEX_STATUS_H}
  SendMessage $0 ${WM_SETFONT} $VibeXSmallFont 1
  !insertmacro VibeXControlColors $0
  ${If} $VibeXAction == "uninstall"
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VIBEX_PROGRESS_UNINSTALL)"
  ${Else}
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(VIBEX_PROGRESS_PREPARE)"
  ${EndIf}

  ShowWindow $HWNDPARENT 5
FunctionEnd

Function VibeXInstFilesLeave
  ${If} $VibeXProgressBrandBmp != 0
    ${NSD_FreeImage} $VibeXProgressBrandBmp
    StrCpy $VibeXProgressBrandBmp 0
  ${EndIf}
  ${If} $VibeXSmallFont != 0
    System::Call 'gdi32::DeleteObject(p $VibeXSmallFont)'
    StrCpy $VibeXSmallFont 0
  ${EndIf}
FunctionEnd

!macro VibeXSetStageCaption TEXT_LANG_STR
  ${If} $PassiveMode <> 1
  ${AndIfNot} ${Silent}
    ${If} $VibeXInstFilesDialog != 0
      GetDlgItem $0 $VibeXInstFilesDialog 1006
      ${If} $0 != 0
        SendMessage $0 ${WM_SETTEXT} 0 "STR:${TEXT_LANG_STR}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!endif
