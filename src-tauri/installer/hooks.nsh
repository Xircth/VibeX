; Dimo NSIS Installer Hooks Entrypoint
!ifndef DIMO_INSTALLER_HOOKS
!define DIMO_INSTALLER_HOOKS

!define DIMO_INSTALLER_DIR "${__FILEDIR__}"
!include "${__FILEDIR__}\theme.nsh"
!include "${__FILEDIR__}\drawing.nsh"
!include "${__FILEDIR__}\pages.nsh"

!endif
