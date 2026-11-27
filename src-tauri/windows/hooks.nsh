!macro NSIS_HOOK_PREINSTALL
  ; 结束正在运行的旧版与 sidecar，避免文件占用导致"装完还是旧版"
  nsExec::Exec 'taskkill /F /IM "Studiolo.exe"'
  nsExec::Exec 'taskkill /F /IM "studiolo-backend.exe"'
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 安装完成不自动拉起，交给用户/更新器
!macroend
