; Antes de instalar o desinstalar, cierra la app y su backend, que corre con el mismo .exe: si no, el
; backend viejo sigue ocupando el puerto con la versión anterior.
!macro customInit
  nsExec::Exec 'taskkill /F /IM "LP Media Center.exe"'
  Sleep 1000
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "LP Media Center.exe"'
  Sleep 1000
!macroend
