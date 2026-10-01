# Crea accesos directos "Estudio" en el Escritorio y en el menu Inicio (Windows).
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $PSScriptRoot
$target = Join-Path $dir 'Estudio por internet (Windows).bat'
$icon = Join-Path $dir 'public\img\estudio.ico'
$places = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('Programs')
)
$shell = New-Object -ComObject WScript.Shell
foreach ($p in $places) {
  $lnk = $shell.CreateShortcut((Join-Path $p 'Estudio.lnk'))
  $lnk.TargetPath = $target
  $lnk.WorkingDirectory = $dir
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'Grabar una llamada con Estudio'
  $lnk.Save()
  Write-Output "  OK: $p\Estudio.lnk"
}
