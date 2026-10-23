; VibeX installer & uninstaller pages.
;
; Installer:   [welcome | custom location | existing install]  -> progress (+error) -> finish
; Uninstaller: confirm -> progress -> finish
;
; Every view lives on a 520x400 (96-DPI logical) frameless window with a 40px
; title bar. nsDialogs pages use owner-drawn buttons (NM_CUSTOMDRAW); the MUI
; instfiles page is restyled with bitmap statics updated from the sections via
; VibeXTick, because NSIS runs sections on a worker thread with no script
; callbacks on that page.
!ifndef VIBEX_INSTALLER_PAGES
!define VIBEX_INSTALLER_PAGES

Var VibeXTitleText
Var DeleteAppDataCheckboxState
!define VIBEX_SEC_INSTALL 2
Var VibeXParent
Var VibeXDialog
Var VibeXPhase
Var VibeXAction
Var VibeXHasExisting
Var VibeXExistingVersion
Var VibeXFocusTarget
Var VibeXFootX
Var VibeXSB          ; static-button target
Var VibeXSBKind
Var VibeXSBText
Var VibeXSBState
; chrome + brand
Var VibeXTitleLbl
Var VibeXMinBtn
Var VibeXCloseBtn
Var VibeXIconCtl
Var VibeXNameLbl
Var VibeXSubLbl
; installer main page
Var VibeXBigBtn
Var VibeXLinkBtn
Var VibeXLocLbl
Var VibeXField
Var VibeXFieldBmpState
Var VibeXEdit
Var VibeXBrowseBtn
Var VibeXMetaLbl
Var VibeXBackBtn
Var VibeXInstallBtn
Var VibeXPathLbl
Var VibeXUninstallBtn
Var VibeXReinstallBtn
Var VibeXLastPath
; finish / confirm
Var VibeXCheck
Var VibeXDoneBtn
Var VibeXCancelBtn
; progress page
Var VibeXInstDlg
Var VibeXStatusLbl
Var VibeXErrIcon
Var VibeXPctLbl
Var VibeXBar
Var VibeXFileLbl
Var VibeXProgCancel
Var VibeXLogBtn
Var VibeXErrCancel
Var VibeXRetryBtn
Var VibeXPermille
Var VibeXBarState
Var VibeXErrTitle
Var VibeXErrCode
Var VibeXHover
Var VibeXMouseDown
Var VibeXKeyEnter
Var VibeXKeyEsc

!define VIBEX_STATIC_TEXT 0x50000080      ; WS_CHILD|WS_VISIBLE|SS_NOPREFIX
!define VIBEX_STATIC_CENTER 0x50000081
!define VIBEX_STATIC_RIGHT 0x50000082
!define VIBEX_STATIC_BITMAP 0x5000020E    ; SS_BITMAP|SS_CENTERIMAGE
!define VIBEX_STATIC_HIT 0x4000010E       ; hidden SS_BITMAP|SS_NOTIFY (hit-testable)

!macro VibeXMakeButton UN OUT KIND TEXT CALLBACK
  ${NSD_CreateButton} 0 0 0 0 "${TEXT}"
  Pop ${OUT}
  nsDialogs::SetUserData ${OUT} "${KIND}"
  ${NSD_OnClick} ${OUT} ${CALLBACK}
  ${NSD_OnNotify} ${OUT} ${UN}VibeXPaint
  SendMessage ${OUT} ${WM_SETFONT} $VibeXFontBtn 1
!macroend

; Place a measured button so its body's right edge sits at $VibeXFootX.
!macro VibeXFootRight UN HWND KIND TEXT
  StrCpy $VibeXRKind "${KIND}"
  StrCpy $VibeXRText "${TEXT}"
  StrCpy $VibeXRFont $VibeXFontBtn
  Call ${UN}VibeXButtonWidth
  IntOp $VibeXFootX $VibeXFootX - $VibeXRW
  !insertmacro VibeXPlaceDevX ${HWND} $VibeXFootX 340 $VibeXRW 40
  !insertmacro VibeXScale $VibeXT0 ${VIBEX_RING}
  IntOp $VibeXFootX $VibeXFootX + $VibeXT0
  IntOp $VibeXFootX $VibeXFootX + $VibeXT0
  !insertmacro VibeXScale $VibeXT0 ${VIBEX_BTN_GAP}
  IntOp $VibeXFootX $VibeXFootX - $VibeXT0
!macroend

!macro VibeXFootReset
  !insertmacro VibeXScale $VibeXFootX 496
  !insertmacro VibeXScale $VibeXT0 ${VIBEX_RING}
  IntOp $VibeXFootX $VibeXFootX + $VibeXT0
!macroend

!macro VibeXFootLeft UN HWND KIND TEXT
  StrCpy $VibeXRKind "${KIND}"
  StrCpy $VibeXRText "${TEXT}"
  StrCpy $VibeXRFont $VibeXFontBtn
  Call ${UN}VibeXButtonWidth
  !insertmacro VibeXScale $VibeXT1 ${VIBEX_FOOT_X}
  !insertmacro VibeXScale $VibeXT0 ${VIBEX_RING}
  IntOp $VibeXT1 $VibeXT1 - $VibeXT0
  !insertmacro VibeXPlaceDevX ${HWND} $VibeXT1 340 $VibeXRW 40
!macroend

!macro VibeXSetText HWND TEXT
  SendMessage ${HWND} ${WM_SETTEXT} 0 "STR:${TEXT}"
!macroend

; ---------------------------------------------------------------------------
; Shared between installer and uninstaller
; ---------------------------------------------------------------------------
!macro VIBEX_DEFINE_PAGES_SHARED UN

Function ${UN}VibeXGuiInit
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Return
  ${EndIf}
  Call ${UN}VibeXInitResources
  Call ${UN}VibeXSetupWindow
  !insertmacro VibeXLog "VibeX ${VERSION} setup log"
FunctionEnd

; Title bar (label + min/close) and brand lockup on $VibeXParent.
; $VibeXDialog != 0 means an nsDialogs page (interactive buttons).
Function ${UN}VibeXBuildChrome
  !insertmacro VibeXMakeStatic $VibeXTitleLbl $VibeXParent 0x50000380 "$VibeXTitleText" 16 0 412 ${VIBEX_TITLE_H}
  SendMessage $VibeXTitleLbl ${WM_SETFONT} $VibeXFontTitle 1
  !insertmacro VibeXMutedColors $VibeXTitleLbl
  ${If} $VibeXParent == $VibeXDialog
    ${NSD_OnClick} $VibeXTitleLbl ${UN}VibeXDragWindow
    !insertmacro VibeXMakeButton "${UN}" $VibeXMinBtn "min" "" ${UN}VibeXMinimizeWindow
    !insertmacro VibeXMakeButton "${UN}" $VibeXCloseBtn "close" "" ${UN}VibeXCloseWindow
    ${NSD_RemoveStyle} $VibeXMinBtn ${WS_TABSTOP}
    ${NSD_RemoveStyle} $VibeXCloseBtn ${WS_TABSTOP}
    !insertmacro VibeXPlace $VibeXMinBtn 428 0 ${VIBEX_CAPTION_BTN_W} ${VIBEX_TITLE_H}
    !insertmacro VibeXPlace $VibeXCloseBtn 474 0 ${VIBEX_CAPTION_BTN_W} ${VIBEX_TITLE_H}
  ${Else}
    ; instfiles page: static glyphs (the page cannot be cancelled mid-section)
    !insertmacro VibeXMakeStatic $VibeXMinBtn $VibeXParent ${VIBEX_STATIC_BITMAP} "" 428 0 ${VIBEX_CAPTION_BTN_W} ${VIBEX_TITLE_H}
    !insertmacro VibeXMakeStatic $VibeXCloseBtn $VibeXParent ${VIBEX_STATIC_BITMAP} "" 474 0 ${VIBEX_CAPTION_BTN_W} ${VIBEX_TITLE_H}
    StrCpy $VibeXSB $VibeXMinBtn
    StrCpy $VibeXSBKind "min"
    StrCpy $VibeXSBText ""
    StrCpy $VibeXSBState 0
    Call ${UN}VibeXStaticButton
    StrCpy $VibeXSB $VibeXCloseBtn
    StrCpy $VibeXSBKind "close"
    StrCpy $VibeXSBState 8
    Call ${UN}VibeXStaticButton
    !insertmacro VibeXPlace $VibeXMinBtn 428 0 ${VIBEX_CAPTION_BTN_W} ${VIBEX_TITLE_H}
    !insertmacro VibeXPlace $VibeXCloseBtn 474 0 ${VIBEX_CAPTION_BTN_W} ${VIBEX_TITLE_H}
  ${EndIf}

  !insertmacro VibeXMakeStatic $VibeXIconCtl $VibeXParent ${VIBEX_STATIC_BITMAP} "" 0 0 0 0
  !insertmacro VibeXMakeStatic $VibeXNameLbl $VibeXParent ${VIBEX_STATIC_CENTER} "${PRODUCTNAME}" 0 0 0 0
  !insertmacro VibeXLabelColors $VibeXNameLbl
  !insertmacro VibeXMakeStatic $VibeXSubLbl $VibeXParent ${VIBEX_STATIC_CENTER} "" 0 0 0 0
  SendMessage $VibeXSubLbl ${WM_SETFONT} $VibeXFontSub 1
  !insertmacro VibeXMutedColors $VibeXSubLbl
FunctionEnd

; Brand lockup: large (64px logo) or small (48px logo).
Function ${UN}VibeXBrandLarge
  SendMessage $VibeXIconCtl ${STM_SETIMAGE} ${IMAGE_BITMAP} $VibeXIconBmp
  !insertmacro VibeXPlace $VibeXIconCtl 228 ${VIBEX_BRAND_ICON_Y} ${VIBEX_BRAND_ICON} ${VIBEX_BRAND_ICON}
  SendMessage $VibeXNameLbl ${WM_SETFONT} $VibeXFontName 1
  !insertmacro VibeXPlace $VibeXNameLbl 32 ${VIBEX_BRAND_NAME_Y} 456 ${VIBEX_BRAND_NAME_H}
  !insertmacro VibeXPlace $VibeXSubLbl 32 ${VIBEX_BRAND_SUB_Y} 456 ${VIBEX_SUB_H}
FunctionEnd

Function ${UN}VibeXBrandSmall
  SendMessage $VibeXIconCtl ${STM_SETIMAGE} ${IMAGE_BITMAP} $VibeXIconSmBmp
  !insertmacro VibeXPlace $VibeXIconCtl 236 ${VIBEX_BRAND_SM_ICON_Y} ${VIBEX_BRAND_SM_ICON} ${VIBEX_BRAND_SM_ICON}
  SendMessage $VibeXNameLbl ${WM_SETFONT} $VibeXFontNameSm 1
  !insertmacro VibeXPlace $VibeXNameLbl 32 ${VIBEX_BRAND_SM_NAME_Y} 456 ${VIBEX_BRAND_SM_NAME_H}
  !insertmacro VibeXPlace $VibeXSubLbl 32 ${VIBEX_BRAND_SM_SUB_Y} 456 ${VIBEX_SUB_H}
FunctionEnd

; Create an empty nsDialogs page covering the whole window.
Function ${UN}VibeXNewPage
  Call ${UN}VibeXHideOuterControls
  nsDialogs::Create 1018
  Pop $VibeXDialog
  ${If} $VibeXDialog == error
    Abort
  ${EndIf}
  !insertmacro VibeXPlace $VibeXDialog 0 0 ${VIBEX_WIN_W} ${VIBEX_WIN_H}
  !insertmacro VibeXLabelColors $VibeXDialog
  StrCpy $VibeXParent $VibeXDialog
  Call ${UN}VibeXBuildChrome
FunctionEnd

; Show the page with keyboard focus on $VibeXFocusTarget.
Function ${UN}VibeXShowPage
  ${NSD_CreateTimer} ${UN}VibeXPageTick 120
  ShowWindow $HWNDPARENT 5
  nsDialogs::Show
FunctionEnd

Function ${UN}VibeXApplyFocus
  ${If} $VibeXFocusTarget != ""
  ${AndIf} $VibeXFocusTarget != 0
    SendMessage $VibeXDialog ${WM_NEXTDLGCTL} $VibeXFocusTarget 1
    System::Call 'user32::SetFocus(p $VibeXFocusTarget)'
    StrCpy $VibeXFocusTarget 0
  ${EndIf}
FunctionEnd

Function ${UN}VibeXFinishButton
  !insertmacro VibeXMakeButton "${UN}" $VibeXDoneBtn "pri" "$(VIBEX_FINISH)" ${UN}VibeXGoNext
  !insertmacro VibeXFootReset
  !insertmacro VibeXFootRight "${UN}" $VibeXDoneBtn "pri" "$(VIBEX_FINISH)"
  StrCpy $VibeXFocusTarget $VibeXDoneBtn
FunctionEnd

Function ${UN}VibeXGoNext
  Pop $VibeXT0
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

; Render a static "button" ($VibeXSB) used on the instfiles page.
Function ${UN}VibeXStaticButton
  StrCpy $VibeXRKind $VibeXSBKind
  StrCpy $VibeXRText $VibeXSBText
  StrCpy $VibeXRFont $VibeXFontBtn
  StrCpy $VibeXRState $VibeXSBState
  ${If} $VibeXRKind == "min"
  ${OrIf} $VibeXRKind == "close"
    !insertmacro VibeXScale $VibeXRW ${VIBEX_CAPTION_BTN_W}
    !insertmacro VibeXScale $VibeXRH ${VIBEX_TITLE_H}
  ${Else}
    Call ${UN}VibeXButtonWidth
    StrCpy $VibeXRText $VibeXSBText
    !insertmacro VibeXScale $VibeXRH 40
  ${EndIf}
  Call ${UN}VibeXRender
  !insertmacro VibeXSetStaticBitmap $VibeXSB
FunctionEnd

Function ${UN}VibeXRenderBar
  ${If} $VibeXBar == ""
  ${OrIf} $VibeXBar == 0
    Return
  ${EndIf}
  StrCpy $VibeXRKind "bar"
  StrCpy $VibeXRText $VibeXPermille
  StrCpy $VibeXRState $VibeXBarState
  !insertmacro VibeXScale $VibeXRW 456
  !insertmacro VibeXScale $VibeXRH ${VIBEX_PROG_TRACK_H}
  Call ${UN}VibeXRender
  !insertmacro VibeXSetStaticBitmap $VibeXBar
  !insertmacro VibeXPlace $VibeXBar 32 ${VIBEX_PROG_TRACK_Y} 456 ${VIBEX_PROG_TRACK_H}
FunctionEnd

; Restyle the MUI instfiles page into the progress view.
Function ${UN}VibeXInstFilesShow
  SetAutoClose true
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Return
  ${EndIf}
  Call ${UN}VibeXHideOuterControls
  StrCpy $VibeXDialog 0
  FindWindow $VibeXInstDlg "#32770" "" $HWNDPARENT
  !insertmacro VibeXPlace $VibeXInstDlg 0 0 ${VIBEX_WIN_W} ${VIBEX_WIN_H}
  !insertmacro VibeXLabelColors $VibeXInstDlg
  GetDlgItem $VibeXT0 $VibeXInstDlg 1027
  ShowWindow $VibeXT0 0
  GetDlgItem $VibeXT0 $VibeXInstDlg 1016
  ShowWindow $VibeXT0 0
  GetDlgItem $VibeXT0 $VibeXInstDlg 1004
  ShowWindow $VibeXT0 0

  StrCpy $VibeXParent $VibeXInstDlg
  Call ${UN}VibeXBuildChrome
  Call ${UN}VibeXBrandSmall

  !insertmacro VibeXMakeStatic $VibeXErrIcon $VibeXInstDlg 0x4000020E "" 32 ${VIBEX_PROG_LABEL_Y} 14 ${VIBEX_PROG_LABEL_H}
  !insertmacro VibeXMakeStatic $VibeXStatusLbl $VibeXInstDlg 0x50000280 "" 32 ${VIBEX_PROG_LABEL_Y} 380 ${VIBEX_PROG_LABEL_H}
  SendMessage $VibeXStatusLbl ${WM_SETFONT} $VibeXFontBody 1
  !insertmacro VibeXLabelColors $VibeXStatusLbl
  !insertmacro VibeXMakeStatic $VibeXPctLbl $VibeXInstDlg 0x50000282 "0%" 412 ${VIBEX_PROG_LABEL_Y} 76 ${VIBEX_PROG_LABEL_H}
  SendMessage $VibeXPctLbl ${WM_SETFONT} $VibeXFontBody 1
  !insertmacro VibeXMutedColors $VibeXPctLbl
  !insertmacro VibeXMakeStatic $VibeXBar $VibeXInstDlg ${VIBEX_STATIC_BITMAP} "" 32 ${VIBEX_PROG_TRACK_Y} 456 ${VIBEX_PROG_TRACK_H}
  StrCpy $VibeXPermille 0
  StrCpy $VibeXBarState 0
  Call ${UN}VibeXRenderBar

  ; NSIS's own detail line (1006) becomes the monospace file line; the static
  ; ellipsizes long paths in the middle.
  GetDlgItem $VibeXFileLbl $VibeXInstDlg 1006
  System::Call 'user32::GetWindowLongW(p $VibeXFileLbl, i -16) i.s'
  Pop $VibeXT0
  IntOp $VibeXT0 $VibeXT0 & 0xFFFFFFF0
  IntOp $VibeXT0 $VibeXT0 | 0x8080 ; SS_PATHELLIPSIS | SS_NOPREFIX
  System::Call 'user32::SetWindowLongW(p $VibeXFileLbl, i -16, i $VibeXT0)'
  SendMessage $VibeXFileLbl ${WM_SETFONT} $VibeXFontMono 1
  !insertmacro VibeXMutedColors $VibeXFileLbl
  !insertmacro VibeXPlace $VibeXFileLbl 32 ${VIBEX_PROG_FILE_Y} 456 ${VIBEX_PROG_FILE_H}
  !insertmacro VibeXSetText $VibeXFileLbl ""

  ; Only a (disabled) Cancel in the footer: NSIS cannot abort a running section.
  !insertmacro VibeXMakeStatic $VibeXProgCancel $VibeXInstDlg ${VIBEX_STATIC_BITMAP} "" 0 0 0 0
  StrCpy $VibeXSB $VibeXProgCancel
  StrCpy $VibeXSBKind "sec"
  StrCpy $VibeXSBText "$(VIBEX_CANCEL)"
  StrCpy $VibeXSBState 8
  Call ${UN}VibeXStaticButton
  !insertmacro VibeXFootReset
  !insertmacro VibeXFootRight "${UN}" $VibeXProgCancel "sec" "$(VIBEX_CANCEL)"

  ${If} $VibeXAction == "uninstall"
    !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_UNINSTALLING)"
    !insertmacro VibeXSetText $VibeXStatusLbl "$(VIBEX_PROGRESS_UNINSTALL)"
  ${Else}
    !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_INSTALLING)"
    !insertmacro VibeXSetText $VibeXStatusLbl "$(VIBEX_PROGRESS_PREPARE)"
  ${EndIf}
  ShowWindow $HWNDPARENT 5
FunctionEnd

; Mirror NSIS's hidden progress bar (1004) into the custom bar + percentage.
Function ${UN}VibeXTick
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
  ${OrIf} $VibeXInstDlg == ""
  ${OrIf} $VibeXInstDlg == 0
    Return
  ${EndIf}
  GetDlgItem $VibeXT0 $VibeXInstDlg 1004
  SendMessage $VibeXT0 ${PBM_GETPOS} 0 0 $VibeXT1
  SendMessage $VibeXT0 ${PBM_GETRANGE} 0 0 $VibeXT2
  ${If} $VibeXT2 <= 0
    Return
  ${EndIf}
  IntOp $VibeXT1 $VibeXT1 * 1000
  IntOp $VibeXT1 $VibeXT1 / $VibeXT2
  ${If} $VibeXT1 == $VibeXPermille
    Return
  ${EndIf}
  StrCpy $VibeXPermille $VibeXT1
  Call ${UN}VibeXRenderBar
  IntOp $VibeXT1 $VibeXPermille / 10
  !insertmacro VibeXSetText $VibeXPctLbl "$VibeXT1%"
FunctionEnd

; Finish the bar when a section's work is done.
Function ${UN}VibeXTickDone
  ${If} $VibeXBar == ""
  ${OrIf} $VibeXBar == 0
    Return
  ${EndIf}
  StrCpy $VibeXPermille 1000
  Call ${UN}VibeXRenderBar
  !insertmacro VibeXSetText $VibeXPctLbl "100%"
FunctionEnd

!macroend

!macro VibeXSetStage UN TEXT
  ${If} $PassiveMode <> 1
  ${AndIfNot} ${Silent}
  ${AndIf} $VibeXStatusLbl != ""
    !insertmacro VibeXSetText $VibeXStatusLbl "${TEXT}"
    Call ${UN}VibeXTick
  ${EndIf}
  !insertmacro VibeXLog "${TEXT}"
!macroend

!insertmacro VIBEX_DEFINE_DRAWING ""
!insertmacro VIBEX_DEFINE_DRAWING "un."
!insertmacro VIBEX_DEFINE_PAGES_SHARED ""
!insertmacro VIBEX_DEFINE_PAGES_SHARED "un."

; ---------------------------------------------------------------------------
; Installer pages
; ---------------------------------------------------------------------------
Function VibeXDetectExisting
  StrCpy $VibeXHasExisting 0
  StrCpy $VibeXExistingVersion ""
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
    ReadRegStr $VibeXExistingVersion HKLM "$R6" "DisplayVersion"
    StrCpy $VibeXHasExisting 1
    Return
  vibex_wix_done:

  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} "$R0$R1" != ""
    StrCpy $VibeXHasExisting 1
    ReadRegStr $VibeXExistingVersion SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
FunctionEnd

Function VibeXGuiInitInstaller
  StrCpy $VibeXTitleText "$(VIBEX_TITLE_SETUP)"
  Call VibeXGuiInit
FunctionEnd

Function VibeXPageMain
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

  Call VibeXNewPage

  ; welcome
  !insertmacro VibeXMakeButton "" $VibeXBigBtn "prilg" "$(VIBEX_INSTALL_NOW)" VibeXOnInstall
  SendMessage $VibeXBigBtn ${WM_SETFONT} $VibeXFontBtnLg 1
  !insertmacro VibeXPlace $VibeXBigBtn 156 240 208 48
  !insertmacro VibeXMakeButton "" $VibeXLinkBtn "link" "$(VIBEX_CUSTOMIZE)" VibeXOnCustomize
  SendMessage $VibeXLinkBtn ${WM_SETFONT} $VibeXFontBody 1
  StrCpy $VibeXRText "$(VIBEX_CUSTOMIZE)"
  StrCpy $VibeXRFont $VibeXFontBody
  Call VibeXMeasure
  !insertmacro VibeXScale $VibeXT0 16
  IntOp $VibeXRW $VibeXRW + $VibeXT0
  !insertmacro VibeXScale $VibeXT0 ${VIBEX_WIN_W}
  IntOp $VibeXT0 $VibeXT0 - $VibeXRW
  IntOp $VibeXT0 $VibeXT0 / 2
  !insertmacro VibeXPlaceDevX $VibeXLinkBtn $VibeXT0 ${VIBEX_WELCOME_LINK_Y} $VibeXRW 24

  ; custom location
  !insertmacro VibeXMakeStatic $VibeXLocLbl $VibeXDialog ${VIBEX_STATIC_TEXT} "$(VIBEX_LOCATION)" 32 ${VIBEX_LOC_LABEL_Y} 456 18
  SendMessage $VibeXLocLbl ${WM_SETFONT} $VibeXFontSub 1
  !insertmacro VibeXMutedColors $VibeXLocLbl
  !insertmacro VibeXMakeButton "" $VibeXBrowseBtn "sec" "$(VIBEX_BROWSE)" VibeXOnBrowse
  StrCpy $VibeXRKind "sec"
  StrCpy $VibeXRText "$(VIBEX_BROWSE)"
  StrCpy $VibeXRFont $VibeXFontBtn
  Call VibeXButtonWidth
  !insertmacro VibeXScale $VibeXT1 488
  !insertmacro VibeXScale $VibeXT0 ${VIBEX_RING}
  IntOp $VibeXT1 $VibeXT1 + $VibeXT0
  IntOp $VibeXT1 $VibeXT1 - $VibeXRW
  !insertmacro VibeXPlaceDevX $VibeXBrowseBtn $VibeXT1 236 $VibeXRW 40
  ; field spans from x=32 to the browse body minus an 8px gap
  IntOp $VibeXT1 $VibeXT1 + $VibeXT0
  !insertmacro VibeXScale $VibeXT0 40
  IntOp $VibeXT1 $VibeXT1 - $VibeXT0 ; field width (device)
  IntOp $VibeXT0 ${VIBEX_STATIC_BITMAP} | 0x04000000 ; WS_CLIPSIBLINGS: never paint over the edit
  !insertmacro VibeXMakeStatic $VibeXField $VibeXDialog $VibeXT0 "" 0 0 0 0
  !insertmacro VibeXScale $VibeXT0 32
  !insertmacro VibeXPlaceDevX $VibeXField $VibeXT0 ${VIBEX_LOC_FIELD_Y} $VibeXT1 32
  StrCpy $VibeXFieldBmpState ""
  ${NSD_CreateText} 0 0 0 0 "$INSTDIR"
  Pop $VibeXEdit
  System::Call 'user32::GetWindowLongW(p $VibeXEdit, i -16) i.s'
  Pop $VibeXT0
  IntOp $VibeXT0 $VibeXT0 & 0xFF7FFFFF ; no WS_BORDER
  System::Call 'user32::SetWindowLongW(p $VibeXEdit, i -16, i $VibeXT0)'
  System::Call 'user32::GetWindowLongW(p $VibeXEdit, i -20) i.s'
  Pop $VibeXT0
  IntOp $VibeXT0 $VibeXT0 & 0xFFFFFDFF ; no WS_EX_CLIENTEDGE
  System::Call 'user32::SetWindowLongW(p $VibeXEdit, i -20, i $VibeXT0)'
  SendMessage $VibeXEdit ${WM_SETFONT} $VibeXFontBody 1
  SendMessage $VibeXEdit ${EM_SETLIMITTEXT} 240 0
  !insertmacro VibeXFieldColors $VibeXEdit
  ; text starts after the 16px folder glyph (x=12..28 inside the field) + 8px gap
  !insertmacro VibeXScale $VibeXT0 68
  !insertmacro VibeXScale $VibeXT2 48
  IntOp $VibeXT2 $VibeXT1 - $VibeXT2
  !insertmacro VibeXPlaceDevX $VibeXEdit $VibeXT0 248 $VibeXT2 18
  System::Call 'user32::SetWindowPos(p $VibeXEdit, p 0, i 0, i 0, i 0, i 0, i 0x33)'
  !insertmacro VibeXMakeStatic $VibeXMetaLbl $VibeXDialog ${VIBEX_STATIC_TEXT} "" 32 ${VIBEX_LOC_META_Y} 456 16
  SendMessage $VibeXMetaLbl ${WM_SETFONT} $VibeXFontSub 1
  !insertmacro VibeXMutedColors $VibeXMetaLbl
  StrCpy $VibeXLastPath ""
  !insertmacro VibeXMakeButton "" $VibeXBackBtn "ghost" "$(VIBEX_BACK)" VibeXOnBack
  !insertmacro VibeXFootLeft "" $VibeXBackBtn "ghost" "$(VIBEX_BACK)"
  !insertmacro VibeXMakeButton "" $VibeXInstallBtn "pri" "$(VIBEX_INSTALL)" VibeXOnInstall
  !insertmacro VibeXFootReset
  !insertmacro VibeXFootRight "" $VibeXInstallBtn "pri" "$(VIBEX_INSTALL)"

  ; existing installation
  !insertmacro VibeXMakeStatic $VibeXPathLbl $VibeXDialog 0x50008081 "$INSTDIR" 32 214 456 16
  SendMessage $VibeXPathLbl ${WM_SETFONT} $VibeXFontMono 1
  !insertmacro VibeXMutedColors $VibeXPathLbl
  !insertmacro VibeXMakeButton "" $VibeXReinstallBtn "pri" "$(VIBEX_REINSTALL)" VibeXOnInstall
  !insertmacro VibeXMakeButton "" $VibeXUninstallBtn "danger" "$(VIBEX_UNINSTALL)" VibeXOnUninstall
  !insertmacro VibeXFootReset
  !insertmacro VibeXFootRight "" $VibeXReinstallBtn "pri" "$(VIBEX_REINSTALL)"
  !insertmacro VibeXFootRight "" $VibeXUninstallBtn "danger" "$(VIBEX_UNINSTALL)"

  Call VibeXApplyPhase
  Call VibeXShowPage
FunctionEnd

Function VibeXApplyPhase
  ShowWindow $VibeXBigBtn 0
  ShowWindow $VibeXLinkBtn 0
  ShowWindow $VibeXLocLbl 0
  ShowWindow $VibeXField 0
  ShowWindow $VibeXEdit 0
  ShowWindow $VibeXBrowseBtn 0
  ShowWindow $VibeXMetaLbl 0
  ShowWindow $VibeXBackBtn 0
  ShowWindow $VibeXInstallBtn 0
  ShowWindow $VibeXPathLbl 0
  ShowWindow $VibeXReinstallBtn 0
  ShowWindow $VibeXUninstallBtn 0
  ${If} $VibeXPhase == "location"
    Call VibeXBrandSmall
    !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_VERSION_FMT)"
    ${NSD_SetText} $VibeXEdit "$INSTDIR"
    StrCpy $VibeXLastPath ""
    StrCpy $VibeXFieldBmpState ""
    Call VibeXUpdateLocation
    ShowWindow $VibeXLocLbl 5
    ShowWindow $VibeXField 5
    ShowWindow $VibeXEdit 5
    ShowWindow $VibeXBrowseBtn 5
    ShowWindow $VibeXMetaLbl 5
    ShowWindow $VibeXBackBtn 5
    ShowWindow $VibeXInstallBtn 5
    StrCpy $VibeXFocusTarget $VibeXInstallBtn
  ${ElseIf} $VibeXPhase == "existing"
    Call VibeXBrandLarge
    !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_INSTALLED_FMT) $VibeXExistingVersion"
    !insertmacro VibeXSetText $VibeXPathLbl "$INSTDIR"
    ShowWindow $VibeXPathLbl 5
    ShowWindow $VibeXReinstallBtn 5
    ShowWindow $VibeXUninstallBtn 5
    StrCpy $VibeXFocusTarget $VibeXReinstallBtn
  ${Else}
    Call VibeXBrandLarge
    !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_VERSION_FMT)"
    ShowWindow $VibeXBigBtn 5
    ShowWindow $VibeXLinkBtn 5
    StrCpy $VibeXFocusTarget $VibeXBigBtn
  ${EndIf}
  Call VibeXApplyFocus
  System::Call 'user32::InvalidateRect(p $VibeXDialog, p 0, i 1)'
FunctionEnd

; Timer: deferred initial focus, live free-space + field focus ring.
Function VibeXPageTick
  Call VibeXApplyFocus
  ${If} $VibeXPhase == "location"
    Call VibeXUpdateLocation
  ${EndIf}
FunctionEnd

Function VibeXUpdateLocation
  ; focus ring on the path field follows the edit's focus
  System::Call 'user32::GetFocus() p.s'
  Pop $VibeXT0
  StrCpy $VibeXT1 "field"
  ${If} $VibeXT0 == $VibeXEdit
    StrCpy $VibeXT1 "fieldfocus"
  ${EndIf}
  ${If} $VibeXT1 != $VibeXFieldBmpState
    StrCpy $VibeXFieldBmpState $VibeXT1
    StrCpy $VibeXRKind $VibeXT1
    StrCpy $VibeXRText ""
    StrCpy $VibeXRState 0
    System::Call '*(i 0, i 0, i 0, i 0) p.s'
    Pop $VibeXT2
    System::Call 'user32::GetClientRect(p $VibeXField, p $VibeXT2)'
    System::Call '*$VibeXT2(i, i, i .s, i .s)'
    Pop $VibeXRW
    Pop $VibeXRH
    System::Free $VibeXT2
    Call VibeXRender
    !insertmacro VibeXSetStaticBitmap $VibeXField
    System::Call 'user32::InvalidateRect(p $VibeXEdit, p 0, i 1)'
  ${EndIf}

  ${NSD_GetText} $VibeXEdit $VibeXT3
  ${If} $VibeXT3 == $VibeXLastPath
    Return
  ${EndIf}
  StrCpy $VibeXLastPath $VibeXT3
  SectionGetSize ${VIBEX_SEC_INSTALL} $VibeXT4
  IntOp $VibeXT4 $VibeXT4 + 1023
  IntOp $VibeXT4 $VibeXT4 / 1024
  ${If} $VibeXT4 < 1
    StrCpy $VibeXT4 1
  ${EndIf}
  ${GetRoot} "$VibeXT3" $VibeXT5
  StrCpy $VibeXT6 "—"
  ${If} $VibeXT5 != ""
    ClearErrors
    ${DriveSpace} "$VibeXT5\" "/D=F /S=M" $VibeXT7
    ${IfNot} ${Errors}
      IntOp $VibeXT7 $VibeXT7 * 10
      IntOp $VibeXT7 $VibeXT7 / 1024
      IntOp $VibeXT8 $VibeXT7 % 10
      IntOp $VibeXT7 $VibeXT7 / 10
      StrCpy $VibeXT6 "$VibeXT7.$VibeXT8"
    ${EndIf}
  ${EndIf}
  !insertmacro VibeXSetText $VibeXMetaLbl "$(VIBEX_SPACE_REQUIRED) $VibeXT4 MB · $(VIBEX_SPACE_FREE) $VibeXT6 GB$(VIBEX_PAREN_L)$VibeXT5$(VIBEX_PAREN_R)"
FunctionEnd

Function VibeXOnCustomize
  Pop $VibeXT0
  StrCpy $VibeXPhase "location"
  Call VibeXApplyPhase
FunctionEnd

Function VibeXOnBack
  Pop $VibeXT0
  StrCpy $VibeXPhase "welcome"
  Call VibeXApplyPhase
FunctionEnd

Function VibeXOnBrowse
  Pop $VibeXT0
  ${NSD_GetText} $VibeXEdit $VibeXT1
  nsDialogs::SelectFolderDialog "$(VIBEX_CHOOSE_PATH)" "$VibeXT1"
  Pop $VibeXT1
  ${If} $VibeXT1 != "error"
  ${AndIf} $VibeXT1 != ""
    StrLen $VibeXT2 "${PRODUCTNAME}"
    IntOp $VibeXT2 0 - $VibeXT2
    StrCpy $VibeXT3 $VibeXT1 "" $VibeXT2
    ${If} $VibeXT3 != "${PRODUCTNAME}"
      StrCpy $VibeXT3 $VibeXT1 "" -1
      ${If} $VibeXT3 == "\"
        StrCpy $VibeXT1 "$VibeXT1${PRODUCTNAME}"
      ${Else}
        StrCpy $VibeXT1 "$VibeXT1\${PRODUCTNAME}"
      ${EndIf}
    ${EndIf}
    ${NSD_SetText} $VibeXEdit $VibeXT1
    Call VibeXUpdateLocation
  ${EndIf}
FunctionEnd

Function VibeXOnInstall
  Pop $VibeXT0
  ${If} $VibeXPhase == "existing"
    StrCpy $VibeXAction "reinstall"
  ${EndIf}
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

Function VibeXOnUninstall
  Pop $VibeXT0
  StrCpy $VibeXAction "uninstall"
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

Function VibeXPageMainLeave
  ${If} $VibeXPhase == "location"
    ${NSD_GetText} $VibeXEdit $VibeXT0
    ${If} $VibeXT0 == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(VIBEX_PATH_INVALID)"
      Abort
    ${EndIf}
    StrCpy $INSTDIR $VibeXT0
  ${EndIf}
  ; Reinstalling over a previous WiX MSI installation: remove the MSI first.
  ${If} $VibeXAction == "reinstall"
  ${AndIf} $WixMode = 1
    ReadRegStr $R1 HKLM "$R6" "UninstallString"
    ${If} $R1 != ""
      HideWindow
      ExecWait '$R1' $0
      BringToFront
    ${EndIf}
  ${EndIf}
  !insertmacro VibeXLog "action=$VibeXAction instdir=$INSTDIR"
FunctionEnd

Function VibeXPageFinish
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}
  Call VibeXNewPage
  Call VibeXBrandLarge
  ${If} $VibeXAction == "uninstall"
    !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_UNINSTALLED_DONE)"
    StrCpy $VibeXCheck 0
  ${Else}
    !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_INSTALL_DONE)"
    ${NSD_CreateCheckbox} 0 0 0 0 "$(VIBEX_LAUNCH_NOW)"
    Pop $VibeXCheck
    nsDialogs::SetUserData $VibeXCheck "check"
    ${NSD_OnNotify} $VibeXCheck VibeXPaint
    SendMessage $VibeXCheck ${WM_SETFONT} $VibeXFontBody 1
    ${NSD_Check} $VibeXCheck
    StrCpy $VibeXRText "$(VIBEX_LAUNCH_NOW)"
    StrCpy $VibeXRFont $VibeXFontBody
    Call VibeXMeasure
    !insertmacro VibeXScale $VibeXT0 32
    IntOp $VibeXRW $VibeXRW + $VibeXT0
    !insertmacro VibeXScale $VibeXT0 ${VIBEX_WIN_W}
    IntOp $VibeXT0 $VibeXT0 - $VibeXRW
    IntOp $VibeXT0 $VibeXT0 / 2
    !insertmacro VibeXPlaceDevX $VibeXCheck $VibeXT0 ${VIBEX_CHECK_Y} $VibeXRW ${VIBEX_CHECK_H}
  ${EndIf}
  Call VibeXFinishButton
  Call VibeXShowPage
FunctionEnd

Function VibeXPageFinishLeave
  ${If} $VibeXCheck != 0
    ${NSD_GetState} $VibeXCheck $0
    HideWindow
    ${If} $0 == ${BST_CHECKED}
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    ${EndIf}
  ${EndIf}
FunctionEnd

; --- Error state on the progress page -------------------------------------
Function VibeXRedrawErrorButtons
  StrCpy $VibeXSB $VibeXLogBtn
  StrCpy $VibeXSBKind "ghost"
  StrCpy $VibeXSBText "$(VIBEX_VIEW_LOG)"
  StrCpy $VibeXSBState 0
  ${If} $VibeXHover == $VibeXLogBtn
    StrCpy $VibeXSBState 1
  ${EndIf}
  Call VibeXStaticButton
  StrCpy $VibeXSB $VibeXErrCancel
  StrCpy $VibeXSBKind "sec"
  StrCpy $VibeXSBText "$(VIBEX_CANCEL)"
  StrCpy $VibeXSBState 0
  ${If} $VibeXHover == $VibeXErrCancel
    StrCpy $VibeXSBState 1
  ${EndIf}
  Call VibeXStaticButton
  StrCpy $VibeXSB $VibeXRetryBtn
  StrCpy $VibeXSBKind "pri"
  StrCpy $VibeXSBText "$(VIBEX_RETRY)"
  StrCpy $VibeXSBState 4 ; default action: focus ring, Enter retries
  ${If} $VibeXHover == $VibeXRetryBtn
    StrCpy $VibeXSBState 5
  ${EndIf}
  Call VibeXStaticButton
  StrCpy $VibeXSB $VibeXCloseBtn
  StrCpy $VibeXSBKind "close"
  StrCpy $VibeXSBText ""
  StrCpy $VibeXSBState 0
  ${If} $VibeXHover == $VibeXCloseBtn
    StrCpy $VibeXSBState 1
  ${EndIf}
  Call VibeXStaticButton
  !insertmacro VibeXPlace $VibeXCloseBtn 474 0 ${VIBEX_CAPTION_BTN_W} ${VIBEX_TITLE_H}
FunctionEnd

!macro VibeXKeyEdge VK STATEVAR LABEL
  System::Call 'user32::GetAsyncKeyState(i ${VK}) i.s'
  Pop $VibeXT0
  IntOp $VibeXT0 $VibeXT0 & 0x8000
  ${If} $VibeXT0 != 0
    ${If} ${STATEVAR} == 0
      StrCpy ${STATEVAR} 1
      ${If} $VibeXT1 == 1
        Goto ${LABEL}
      ${EndIf}
    ${EndIf}
  ${Else}
    StrCpy ${STATEVAR} 0
  ${EndIf}
!macroend

; Show the error view and wait (on the section thread) for Retry / Cancel.
; Inputs: $VibeXErrTitle, $VibeXErrCode. Returns when the user picks Retry.
Function VibeXShowError
  !insertmacro VibeXLog "error: $VibeXErrTitle ($VibeXErrCode)"
  ${If} $VibeXInstDlg == ""
  ${OrIf} $VibeXInstDlg == 0
    Abort "$VibeXErrTitle"
  ${EndIf}
  ; stop the bar in the error color, red status with glyph, code in the file line
  StrCpy $VibeXBarState 32
  Call VibeXRenderBar
  StrCpy $VibeXRKind "erricon"
  StrCpy $VibeXRText ""
  StrCpy $VibeXRState 0
  !insertmacro VibeXScale $VibeXRW 14
  StrCpy $VibeXRH $VibeXRW
  Call VibeXRender
  !insertmacro VibeXSetStaticBitmap $VibeXErrIcon
  !insertmacro VibeXPlace $VibeXErrIcon 32 238 14 14
  ShowWindow $VibeXErrIcon 5
  !insertmacro VibeXPlace $VibeXStatusLbl 52 ${VIBEX_PROG_LABEL_Y} 360 ${VIBEX_PROG_LABEL_H}
  !insertmacro VibeXErrorColors $VibeXStatusLbl
  !insertmacro VibeXSetText $VibeXStatusLbl "$VibeXErrTitle"
  !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_INSTALL_FAILED)"
  SetDetailsPrint none
  !insertmacro VibeXSetText $VibeXFileLbl "$(VIBEX_ERROR_HINT) $VibeXErrCode"

  ShowWindow $VibeXProgCancel 0
  ${If} $VibeXRetryBtn == ""
    !insertmacro VibeXMakeStatic $VibeXLogBtn $VibeXInstDlg ${VIBEX_STATIC_HIT} "" 0 0 0 0
    !insertmacro VibeXMakeStatic $VibeXErrCancel $VibeXInstDlg ${VIBEX_STATIC_HIT} "" 0 0 0 0
    !insertmacro VibeXMakeStatic $VibeXRetryBtn $VibeXInstDlg ${VIBEX_STATIC_HIT} "" 0 0 0 0
    ; the title-bar close becomes live while waiting
    System::Call 'user32::GetWindowLongW(p $VibeXCloseBtn, i -16) i.s'
    Pop $VibeXT0
    IntOp $VibeXT0 $VibeXT0 | 0x100
    System::Call 'user32::SetWindowLongW(p $VibeXCloseBtn, i -16, i $VibeXT0)'
  ${EndIf}
  StrCpy $VibeXHover 0
  Call VibeXRedrawErrorButtons
  !insertmacro VibeXFootLeft "" $VibeXLogBtn "ghost" "$(VIBEX_VIEW_LOG)"
  !insertmacro VibeXFootReset
  !insertmacro VibeXFootRight "" $VibeXRetryBtn "pri" "$(VIBEX_RETRY)"
  !insertmacro VibeXFootRight "" $VibeXErrCancel "sec" "$(VIBEX_CANCEL)"
  ShowWindow $VibeXLogBtn 5
  ShowWindow $VibeXErrCancel 5
  ShowWindow $VibeXRetryBtn 5
  System::Call 'user32::InvalidateRect(p $VibeXInstDlg, p 0, i 1)'

  StrCpy $VibeXMouseDown 1
  StrCpy $VibeXKeyEnter 1
  StrCpy $VibeXKeyEsc 1
  System::Call '*(i 0, i 0) p.s'
  Pop $VibeXT9
  vibex_err_loop:
    Sleep 30
    System::Call 'user32::GetCursorPos(p $VibeXT9)'
    System::Call '*$VibeXT9(i .s, i .s)'
    Pop $VibeXT2
    Pop $VibeXT3
    System::Call 'user32::WindowFromPoint(i $VibeXT2, i $VibeXT3) p.s'
    Pop $VibeXT4
    ${If} $VibeXT4 != $VibeXLogBtn
    ${AndIf} $VibeXT4 != $VibeXErrCancel
    ${AndIf} $VibeXT4 != $VibeXRetryBtn
    ${AndIf} $VibeXT4 != $VibeXCloseBtn
      StrCpy $VibeXT4 0
    ${EndIf}
    ${If} $VibeXT4 != $VibeXHover
      StrCpy $VibeXHover $VibeXT4
      Push $VibeXT9
      Call VibeXRedrawErrorButtons
      Pop $VibeXT9
    ${EndIf}
    System::Call 'user32::GetAsyncKeyState(i 1) i.s'
    Pop $VibeXT0
    IntOp $VibeXT0 $VibeXT0 & 0x8000
    ${If} $VibeXT0 != 0
      ${If} $VibeXMouseDown == 0
        StrCpy $VibeXMouseDown 1
        ${If} $VibeXHover == $VibeXRetryBtn
          Goto vibex_err_retry
        ${ElseIf} $VibeXHover == $VibeXErrCancel
        ${OrIf} $VibeXHover == $VibeXCloseBtn
          Goto vibex_err_cancel
        ${ElseIf} $VibeXHover == $VibeXLogBtn
          ExecShell "open" "$PLUGINSDIR\install.log"
        ${EndIf}
      ${EndIf}
    ${Else}
      StrCpy $VibeXMouseDown 0
    ${EndIf}
    System::Call 'user32::GetForegroundWindow() p.s'
    Pop $VibeXT1
    ${If} $VibeXT1 == $HWNDPARENT
      StrCpy $VibeXT1 1
    ${Else}
      StrCpy $VibeXT1 0
    ${EndIf}
    !insertmacro VibeXKeyEdge 0x0D $VibeXKeyEnter vibex_err_retry
    !insertmacro VibeXKeyEdge 0x1B $VibeXKeyEsc vibex_err_cancel
    Goto vibex_err_loop

  vibex_err_cancel:
    System::Free $VibeXT9
    !insertmacro VibeXLog "cancelled by user"
    Quit

  vibex_err_retry:
    System::Free $VibeXT9
    !insertmacro VibeXLog "retry"
    ShowWindow $VibeXLogBtn 0
    ShowWindow $VibeXErrCancel 0
    ShowWindow $VibeXRetryBtn 0
    ShowWindow $VibeXErrIcon 0
    ShowWindow $VibeXProgCancel 5
    StrCpy $VibeXSB $VibeXCloseBtn
    StrCpy $VibeXSBKind "close"
    StrCpy $VibeXSBText ""
    StrCpy $VibeXSBState 8
    Call VibeXStaticButton
    !insertmacro VibeXPlace $VibeXCloseBtn 474 0 ${VIBEX_CAPTION_BTN_W} ${VIBEX_TITLE_H}
    !insertmacro VibeXPlace $VibeXStatusLbl 32 ${VIBEX_PROG_LABEL_Y} 380 ${VIBEX_PROG_LABEL_H}
    !insertmacro VibeXLabelColors $VibeXStatusLbl
    !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_INSTALLING)"
    !insertmacro VibeXSetText $VibeXFileLbl ""
    SetDetailsPrint both
    StrCpy $VibeXBarState 0
    Call VibeXRenderBar
    System::Call 'user32::InvalidateRect(p $VibeXInstDlg, p 0, i 1)'
FunctionEnd

; ---------------------------------------------------------------------------
; Uninstaller pages
; ---------------------------------------------------------------------------
Function un.VibeXGuiInitUninstaller
  StrCpy $VibeXTitleText "$(VIBEX_TITLE_UNINSTALL)"
  StrCpy $VibeXAction "uninstall"
  Call un.VibeXGuiInit
FunctionEnd

Function un.VibeXPageTick
  Call un.VibeXApplyFocus
FunctionEnd

Function un.VibeXPageConfirm
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  Call un.VibeXNewPage
  Call un.VibeXBrandLarge
  !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_UNINSTALL_SUB)"
  ${NSD_CreateCheckbox} 0 0 0 0 "$(VIBEX_DELETE_DATA)"
  Pop $VibeXCheck
  nsDialogs::SetUserData $VibeXCheck "check"
  ${NSD_OnNotify} $VibeXCheck un.VibeXPaint
  SendMessage $VibeXCheck ${WM_SETFONT} $VibeXFontBody 1
  ${If} $DeleteAppDataCheckboxState = 1
    ${NSD_Check} $VibeXCheck
  ${EndIf}
  StrCpy $VibeXRText "$(VIBEX_DELETE_DATA)"
  StrCpy $VibeXRFont $VibeXFontBody
  Call un.VibeXMeasure
  !insertmacro VibeXScale $VibeXT0 32
  IntOp $VibeXRW $VibeXRW + $VibeXT0
  !insertmacro VibeXScale $VibeXT0 ${VIBEX_WIN_W}
  IntOp $VibeXT0 $VibeXT0 - $VibeXRW
  IntOp $VibeXT0 $VibeXT0 / 2
  !insertmacro VibeXPlaceDevX $VibeXCheck $VibeXT0 ${VIBEX_CHECK_Y} $VibeXRW ${VIBEX_CHECK_H}

  !insertmacro VibeXMakeButton "un." $VibeXDoneBtn "danger" "$(VIBEX_UNINSTALL)" un.VibeXGoNext
  !insertmacro VibeXMakeButton "un." $VibeXCancelBtn "sec" "$(VIBEX_CANCEL)" un.VibeXCloseWindow
  !insertmacro VibeXFootReset
  !insertmacro VibeXFootRight "un." $VibeXDoneBtn "danger" "$(VIBEX_UNINSTALL)"
  !insertmacro VibeXFootRight "un." $VibeXCancelBtn "sec" "$(VIBEX_CANCEL)"
  ; Destructive action is never the default: focus starts on Cancel.
  StrCpy $VibeXFocusTarget $VibeXCancelBtn
  Call un.VibeXShowPage
FunctionEnd

Function un.VibeXPageConfirmLeave
  ${NSD_GetState} $VibeXCheck $DeleteAppDataCheckboxState
  ${If} $DeleteAppDataCheckboxState == ${BST_CHECKED}
    StrCpy $DeleteAppDataCheckboxState 1
  ${Else}
    StrCpy $DeleteAppDataCheckboxState 0
  ${EndIf}
FunctionEnd

Function un.VibeXPageFinish
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}
  Call un.VibeXNewPage
  Call un.VibeXBrandLarge
  !insertmacro VibeXSetText $VibeXSubLbl "$(VIBEX_UNINSTALLED_DONE)"
  Call un.VibeXFinishButton
  Call un.VibeXShowPage
FunctionEnd

!endif
