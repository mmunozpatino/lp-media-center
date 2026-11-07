# Reglas de firewall de LP Media Center. Requiere administrador. Solo red de casa y Tailscale, en perfil
# Privado; nunca internet. Es seguro volver a correrlo: reemplaza las reglas con estos mismos nombres.
#
# Si el cartel de Windows se cancela la primera vez que la app abre el puerto, Windows crea reglas de
# bloqueo para el .exe, y un bloqueo gana sobre cualquier permiso. Por eso se borran, y la regla del
# backend va atada al programa: así Windows no vuelve a preguntar.
$program = Join-Path $env:LOCALAPPDATA 'Programs\LP Media Center\LP Media Center.exe'

Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $program } | Get-NetFirewallRule |
  Where-Object { $_.Action -eq 'Block' -or $_.DisplayName -eq 'lp media center.exe' } | ForEach-Object {
    "Borrada: $($_.DisplayName), accion $($_.Action)"
    $_ | Remove-NetFirewallRule
  }

$remote = @('192.168.1.0/24', '100.64.0.0/10', 'fd7a:115c:a1e0::/48')
$name = 'LP Media Center (LAN y Tailscale)'
Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -RemoteAddress $remote -Program $program -Profile Private | Out-Null

$seerr = 'Seerr (Tailscale)'
Remove-NetFirewallRule -DisplayName $seerr -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $seerr -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5055 -RemoteAddress @('100.64.0.0/10', 'fd7a:115c:a1e0::/48') -Profile Private | Out-Null

"Reglas creadas"
