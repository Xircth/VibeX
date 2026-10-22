; VibeX NSIS Installer Hooks Entrypoint
!ifndef VIBEX_INSTALLER_HOOKS
!define VIBEX_INSTALLER_HOOKS

!define VIBEX_INSTALLER_DIR "${__FILEDIR__}"
!include "${__FILEDIR__}\theme.nsh"
!include "${__FILEDIR__}\drawing.nsh"
!include "${__FILEDIR__}\pages.nsh"

!endif
