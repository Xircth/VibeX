; VibeX installer localized strings (SimpChinese + English)
!ifndef VIBEX_INSTALLER_STRINGS
!define VIBEX_INSTALLER_STRINGS

!macro VIBEX_STR ID ZH EN
  !ifdef LANG_SIMPCHINESE
    LangString ${ID} ${LANG_SIMPCHINESE} "${ZH}"
  !endif
  !ifdef LANG_ENGLISH
    LangString ${ID} ${LANG_ENGLISH} "${EN}"
  !endif
!macroend

!insertmacro VIBEX_STR VIBEX_TITLE_SETUP "${PRODUCTNAME} 安装程序" "${PRODUCTNAME} Setup"
!insertmacro VIBEX_STR VIBEX_TITLE_UNINSTALL "${PRODUCTNAME} 卸载程序" "${PRODUCTNAME} Uninstall"
!insertmacro VIBEX_STR VIBEX_VERSION_FMT "版本 ${VERSION}" "Version ${VERSION}"
!insertmacro VIBEX_STR VIBEX_INSTALL_NOW "立即安装" "Install now"
!insertmacro VIBEX_STR VIBEX_CUSTOMIZE "自定义安装位置 ›" "Customize location ›"
!insertmacro VIBEX_STR VIBEX_LOCATION "安装位置" "Install location"
!insertmacro VIBEX_STR VIBEX_BROWSE "浏览…" "Browse…"
!insertmacro VIBEX_STR VIBEX_CHOOSE_PATH "选择安装位置" "Choose install location"
!insertmacro VIBEX_STR VIBEX_SPACE_REQUIRED "所需空间" "Required"
!insertmacro VIBEX_STR VIBEX_SPACE_FREE "可用空间" "Available"
!insertmacro VIBEX_STR VIBEX_PAREN_L "（" " ("
!insertmacro VIBEX_STR VIBEX_PAREN_R "）" ")"
!insertmacro VIBEX_STR VIBEX_BACK "返回" "Back"
!insertmacro VIBEX_STR VIBEX_INSTALL "安装" "Install"
!insertmacro VIBEX_STR VIBEX_INSTALLED_FMT "已安装版本" "Installed version"
!insertmacro VIBEX_STR VIBEX_REINSTALL "重新安装" "Reinstall"
!insertmacro VIBEX_STR VIBEX_UNINSTALL "卸载" "Uninstall"
!insertmacro VIBEX_STR VIBEX_CANCEL "取消" "Cancel"
!insertmacro VIBEX_STR VIBEX_RETRY "重试" "Retry"
!insertmacro VIBEX_STR VIBEX_VIEW_LOG "查看日志" "View log"
!insertmacro VIBEX_STR VIBEX_LAUNCH_NOW "立即启动 ${PRODUCTNAME}" "Launch ${PRODUCTNAME} now"
!insertmacro VIBEX_STR VIBEX_FINISH "完成" "Finish"
!insertmacro VIBEX_STR VIBEX_INSTALLING "正在安装" "Installing"
!insertmacro VIBEX_STR VIBEX_INSTALL_DONE "安装完成" "Installation complete"
!insertmacro VIBEX_STR VIBEX_INSTALL_FAILED "安装未完成" "Installation incomplete"
!insertmacro VIBEX_STR VIBEX_UNINSTALLING "正在卸载" "Uninstalling"
!insertmacro VIBEX_STR VIBEX_UNINSTALLED_DONE "${PRODUCTNAME} 已从此电脑移除" "${PRODUCTNAME} has been removed"
!insertmacro VIBEX_STR VIBEX_UNINSTALL_SUB "将从此电脑移除 ${PRODUCTNAME} ${VERSION}" "${PRODUCTNAME} ${VERSION} will be removed from this PC"
!insertmacro VIBEX_STR VIBEX_DELETE_DATA "同时删除用户数据（设置、会话和缓存）" "Also delete user data (settings, sessions, cache)"
!insertmacro VIBEX_STR VIBEX_PROGRESS_PREPARE "正在准备安装…" "Preparing installation…"
!insertmacro VIBEX_STR VIBEX_PROGRESS_WEBVIEW2 "正在下载 WebView2 运行时…" "Downloading WebView2 Runtime…"
!insertmacro VIBEX_STR VIBEX_PROGRESS_WEBVIEW2_INSTALL "正在安装 WebView2 运行时…" "Installing WebView2 Runtime…"
!insertmacro VIBEX_STR VIBEX_PROGRESS_EXTRACT "正在复制文件…" "Copying files…"
!insertmacro VIBEX_STR VIBEX_PROGRESS_INSTALL "正在注册组件…" "Registering components…"
!insertmacro VIBEX_STR VIBEX_PROGRESS_FINISH "正在完成安装…" "Finishing installation…"
!insertmacro VIBEX_STR VIBEX_PROGRESS_UNINSTALL "正在移除文件…" "Removing files…"
!insertmacro VIBEX_STR VIBEX_WEBVIEW2_FAILED "WebView2 运行时下载失败" "WebView2 Runtime download failed"
!insertmacro VIBEX_STR VIBEX_WEBVIEW2_INSTALL_FAILED "WebView2 运行时安装失败" "WebView2 Runtime installation failed"
!insertmacro VIBEX_STR VIBEX_ERROR_HINT "请检查网络连接后重试 · 错误代码" "Check your network connection and retry · Error code"
!insertmacro VIBEX_STR VIBEX_PATH_INVALID "请选择有效的本地安装文件夹路径。" "Please choose a valid local installation folder path."

!endif
