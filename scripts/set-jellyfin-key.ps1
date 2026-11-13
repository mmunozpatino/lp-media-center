# Guarda la clave de API de Jellyfin para LP Cine Vault, sin mostrarla en pantalla ni en registros.
# Correr desde una pestaña del panel Terminal: la clave se pega acá, nunca en el chat.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.lp-media-center'
$file = Join-Path $dir 'jellyfin.key'
$jellyfin = 'http://127.0.0.1:8096'

$secure = Read-Host -AsSecureString 'Pegá la clave de API de Jellyfin y apretá Enter (no se va a ver)'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ($key -notmatch '^[0-9a-fA-F]{32}$') { 'No parece una clave de Jellyfin (32 letras y números). No guardé nada.'; exit 1 }

# Comprobar antes de guardar: que Jellyfin la acepte y que sea de administrador.
# Este Jellyfin tiene EnableLegacyAuthorization=false: no acepta X-Emby-Token ni api_key, solo esta cabecera.
$auth = @{ Authorization = "MediaBrowser Token=`"$key`"" }
try {
  $info = Invoke-RestMethod "$jellyfin/System/Info" -Headers $auth -TimeoutSec 15
  $null = Invoke-RestMethod "$jellyfin/Devices" -Headers $auth -TimeoutSec 15
} catch {
  "Jellyfin rechazó la clave o no respondió ($($_.Exception.Message)). No guardé nada."
  exit 1
}

if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
[IO.File]::WriteAllText($file, $key, (New-Object Text.UTF8Encoding $false))
# Solo esta cuenta puede leer el archivo.
icacls $file /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:(R,W)" | Out-Null
"Clave guardada en $file. Jellyfin $($info.Version) la aceptó como administrador."
