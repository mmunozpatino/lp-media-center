# Actualiza LP Media Center en esta PC: cierra la app y su backend, instala la versión de dist y la abre.
# Correr desde el panel Terminal, no desde las herramientas de Claude (ver "AppData virtualizado" en CLAUDE.md).
$exe = Join-Path $env:LOCALAPPDATA 'Programs\LP Media Center\LP Media Center.exe'
$setup = Join-Path $PSScriptRoot '..\dist\LP-Cine-Vault-Setup.exe'
Get-Process 'LP Media Center' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process -FilePath $setup -ArgumentList '/S' -Wait
Start-Sleep -Seconds 1
Start-Process -FilePath $exe
Start-Sleep -Seconds 8
try {
  $s = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/status' -TimeoutSec 25
  "Backend responde: $(@($s.parts | Where-Object { $_.state -eq 'ok' }).Count) de $(@($s.parts).Count) bien, descargas $(@($s.downloads.items).Count), pedidos $($s.requests.total)"
} catch { "Backend NO responde: $($_.Exception.Message)" }
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { "Escucha en $($_.LocalAddress)" }
"FIN"
