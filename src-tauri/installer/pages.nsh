; Dimo installer & uninstaller pages.
;
; Installer:   [welcome | custom location | existing install]  -> progress (+error) -> finish
; Uninstaller: confirm -> progress -> finish
;
; Every view lives on a 520x400 (96-DPI logical) frameless window with a 40px
; title bar. nsDialogs pages use owner-drawn buttons (NM_CUSTOMDRAW); the MUI
; instfiles page is restyled with bitmap statics updated from the sections via
; DimoTick, because NSIS runs sections on a worker thread with no script
; callbacks on that page.
!ifndef DIMO_INSTALLER_PAGES
!define DIMO_INSTALLER_PAGES

Var DimoTitleText
Var DeleteAppDataCheckboxState
!define DIMO_SEC_INSTALL 2
Var DimoParent
Var DimoDialog
Var DimoPhase
Var DimoAction
Var DimoHasExisting
Var DimoExistingVersion
Var DimoFocusTarget
Var DimoFootX
Var DimoSB          ; static-button target
Var DimoSBKind
Var DimoSBText
Var DimoSBState
; chrome + brand
Var DimoTitleLbl
Var DimoMinBtn
Var DimoCloseBtn
Var DimoIconCtl
Var DimoNameLbl
Var DimoSubLbl
; installer main page
Var DimoBigBtn
Var DimoLinkBtn
Var DimoLocLbl
Var DimoField
Var DimoFieldBmpState
Var DimoEdit
Var DimoBrowseBtn
Var DimoMetaLbl
Var DimoBackBtn
Var DimoInstallBtn
Var DimoPathLbl
Var DimoUninstallBtn
Var DimoReinstallBtn
Var DimoLastPath
; finish / confirm
Var DimoCheck
Var DimoDoneBtn
Var DimoCancelBtn
; progress page
Var DimoInstDlg
Var DimoStatusLbl
Var DimoErrIcon
Var DimoPctLbl
Var DimoBar
Var DimoFileLbl
Var DimoProgCancel
Var DimoLogBtn
Var DimoErrCancel
Var DimoRetryBtn
Var DimoPermille
Var DimoBarState
Var DimoErrTitle
Var DimoErrCode
Var DimoHover
Var DimoMouseDown
Var DimoKeyEnter
Var DimoKeyEsc

!define DIMO_STATIC_TEXT 0x50000080      ; WS_CHILD|WS_VISIBLE|SS_NOPREFIX
!define DIMO_STATIC_CENTER 0x50000081
!define DIMO_STATIC_RIGHT 0x50000082
!define DIMO_STATIC_BITMAP 0x5000020E    ; SS_BITMAP|SS_CENTERIMAGE
!define DIMO_STATIC_HIT 0x4000010E       ; hidden SS_BITMAP|SS_NOTIFY (hit-testable)

!macro DimoMakeButton UN OUT KIND TEXT CALLBACK
  ${NSD_CreateButton} 0 0 0 0 "${TEXT}"
  Pop ${OUT}
  nsDialogs::SetUserData ${OUT} "${KIND}"
  ${NSD_OnClick} ${OUT} ${CALLBACK}
  ${NSD_OnNotify} ${OUT} ${UN}DimoPaint
  SendMessage ${OUT} ${WM_SETFONT} $DimoFontBtn 1
!macroend

; Place a measured button so its body's right edge sits at $DimoFootX.
!macro DimoFootRight UN HWND KIND TEXT
  StrCpy $DimoRKind "${KIND}"
  StrCpy $DimoRText "${TEXT}"
  StrCpy $DimoRFont $DimoFontBtn
  Call ${UN}DimoButtonWidth
  IntOp $DimoFootX $DimoFootX - $DimoRW
  !insertmacro DimoPlaceDevX ${HWND} $DimoFootX 340 $DimoRW 40
  !insertmacro DimoScale $DimoT0 ${DIMO_RING}
  IntOp $DimoFootX $DimoFootX + $DimoT0
  IntOp $DimoFootX $DimoFootX + $DimoT0
  !insertmacro DimoScale $DimoT0 ${DIMO_BTN_GAP}
  IntOp $DimoFootX $DimoFootX - $DimoT0
!macroend

!macro DimoFootReset
  !insertmacro DimoScale $DimoFootX 496
  !insertmacro DimoScale $DimoT0 ${DIMO_RING}
  IntOp $DimoFootX $DimoFootX + $DimoT0
!macroend

!macro DimoFootLeft UN HWND KIND TEXT
  StrCpy $DimoRKind "${KIND}"
  StrCpy $DimoRText "${TEXT}"
  StrCpy $DimoRFont $DimoFontBtn
  Call ${UN}DimoButtonWidth
  !insertmacro DimoScale $DimoT1 ${DIMO_FOOT_X}
  !insertmacro DimoScale $DimoT0 ${DIMO_RING}
  IntOp $DimoT1 $DimoT1 - $DimoT0
  !insertmacro DimoPlaceDevX ${HWND} $DimoT1 340 $DimoRW 40
!macroend

!macro DimoSetText HWND TEXT
  SendMessage ${HWND} ${WM_SETTEXT} 0 "STR:${TEXT}"
!macroend

; ---------------------------------------------------------------------------
; Shared between installer and uninstaller
; ---------------------------------------------------------------------------
!macro DIMO_DEFINE_PAGES_SHARED UN

Function ${UN}DimoGuiInit
  ${If} ${Silent}
    Return
  ${EndIf}
  Call ${UN}DimoInitResources
  Call ${UN}DimoSetupWindow
  !insertmacro DimoLog "Dimo ${VERSION} setup log"
FunctionEnd

; Title bar (label + min/close) and brand lockup on $DimoParent.
; $DimoDialog != 0 means an nsDialogs page (interactive buttons).
Function ${UN}DimoBuildChrome
  !insertmacro DimoMakeStatic $DimoTitleLbl $DimoParent 0x50000380 "$DimoTitleText" 16 0 412 ${DIMO_TITLE_H}
  SendMessage $DimoTitleLbl ${WM_SETFONT} $DimoFontTitle 1
  !insertmacro DimoMutedColors $DimoTitleLbl
  ${If} $DimoParent == $DimoDialog
    ${NSD_OnClick} $DimoTitleLbl ${UN}DimoDragWindow
    !insertmacro DimoMakeButton "${UN}" $DimoMinBtn "min" "" ${UN}DimoMinimizeWindow
    !insertmacro DimoMakeButton "${UN}" $DimoCloseBtn "close" "" ${UN}DimoCloseWindow
    ${NSD_RemoveStyle} $DimoMinBtn ${WS_TABSTOP}
    ${NSD_RemoveStyle} $DimoCloseBtn ${WS_TABSTOP}
    !insertmacro DimoPlace $DimoMinBtn 428 0 ${DIMO_CAPTION_BTN_W} ${DIMO_TITLE_H}
    !insertmacro DimoPlace $DimoCloseBtn 474 0 ${DIMO_CAPTION_BTN_W} ${DIMO_TITLE_H}
  ${Else}
    ; instfiles page: static glyphs (the page cannot be cancelled mid-section)
    !insertmacro DimoMakeStatic $DimoMinBtn $DimoParent ${DIMO_STATIC_BITMAP} "" 428 0 ${DIMO_CAPTION_BTN_W} ${DIMO_TITLE_H}
    !insertmacro DimoMakeStatic $DimoCloseBtn $DimoParent ${DIMO_STATIC_BITMAP} "" 474 0 ${DIMO_CAPTION_BTN_W} ${DIMO_TITLE_H}
    !insertmacro DimoLabelColors $DimoMinBtn
    !insertmacro DimoLabelColors $DimoCloseBtn
    StrCpy $DimoSB $DimoMinBtn
    StrCpy $DimoSBKind "min"
    StrCpy $DimoSBText ""
    StrCpy $DimoSBState 0
    Call ${UN}DimoStaticButton
    StrCpy $DimoSB $DimoCloseBtn
    StrCpy $DimoSBKind "close"
    StrCpy $DimoSBState 8
    Call ${UN}DimoStaticButton
    !insertmacro DimoPlace $DimoMinBtn 428 0 ${DIMO_CAPTION_BTN_W} ${DIMO_TITLE_H}
    !insertmacro DimoPlace $DimoCloseBtn 474 0 ${DIMO_CAPTION_BTN_W} ${DIMO_TITLE_H}
  ${EndIf}

  !insertmacro DimoMakeStatic $DimoIconCtl $DimoParent ${DIMO_STATIC_BITMAP} "" 0 0 0 0
  !insertmacro DimoMakeStatic $DimoNameLbl $DimoParent ${DIMO_STATIC_CENTER} "${PRODUCTNAME}" 0 0 0 0
  !insertmacro DimoLabelColors $DimoNameLbl
  !insertmacro DimoMakeStatic $DimoSubLbl $DimoParent ${DIMO_STATIC_CENTER} "" 0 0 0 0
  SendMessage $DimoSubLbl ${WM_SETFONT} $DimoFontSub 1
  !insertmacro DimoMutedColors $DimoSubLbl
FunctionEnd

; Brand lockup: large (64px logo) or small (48px logo).
Function ${UN}DimoBrandLarge
  SendMessage $DimoIconCtl ${STM_SETIMAGE} ${IMAGE_BITMAP} $DimoIconBmp
  !insertmacro DimoPlace $DimoIconCtl 228 ${DIMO_BRAND_ICON_Y} ${DIMO_BRAND_ICON} ${DIMO_BRAND_ICON}
  SendMessage $DimoNameLbl ${WM_SETFONT} $DimoFontName 1
  !insertmacro DimoPlace $DimoNameLbl 32 ${DIMO_BRAND_NAME_Y} 456 ${DIMO_BRAND_NAME_H}
  !insertmacro DimoPlace $DimoSubLbl 32 ${DIMO_BRAND_SUB_Y} 456 ${DIMO_SUB_H}
FunctionEnd

Function ${UN}DimoBrandSmall
  SendMessage $DimoIconCtl ${STM_SETIMAGE} ${IMAGE_BITMAP} $DimoIconSmBmp
  !insertmacro DimoPlace $DimoIconCtl 236 ${DIMO_BRAND_SM_ICON_Y} ${DIMO_BRAND_SM_ICON} ${DIMO_BRAND_SM_ICON}
  SendMessage $DimoNameLbl ${WM_SETFONT} $DimoFontNameSm 1
  !insertmacro DimoPlace $DimoNameLbl 32 ${DIMO_BRAND_SM_NAME_Y} 456 ${DIMO_BRAND_SM_NAME_H}
  !insertmacro DimoPlace $DimoSubLbl 32 ${DIMO_BRAND_SM_SUB_Y} 456 ${DIMO_SUB_H}
FunctionEnd

; Create an empty nsDialogs page covering the whole window.
Function ${UN}DimoNewPage
  Call ${UN}DimoHideOuterControls
  nsDialogs::Create 1018
  Pop $DimoDialog
  ${If} $DimoDialog == error
    Abort
  ${EndIf}
  !insertmacro DimoPlace $DimoDialog 0 0 ${DIMO_WIN_W} ${DIMO_WIN_H}
  !insertmacro DimoLabelColors $DimoDialog
  StrCpy $DimoParent $DimoDialog
  Call ${UN}DimoBuildChrome
FunctionEnd

; Show the page with keyboard focus on $DimoFocusTarget.
Function ${UN}DimoShowPage
  ${NSD_CreateTimer} ${UN}DimoPageTick 120
  ShowWindow $HWNDPARENT 5
  nsDialogs::Show
FunctionEnd

Function ${UN}DimoApplyFocus
  ${If} $DimoFocusTarget != ""
  ${AndIf} $DimoFocusTarget != 0
    SendMessage $DimoDialog ${WM_NEXTDLGCTL} $DimoFocusTarget 1
    System::Call 'user32::SetFocus(p $DimoFocusTarget)'
    StrCpy $DimoFocusTarget 0
  ${EndIf}
FunctionEnd

Function ${UN}DimoFinishButton
  !insertmacro DimoMakeButton "${UN}" $DimoDoneBtn "pri" "$(DIMO_FINISH)" ${UN}DimoGoNext
  !insertmacro DimoFootReset
  !insertmacro DimoFootRight "${UN}" $DimoDoneBtn "pri" "$(DIMO_FINISH)"
  StrCpy $DimoFocusTarget $DimoDoneBtn
FunctionEnd

Function ${UN}DimoGoNext
  Pop $DimoT0
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

; Render a static "button" ($DimoSB) used on the instfiles page.
Function ${UN}DimoStaticButton
  StrCpy $DimoRKind $DimoSBKind
  StrCpy $DimoRText $DimoSBText
  StrCpy $DimoRFont $DimoFontBtn
  StrCpy $DimoRState $DimoSBState
  ${If} $DimoRKind == "min"
  ${OrIf} $DimoRKind == "close"
    !insertmacro DimoScale $DimoRW ${DIMO_CAPTION_BTN_W}
    !insertmacro DimoScale $DimoRH ${DIMO_TITLE_H}
  ${Else}
    Call ${UN}DimoButtonWidth
    StrCpy $DimoRText $DimoSBText
    !insertmacro DimoScale $DimoRH 40
  ${EndIf}
  Call ${UN}DimoRender
  !insertmacro DimoSetStaticBitmap $DimoSB
FunctionEnd

Function ${UN}DimoRenderBar
  ${If} $DimoBar == ""
  ${OrIf} $DimoBar == 0
    Return
  ${EndIf}
  StrCpy $DimoRKind "bar"
  StrCpy $DimoRText $DimoPermille
  StrCpy $DimoRState $DimoBarState
  !insertmacro DimoScale $DimoRW 456
  !insertmacro DimoScale $DimoRH ${DIMO_PROG_TRACK_H}
  Call ${UN}DimoRender
  !insertmacro DimoSetStaticBitmap $DimoBar
  !insertmacro DimoPlace $DimoBar 32 ${DIMO_PROG_TRACK_Y} 456 ${DIMO_PROG_TRACK_H}
FunctionEnd

; Restyle the MUI instfiles page into the progress view.
Function ${UN}DimoInstFilesShow
  SetAutoClose true
  ${If} ${Silent}
    Return
  ${EndIf}
  Call ${UN}DimoHideOuterControls
  StrCpy $DimoDialog 0
  FindWindow $DimoInstDlg "#32770" "" $HWNDPARENT
  !insertmacro DimoPlace $DimoInstDlg 0 0 ${DIMO_WIN_W} ${DIMO_WIN_H}
  !insertmacro DimoLabelColors $DimoInstDlg
  GetDlgItem $DimoT0 $DimoInstDlg 1027
  ShowWindow $DimoT0 0
  GetDlgItem $DimoT0 $DimoInstDlg 1016
  ShowWindow $DimoT0 0
  GetDlgItem $DimoT0 $DimoInstDlg 1004
  ShowWindow $DimoT0 0

  StrCpy $DimoParent $DimoInstDlg
  Call ${UN}DimoBuildChrome
  Call ${UN}DimoBrandSmall

  !insertmacro DimoMakeStatic $DimoErrIcon $DimoInstDlg 0x4000020E "" 32 ${DIMO_PROG_LABEL_Y} 14 ${DIMO_PROG_LABEL_H}
  !insertmacro DimoLabelColors $DimoErrIcon
  !insertmacro DimoMakeStatic $DimoStatusLbl $DimoInstDlg 0x50000280 "" 32 ${DIMO_PROG_LABEL_Y} 380 ${DIMO_PROG_LABEL_H}
  SendMessage $DimoStatusLbl ${WM_SETFONT} $DimoFontBody 1
  !insertmacro DimoLabelColors $DimoStatusLbl
  !insertmacro DimoMakeStatic $DimoPctLbl $DimoInstDlg 0x50000282 "0%" 412 ${DIMO_PROG_LABEL_Y} 76 ${DIMO_PROG_LABEL_H}
  SendMessage $DimoPctLbl ${WM_SETFONT} $DimoFontBody 1
  !insertmacro DimoMutedColors $DimoPctLbl
  !insertmacro DimoMakeStatic $DimoBar $DimoInstDlg ${DIMO_STATIC_BITMAP} "" 32 ${DIMO_PROG_TRACK_Y} 456 ${DIMO_PROG_TRACK_H}
  !insertmacro DimoLabelColors $DimoBar
  StrCpy $DimoPermille 0
  StrCpy $DimoBarState 0
  Call ${UN}DimoRenderBar

  ; NSIS's own detail line (1006) becomes the monospace file line; the static
  ; ellipsizes long paths in the middle.
  GetDlgItem $DimoFileLbl $DimoInstDlg 1006
  System::Call 'user32::GetWindowLongW(p $DimoFileLbl, i -16) i.s'
  Pop $DimoT0
  IntOp $DimoT0 $DimoT0 & 0xFFFFFFF0
  IntOp $DimoT0 $DimoT0 | 0x8080 ; SS_PATHELLIPSIS | SS_NOPREFIX
  System::Call 'user32::SetWindowLongW(p $DimoFileLbl, i -16, i $DimoT0)'
  SendMessage $DimoFileLbl ${WM_SETFONT} $DimoFontMono 1
  !insertmacro DimoMutedColors $DimoFileLbl
  !insertmacro DimoPlace $DimoFileLbl 32 ${DIMO_PROG_FILE_Y} 456 ${DIMO_PROG_FILE_H}
  !insertmacro DimoSetText $DimoFileLbl ""

  ; Only a (disabled) Cancel in the footer: NSIS cannot abort a running section.
  !insertmacro DimoMakeStatic $DimoProgCancel $DimoInstDlg ${DIMO_STATIC_BITMAP} "" 0 0 0 0
  !insertmacro DimoLabelColors $DimoProgCancel
  StrCpy $DimoSB $DimoProgCancel
  StrCpy $DimoSBKind "sec"
  StrCpy $DimoSBText "$(DIMO_CANCEL)"
  StrCpy $DimoSBState 8
  Call ${UN}DimoStaticButton
  !insertmacro DimoFootReset
  !insertmacro DimoFootRight "${UN}" $DimoProgCancel "sec" "$(DIMO_CANCEL)"

  ${If} $DimoAction == "uninstall"
    !insertmacro DimoSetText $DimoSubLbl "$(DIMO_UNINSTALLING)"
    !insertmacro DimoSetText $DimoStatusLbl "$(DIMO_PROGRESS_UNINSTALL)"
  ${Else}
    !insertmacro DimoSetText $DimoSubLbl "$(DIMO_INSTALLING)"
    !insertmacro DimoSetText $DimoStatusLbl "$(DIMO_PROGRESS_PREPARE)"
  ${EndIf}
  ShowWindow $HWNDPARENT 5
FunctionEnd

; Mirror NSIS's hidden progress bar (1004) into the custom bar + percentage.
Function ${UN}DimoTick
  ${If} ${Silent}
  ${OrIf} $DimoInstDlg == ""
  ${OrIf} $DimoInstDlg == 0
    Return
  ${EndIf}
  GetDlgItem $DimoT0 $DimoInstDlg 1004
  SendMessage $DimoT0 ${PBM_GETPOS} 0 0 $DimoT1
  SendMessage $DimoT0 ${PBM_GETRANGE} 0 0 $DimoT2
  ${If} $DimoT2 <= 0
    Return
  ${EndIf}
  IntOp $DimoT1 $DimoT1 * 1000
  IntOp $DimoT1 $DimoT1 / $DimoT2
  ${If} $DimoT1 == $DimoPermille
    Return
  ${EndIf}
  StrCpy $DimoPermille $DimoT1
  Call ${UN}DimoRenderBar
  IntOp $DimoT1 $DimoPermille / 10
  !insertmacro DimoSetText $DimoPctLbl "$DimoT1%"
FunctionEnd

; Finish the bar when a section's work is done.
Function ${UN}DimoTickDone
  ${If} $DimoBar == ""
  ${OrIf} $DimoBar == 0
    Return
  ${EndIf}
  StrCpy $DimoPermille 1000
  Call ${UN}DimoRenderBar
  !insertmacro DimoSetText $DimoPctLbl "100%"
FunctionEnd

!macroend

!macro DimoSetStage UN TEXT
  ${IfNot} ${Silent}
  ${AndIf} $DimoStatusLbl != ""
    !insertmacro DimoSetText $DimoStatusLbl "${TEXT}"
    Call ${UN}DimoTick
  ${EndIf}
  !insertmacro DimoLog "${TEXT}"
!macroend

!insertmacro DIMO_DEFINE_DRAWING ""
!insertmacro DIMO_DEFINE_DRAWING "un."
!insertmacro DIMO_DEFINE_PAGES_SHARED ""
!insertmacro DIMO_DEFINE_PAGES_SHARED "un."

; ---------------------------------------------------------------------------
; Installer pages
; ---------------------------------------------------------------------------
Function DimoDetectExisting
  StrCpy $DimoHasExisting 0
  StrCpy $DimoExistingVersion ""
  StrCpy $0 0
  dimo_wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" dimo_wix_done
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 dimo_wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 dimo_wix_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    ReadRegStr $DimoExistingVersion HKLM "$R6" "DisplayVersion"
    StrCpy $DimoHasExisting 1
    Return
  dimo_wix_done:

  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} "$R0$R1" != ""
    StrCpy $DimoHasExisting 1
    ReadRegStr $DimoExistingVersion SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
FunctionEnd

Function DimoGuiInitInstaller
  StrCpy $DimoTitleText "$(DIMO_TITLE_SETUP)"
  Call DimoGuiInit
FunctionEnd

Function DimoPageMain
  Call DimoDetectExisting
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    StrCpy $DimoAction "install"
    ${If} $DimoHasExisting = 1
      StrCpy $DimoAction "reinstall"
    ${EndIf}
    Abort
  ${EndIf}
  ${If} $DimoHasExisting = 1
    StrCpy $DimoPhase "existing"
    StrCpy $DimoAction "reinstall"
  ${Else}
    StrCpy $DimoPhase "welcome"
    StrCpy $DimoAction "install"
  ${EndIf}

  Call DimoNewPage

  ; welcome
  !insertmacro DimoMakeButton "" $DimoBigBtn "prilg" "$(DIMO_INSTALL_NOW)" DimoOnInstall
  SendMessage $DimoBigBtn ${WM_SETFONT} $DimoFontBtnLg 1
  !insertmacro DimoPlace $DimoBigBtn 156 240 208 48
  !insertmacro DimoMakeButton "" $DimoLinkBtn "link" "$(DIMO_CUSTOMIZE)" DimoOnCustomize
  SendMessage $DimoLinkBtn ${WM_SETFONT} $DimoFontBody 1
  StrCpy $DimoRText "$(DIMO_CUSTOMIZE)"
  StrCpy $DimoRFont $DimoFontBody
  Call DimoMeasure
  !insertmacro DimoScale $DimoT0 16
  IntOp $DimoRW $DimoRW + $DimoT0
  !insertmacro DimoScale $DimoT0 ${DIMO_WIN_W}
  IntOp $DimoT0 $DimoT0 - $DimoRW
  IntOp $DimoT0 $DimoT0 / 2
  !insertmacro DimoPlaceDevX $DimoLinkBtn $DimoT0 ${DIMO_WELCOME_LINK_Y} $DimoRW 24

  ; custom location
  !insertmacro DimoMakeStatic $DimoLocLbl $DimoDialog ${DIMO_STATIC_TEXT} "$(DIMO_LOCATION)" 32 ${DIMO_LOC_LABEL_Y} 456 18
  SendMessage $DimoLocLbl ${WM_SETFONT} $DimoFontSub 1
  !insertmacro DimoMutedColors $DimoLocLbl
  !insertmacro DimoMakeButton "" $DimoBrowseBtn "sec" "$(DIMO_BROWSE)" DimoOnBrowse
  StrCpy $DimoRKind "sec"
  StrCpy $DimoRText "$(DIMO_BROWSE)"
  StrCpy $DimoRFont $DimoFontBtn
  Call DimoButtonWidth
  !insertmacro DimoScale $DimoT1 488
  !insertmacro DimoScale $DimoT0 ${DIMO_RING}
  IntOp $DimoT1 $DimoT1 + $DimoT0
  IntOp $DimoT1 $DimoT1 - $DimoRW
  !insertmacro DimoPlaceDevX $DimoBrowseBtn $DimoT1 236 $DimoRW 40
  ; field spans from x=32 to the browse body minus an 8px gap
  IntOp $DimoT1 $DimoT1 + $DimoT0
  !insertmacro DimoScale $DimoT0 40
  IntOp $DimoT1 $DimoT1 - $DimoT0 ; field width (device)
  IntOp $DimoT0 ${DIMO_STATIC_BITMAP} | 0x04000000 ; WS_CLIPSIBLINGS: never paint over the edit
  !insertmacro DimoMakeStatic $DimoField $DimoDialog $DimoT0 "" 0 0 0 0
  !insertmacro DimoLabelColors $DimoField
  !insertmacro DimoScale $DimoT0 32
  !insertmacro DimoPlaceDevX $DimoField $DimoT0 ${DIMO_LOC_FIELD_Y} $DimoT1 32
  StrCpy $DimoFieldBmpState ""
  ${NSD_CreateText} 0 0 0 0 "$INSTDIR"
  Pop $DimoEdit
  System::Call 'user32::GetWindowLongW(p $DimoEdit, i -16) i.s'
  Pop $DimoT0
  IntOp $DimoT0 $DimoT0 & 0xFF7FFFFF ; no WS_BORDER
  System::Call 'user32::SetWindowLongW(p $DimoEdit, i -16, i $DimoT0)'
  System::Call 'user32::GetWindowLongW(p $DimoEdit, i -20) i.s'
  Pop $DimoT0
  IntOp $DimoT0 $DimoT0 & 0xFFFFFDFF ; no WS_EX_CLIENTEDGE
  System::Call 'user32::SetWindowLongW(p $DimoEdit, i -20, i $DimoT0)'
  SendMessage $DimoEdit ${WM_SETFONT} $DimoFontBody 1
  SendMessage $DimoEdit ${EM_SETLIMITTEXT} 240 0
  !insertmacro DimoFieldColors $DimoEdit
  ; text starts after the 16px folder glyph (x=12..28 inside the field) + 8px gap
  !insertmacro DimoScale $DimoT0 68
  !insertmacro DimoScale $DimoT2 48
  IntOp $DimoT2 $DimoT1 - $DimoT2
  !insertmacro DimoPlaceDevX $DimoEdit $DimoT0 248 $DimoT2 18
  System::Call 'user32::SetWindowPos(p $DimoEdit, p 0, i 0, i 0, i 0, i 0, i 0x33)'
  !insertmacro DimoMakeStatic $DimoMetaLbl $DimoDialog ${DIMO_STATIC_TEXT} "" 32 ${DIMO_LOC_META_Y} 456 16
  SendMessage $DimoMetaLbl ${WM_SETFONT} $DimoFontSub 1
  !insertmacro DimoMutedColors $DimoMetaLbl
  StrCpy $DimoLastPath ""
  !insertmacro DimoMakeButton "" $DimoBackBtn "ghost" "$(DIMO_BACK)" DimoOnBack
  !insertmacro DimoFootLeft "" $DimoBackBtn "ghost" "$(DIMO_BACK)"
  !insertmacro DimoMakeButton "" $DimoInstallBtn "pri" "$(DIMO_INSTALL)" DimoOnInstall
  !insertmacro DimoFootReset
  !insertmacro DimoFootRight "" $DimoInstallBtn "pri" "$(DIMO_INSTALL)"

  ; existing installation
  !insertmacro DimoMakeStatic $DimoPathLbl $DimoDialog 0x50008081 "$INSTDIR" 32 214 456 16
  SendMessage $DimoPathLbl ${WM_SETFONT} $DimoFontMono 1
  !insertmacro DimoMutedColors $DimoPathLbl
  !insertmacro DimoMakeButton "" $DimoReinstallBtn "pri" "$(DIMO_REINSTALL)" DimoOnInstall
  !insertmacro DimoMakeButton "" $DimoUninstallBtn "danger" "$(DIMO_UNINSTALL)" DimoOnUninstall
  !insertmacro DimoFootReset
  !insertmacro DimoFootRight "" $DimoReinstallBtn "pri" "$(DIMO_REINSTALL)"
  ; Keep the destructive action away from the primary one.
  !insertmacro DimoFootLeft "" $DimoUninstallBtn "danger" "$(DIMO_UNINSTALL)"

  Call DimoApplyPhase
  Call DimoShowPage
FunctionEnd

Function DimoApplyPhase
  ShowWindow $DimoBigBtn 0
  ShowWindow $DimoLinkBtn 0
  ShowWindow $DimoLocLbl 0
  ShowWindow $DimoField 0
  ShowWindow $DimoEdit 0
  ShowWindow $DimoBrowseBtn 0
  ShowWindow $DimoMetaLbl 0
  ShowWindow $DimoBackBtn 0
  ShowWindow $DimoInstallBtn 0
  ShowWindow $DimoPathLbl 0
  ShowWindow $DimoReinstallBtn 0
  ShowWindow $DimoUninstallBtn 0
  ${If} $DimoPhase == "location"
    Call DimoBrandSmall
    !insertmacro DimoSetText $DimoSubLbl "$(DIMO_VERSION_FMT)"
    ${NSD_SetText} $DimoEdit "$INSTDIR"
    StrCpy $DimoLastPath ""
    StrCpy $DimoFieldBmpState ""
    Call DimoUpdateLocation
    ShowWindow $DimoLocLbl 5
    ShowWindow $DimoField 5
    ShowWindow $DimoEdit 5
    ShowWindow $DimoBrowseBtn 5
    ShowWindow $DimoMetaLbl 5
    ShowWindow $DimoBackBtn 5
    ShowWindow $DimoInstallBtn 5
    StrCpy $DimoFocusTarget $DimoInstallBtn
  ${ElseIf} $DimoPhase == "existing"
    Call DimoBrandLarge
    !insertmacro DimoSetText $DimoSubLbl "$(DIMO_INSTALLED_FMT) $DimoExistingVersion"
    !insertmacro DimoSetText $DimoPathLbl "$INSTDIR"
    ShowWindow $DimoPathLbl 5
    ShowWindow $DimoReinstallBtn 5
    ShowWindow $DimoUninstallBtn 5
    StrCpy $DimoFocusTarget $DimoReinstallBtn
  ${Else}
    Call DimoBrandLarge
    !insertmacro DimoSetText $DimoSubLbl "$(DIMO_VERSION_FMT)"
    ShowWindow $DimoBigBtn 5
    ShowWindow $DimoLinkBtn 5
    StrCpy $DimoFocusTarget $DimoBigBtn
  ${EndIf}
  Call DimoApplyFocus
  System::Call 'user32::InvalidateRect(p $DimoDialog, p 0, i 1)'
FunctionEnd

; Timer: deferred initial focus, live free-space + field focus ring.
Function DimoPageTick
  Call DimoApplyFocus
  ${If} $DimoPhase == "location"
    Call DimoUpdateLocation
  ${EndIf}
FunctionEnd

Function DimoUpdateLocation
  ; focus ring on the path field follows the edit's focus
  System::Call 'user32::GetFocus() p.s'
  Pop $DimoT0
  StrCpy $DimoT1 "field"
  ${If} $DimoT0 == $DimoEdit
    StrCpy $DimoT1 "fieldfocus"
  ${EndIf}
  ${If} $DimoT1 != $DimoFieldBmpState
    StrCpy $DimoFieldBmpState $DimoT1
    StrCpy $DimoRKind $DimoT1
    StrCpy $DimoRText ""
    StrCpy $DimoRState 0
    System::Call '*(i 0, i 0, i 0, i 0) p.s'
    Pop $DimoT2
    System::Call 'user32::GetClientRect(p $DimoField, p $DimoT2)'
    System::Call '*$DimoT2(i, i, i .s, i .s)'
    Pop $DimoRW
    Pop $DimoRH
    System::Free $DimoT2
    Call DimoRender
    !insertmacro DimoSetStaticBitmap $DimoField
    System::Call 'user32::InvalidateRect(p $DimoEdit, p 0, i 1)'
  ${EndIf}

  ${NSD_GetText} $DimoEdit $DimoT3
  ${If} $DimoT3 == $DimoLastPath
    Return
  ${EndIf}
  StrCpy $DimoLastPath $DimoT3
  SectionGetSize ${DIMO_SEC_INSTALL} $DimoT4
  IntOp $DimoT4 $DimoT4 + 1023
  IntOp $DimoT4 $DimoT4 / 1024
  ${If} $DimoT4 < 1
    StrCpy $DimoT4 1
  ${EndIf}
  ${GetRoot} "$DimoT3" $DimoT5
  StrCpy $DimoT6 "—"
  ${If} $DimoT5 != ""
    ClearErrors
    ${DriveSpace} "$DimoT5\" "/D=F /S=M" $DimoT7
    ${IfNot} ${Errors}
      IntOp $DimoT7 $DimoT7 * 10
      IntOp $DimoT7 $DimoT7 / 1024
      IntOp $DimoT8 $DimoT7 % 10
      IntOp $DimoT7 $DimoT7 / 10
      StrCpy $DimoT6 "$DimoT7.$DimoT8"
    ${EndIf}
  ${EndIf}
  !insertmacro DimoSetText $DimoMetaLbl "$(DIMO_SPACE_REQUIRED) $DimoT4 MB · $(DIMO_SPACE_FREE) $DimoT6 GB$(DIMO_PAREN_L)$DimoT5$(DIMO_PAREN_R)"
FunctionEnd

Function DimoOnCustomize
  Pop $DimoT0
  StrCpy $DimoPhase "location"
  Call DimoApplyPhase
FunctionEnd

Function DimoOnBack
  Pop $DimoT0
  StrCpy $DimoPhase "welcome"
  Call DimoApplyPhase
FunctionEnd

Function DimoOnBrowse
  Pop $DimoT0
  ${NSD_GetText} $DimoEdit $DimoT1
  nsDialogs::SelectFolderDialog "$(DIMO_CHOOSE_PATH)" "$DimoT1"
  Pop $DimoT1
  ${If} $DimoT1 != "error"
  ${AndIf} $DimoT1 != ""
    StrLen $DimoT2 "${PRODUCTNAME}"
    IntOp $DimoT2 0 - $DimoT2
    StrCpy $DimoT3 $DimoT1 "" $DimoT2
    ${If} $DimoT3 != "${PRODUCTNAME}"
      StrCpy $DimoT3 $DimoT1 "" -1
      ${If} $DimoT3 == "\"
        StrCpy $DimoT1 "$DimoT1${PRODUCTNAME}"
      ${Else}
        StrCpy $DimoT1 "$DimoT1\${PRODUCTNAME}"
      ${EndIf}
    ${EndIf}
    ${NSD_SetText} $DimoEdit $DimoT1
    Call DimoUpdateLocation
  ${EndIf}
FunctionEnd

Function DimoOnInstall
  Pop $DimoT0
  ${If} $DimoPhase == "existing"
    StrCpy $DimoAction "reinstall"
  ${EndIf}
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

Function DimoOnUninstall
  Pop $DimoT0
  StrCpy $DimoAction "uninstall"
  SendMessage $HWNDPARENT ${WM_NOTIFY_OUTER_NEXT} 1 0
FunctionEnd

Function DimoPageMainLeave
  ${If} $DimoPhase == "location"
    ${NSD_GetText} $DimoEdit $DimoT0
    ${If} $DimoT0 == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(DIMO_PATH_INVALID)"
      Abort
    ${EndIf}
    StrCpy $INSTDIR $DimoT0
  ${EndIf}
  ; Reinstalling over a previous WiX MSI installation: remove the MSI first.
  ${If} $DimoAction == "reinstall"
  ${AndIf} $WixMode = 1
    ReadRegStr $R1 HKLM "$R6" "UninstallString"
    ${If} $R1 != ""
      HideWindow
      ExecWait '$R1' $0
      BringToFront
    ${EndIf}
  ${EndIf}
  !insertmacro DimoLog "action=$DimoAction instdir=$INSTDIR"
FunctionEnd

Function DimoPageFinish
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}
  Call DimoNewPage
  Call DimoBrandLarge
  ${If} $DimoAction == "uninstall"
    !insertmacro DimoSetText $DimoSubLbl "$(DIMO_UNINSTALLED_DONE)"
    StrCpy $DimoCheck 0
  ${Else}
    !insertmacro DimoSetText $DimoSubLbl "$(DIMO_INSTALL_DONE)"
    ${NSD_CreateCheckbox} 0 0 0 0 "$(DIMO_LAUNCH_NOW)"
    Pop $DimoCheck
    nsDialogs::SetUserData $DimoCheck "check"
    ${NSD_OnNotify} $DimoCheck DimoPaint
    SendMessage $DimoCheck ${WM_SETFONT} $DimoFontBody 1
    ${NSD_Check} $DimoCheck
    StrCpy $DimoRText "$(DIMO_LAUNCH_NOW)"
    StrCpy $DimoRFont $DimoFontBody
    Call DimoMeasure
    !insertmacro DimoScale $DimoT0 32
    IntOp $DimoRW $DimoRW + $DimoT0
    !insertmacro DimoScale $DimoT0 ${DIMO_WIN_W}
    IntOp $DimoT0 $DimoT0 - $DimoRW
    IntOp $DimoT0 $DimoT0 / 2
    !insertmacro DimoPlaceDevX $DimoCheck $DimoT0 ${DIMO_CHECK_Y} $DimoRW ${DIMO_CHECK_H}
  ${EndIf}
  Call DimoFinishButton
  Call DimoShowPage
FunctionEnd

Function DimoPageFinishLeave
  ${If} $DimoCheck != 0
    ${NSD_GetState} $DimoCheck $0
    HideWindow
    ${If} $0 == ${BST_CHECKED}
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    ${EndIf}
  ${EndIf}
FunctionEnd

; --- Error state on the progress page -------------------------------------
Function DimoRedrawErrorButtons
  StrCpy $DimoSB $DimoLogBtn
  StrCpy $DimoSBKind "ghost"
  StrCpy $DimoSBText "$(DIMO_VIEW_LOG)"
  StrCpy $DimoSBState 0
  ${If} $DimoHover == $DimoLogBtn
    StrCpy $DimoSBState 1
  ${EndIf}
  Call DimoStaticButton
  StrCpy $DimoSB $DimoErrCancel
  StrCpy $DimoSBKind "sec"
  StrCpy $DimoSBText "$(DIMO_CANCEL)"
  StrCpy $DimoSBState 0
  ${If} $DimoHover == $DimoErrCancel
    StrCpy $DimoSBState 1
  ${EndIf}
  Call DimoStaticButton
  StrCpy $DimoSB $DimoRetryBtn
  StrCpy $DimoSBKind "pri"
  StrCpy $DimoSBText "$(DIMO_RETRY)"
  StrCpy $DimoSBState 4 ; default action: focus ring, Enter retries
  ${If} $DimoHover == $DimoRetryBtn
    StrCpy $DimoSBState 5
  ${EndIf}
  Call DimoStaticButton
  StrCpy $DimoSB $DimoCloseBtn
  StrCpy $DimoSBKind "close"
  StrCpy $DimoSBText ""
  StrCpy $DimoSBState 0
  ${If} $DimoHover == $DimoCloseBtn
    StrCpy $DimoSBState 1
  ${EndIf}
  Call DimoStaticButton
  !insertmacro DimoPlace $DimoCloseBtn 474 0 ${DIMO_CAPTION_BTN_W} ${DIMO_TITLE_H}
FunctionEnd

!macro DimoKeyEdge VK STATEVAR LABEL
  System::Call 'user32::GetAsyncKeyState(i ${VK}) i.s'
  Pop $DimoT0
  IntOp $DimoT0 $DimoT0 & 0x8000
  ${If} $DimoT0 != 0
    ${If} ${STATEVAR} == 0
      StrCpy ${STATEVAR} 1
      ${If} $DimoT1 == 1
        Goto ${LABEL}
      ${EndIf}
    ${EndIf}
  ${Else}
    StrCpy ${STATEVAR} 0
  ${EndIf}
!macroend

; Show the error view and wait (on the section thread) for Retry / Cancel.
; Inputs: $DimoErrTitle, $DimoErrCode. Returns when the user picks Retry.
Function DimoShowError
  !insertmacro DimoLog "error: $DimoErrTitle ($DimoErrCode)"
  ${If} $DimoInstDlg == ""
  ${OrIf} $DimoInstDlg == 0
    Abort "$DimoErrTitle"
  ${EndIf}
  ; stop the bar in the error color, red status with glyph, code in the file line
  StrCpy $DimoBarState 32
  Call DimoRenderBar
  StrCpy $DimoRKind "erricon"
  StrCpy $DimoRText ""
  StrCpy $DimoRState 0
  !insertmacro DimoScale $DimoRW 14
  StrCpy $DimoRH $DimoRW
  Call DimoRender
  !insertmacro DimoSetStaticBitmap $DimoErrIcon
  !insertmacro DimoPlace $DimoErrIcon 32 238 14 14
  ShowWindow $DimoErrIcon 5
  !insertmacro DimoPlace $DimoStatusLbl 52 ${DIMO_PROG_LABEL_Y} 360 ${DIMO_PROG_LABEL_H}
  !insertmacro DimoErrorColors $DimoStatusLbl
  !insertmacro DimoSetText $DimoStatusLbl "$DimoErrTitle"
  !insertmacro DimoSetText $DimoSubLbl "$(DIMO_INSTALL_FAILED)"
  SetDetailsPrint none
  !insertmacro DimoSetText $DimoFileLbl "$(DIMO_ERROR_HINT) $DimoErrCode"

  ShowWindow $DimoProgCancel 0
  ${If} $DimoRetryBtn == ""
    !insertmacro DimoMakeStatic $DimoLogBtn $DimoInstDlg ${DIMO_STATIC_HIT} "" 0 0 0 0
    !insertmacro DimoMakeStatic $DimoErrCancel $DimoInstDlg ${DIMO_STATIC_HIT} "" 0 0 0 0
    !insertmacro DimoMakeStatic $DimoRetryBtn $DimoInstDlg ${DIMO_STATIC_HIT} "" 0 0 0 0
    !insertmacro DimoLabelColors $DimoLogBtn
    !insertmacro DimoLabelColors $DimoErrCancel
    !insertmacro DimoLabelColors $DimoRetryBtn
    ; the title-bar close becomes live while waiting
    System::Call 'user32::GetWindowLongW(p $DimoCloseBtn, i -16) i.s'
    Pop $DimoT0
    IntOp $DimoT0 $DimoT0 | 0x100
    System::Call 'user32::SetWindowLongW(p $DimoCloseBtn, i -16, i $DimoT0)'
  ${EndIf}
  StrCpy $DimoHover 0
  Call DimoRedrawErrorButtons
  !insertmacro DimoFootLeft "" $DimoLogBtn "ghost" "$(DIMO_VIEW_LOG)"
  !insertmacro DimoFootReset
  !insertmacro DimoFootRight "" $DimoRetryBtn "pri" "$(DIMO_RETRY)"
  !insertmacro DimoFootRight "" $DimoErrCancel "sec" "$(DIMO_CANCEL)"
  ShowWindow $DimoLogBtn 5
  ShowWindow $DimoErrCancel 5
  ShowWindow $DimoRetryBtn 5
  System::Call 'user32::InvalidateRect(p $DimoInstDlg, p 0, i 1)'

  StrCpy $DimoMouseDown 1
  StrCpy $DimoKeyEnter 1
  StrCpy $DimoKeyEsc 1
  System::Call '*(i 0, i 0) p.s'
  Pop $DimoT9
  dimo_err_loop:
    Sleep 30
    System::Call 'user32::GetCursorPos(p $DimoT9)'
    System::Call '*$DimoT9(i .s, i .s)'
    Pop $DimoT2
    Pop $DimoT3
    System::Call 'user32::WindowFromPoint(i $DimoT2, i $DimoT3) p.s'
    Pop $DimoT4
    ${If} $DimoT4 != $DimoLogBtn
    ${AndIf} $DimoT4 != $DimoErrCancel
    ${AndIf} $DimoT4 != $DimoRetryBtn
    ${AndIf} $DimoT4 != $DimoCloseBtn
      StrCpy $DimoT4 0
    ${EndIf}
    ${If} $DimoT4 != $DimoHover
      StrCpy $DimoHover $DimoT4
      Push $DimoT9
      Call DimoRedrawErrorButtons
      Pop $DimoT9
    ${EndIf}
    System::Call 'user32::GetAsyncKeyState(i 1) i.s'
    Pop $DimoT0
    IntOp $DimoT0 $DimoT0 & 0x8000
    ${If} $DimoT0 != 0
      ${If} $DimoMouseDown == 0
        StrCpy $DimoMouseDown 1
        ${If} $DimoHover == $DimoRetryBtn
          Goto dimo_err_retry
        ${ElseIf} $DimoHover == $DimoErrCancel
        ${OrIf} $DimoHover == $DimoCloseBtn
          Goto dimo_err_cancel
        ${ElseIf} $DimoHover == $DimoLogBtn
          ExecShell "open" "$PLUGINSDIR\install.log"
        ${EndIf}
      ${EndIf}
    ${Else}
      StrCpy $DimoMouseDown 0
    ${EndIf}
    System::Call 'user32::GetForegroundWindow() p.s'
    Pop $DimoT1
    ${If} $DimoT1 == $HWNDPARENT
      StrCpy $DimoT1 1
    ${Else}
      StrCpy $DimoT1 0
    ${EndIf}
    !insertmacro DimoKeyEdge 0x0D $DimoKeyEnter dimo_err_retry
    !insertmacro DimoKeyEdge 0x1B $DimoKeyEsc dimo_err_cancel
    Goto dimo_err_loop

  dimo_err_cancel:
    System::Free $DimoT9
    !insertmacro DimoLog "cancelled by user"
    Quit

  dimo_err_retry:
    System::Free $DimoT9
    !insertmacro DimoLog "retry"
    ShowWindow $DimoLogBtn 0
    ShowWindow $DimoErrCancel 0
    ShowWindow $DimoRetryBtn 0
    ShowWindow $DimoErrIcon 0
    ShowWindow $DimoProgCancel 5
    StrCpy $DimoSB $DimoCloseBtn
    StrCpy $DimoSBKind "close"
    StrCpy $DimoSBText ""
    StrCpy $DimoSBState 8
    Call DimoStaticButton
    !insertmacro DimoPlace $DimoCloseBtn 474 0 ${DIMO_CAPTION_BTN_W} ${DIMO_TITLE_H}
    !insertmacro DimoPlace $DimoStatusLbl 32 ${DIMO_PROG_LABEL_Y} 380 ${DIMO_PROG_LABEL_H}
    !insertmacro DimoLabelColors $DimoStatusLbl
    !insertmacro DimoSetText $DimoSubLbl "$(DIMO_INSTALLING)"
    !insertmacro DimoSetText $DimoFileLbl ""
    SetDetailsPrint both
    StrCpy $DimoBarState 0
    Call DimoRenderBar
    System::Call 'user32::InvalidateRect(p $DimoInstDlg, p 0, i 1)'
FunctionEnd

; ---------------------------------------------------------------------------
; Uninstaller pages
; ---------------------------------------------------------------------------
Function un.DimoGuiInitUninstaller
  StrCpy $DimoTitleText "$(DIMO_TITLE_UNINSTALL)"
  StrCpy $DimoAction "uninstall"
  Call un.DimoGuiInit
FunctionEnd

Function un.DimoPageTick
  Call un.DimoApplyFocus
FunctionEnd

Function un.DimoPageConfirm
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  Call un.DimoNewPage
  Call un.DimoBrandLarge
  !insertmacro DimoSetText $DimoSubLbl "$(DIMO_UNINSTALL_SUB)"
  ${NSD_CreateCheckbox} 0 0 0 0 "$(DIMO_DELETE_DATA)"
  Pop $DimoCheck
  nsDialogs::SetUserData $DimoCheck "check"
  ${NSD_OnNotify} $DimoCheck un.DimoPaint
  SendMessage $DimoCheck ${WM_SETFONT} $DimoFontBody 1
  ${If} $DeleteAppDataCheckboxState = 1
    ${NSD_Check} $DimoCheck
  ${EndIf}
  StrCpy $DimoRText "$(DIMO_DELETE_DATA)"
  StrCpy $DimoRFont $DimoFontBody
  Call un.DimoMeasure
  !insertmacro DimoScale $DimoT0 32
  IntOp $DimoRW $DimoRW + $DimoT0
  !insertmacro DimoScale $DimoT0 ${DIMO_WIN_W}
  IntOp $DimoT0 $DimoT0 - $DimoRW
  IntOp $DimoT0 $DimoT0 / 2
  !insertmacro DimoPlaceDevX $DimoCheck $DimoT0 ${DIMO_CHECK_Y} $DimoRW ${DIMO_CHECK_H}

  !insertmacro DimoMakeButton "un." $DimoDoneBtn "danger" "$(DIMO_UNINSTALL)" un.DimoGoNext
  !insertmacro DimoMakeButton "un." $DimoCancelBtn "sec" "$(DIMO_CANCEL)" un.DimoCloseWindow
  !insertmacro DimoFootReset
  !insertmacro DimoFootRight "un." $DimoDoneBtn "danger" "$(DIMO_UNINSTALL)"
  !insertmacro DimoFootRight "un." $DimoCancelBtn "sec" "$(DIMO_CANCEL)"
  ; Destructive action is never the default: focus starts on Cancel.
  StrCpy $DimoFocusTarget $DimoCancelBtn
  Call un.DimoShowPage
FunctionEnd

Function un.DimoPageConfirmLeave
  ${NSD_GetState} $DimoCheck $DeleteAppDataCheckboxState
  ${If} $DeleteAppDataCheckboxState == ${BST_CHECKED}
    StrCpy $DeleteAppDataCheckboxState 1
  ${Else}
    StrCpy $DeleteAppDataCheckboxState 0
  ${EndIf}
FunctionEnd

Function un.DimoPageFinish
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}
  Call un.DimoNewPage
  Call un.DimoBrandLarge
  !insertmacro DimoSetText $DimoSubLbl "$(DIMO_UNINSTALLED_DONE)"
  Call un.DimoFinishButton
  Call un.DimoShowPage
FunctionEnd

!endif
