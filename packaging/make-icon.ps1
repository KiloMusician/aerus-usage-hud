# Generates assets\aerus-usage-hud.ico (256px PNG inside an ICO container) from the HUD's gradient diamond mark.
param([string]$Out = (Join-Path $PSScriptRoot '..\assets\aerus-usage-hud.ico'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 256
$bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(255, 6, 13, 24))

    $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF $size, $size),
        [System.Drawing.Color]::FromArgb(255, 47, 140, 255), [System.Drawing.Color]::FromArgb(255, 34, 227, 240))
    $diamond = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF 128, 48), (New-Object System.Drawing.PointF 216, 96),
        (New-Object System.Drawing.PointF 128, 144), (New-Object System.Drawing.PointF 40, 96))
    $g.FillPolygon($gradient, $diamond)

    $cyan = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 34, 227, 240)), 14
    $blue = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(180, 47, 140, 255)), 14
    $cyan.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $blue.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawLines($cyan, [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 40, 150), (New-Object System.Drawing.PointF 128, 198), (New-Object System.Drawing.PointF 216, 150)))
    $g.DrawLines($blue, [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF 40, 196), (New-Object System.Drawing.PointF 128, 244), (New-Object System.Drawing.PointF 216, 196)))
} finally {
    $g.Dispose()
}

$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $stream.ToArray()
$bitmap.Dispose()

# ICO container: header, one directory entry (0 means 256px), then the PNG payload.
$out = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Path (Split-Path $out) -Force | Out-Null
$file = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $file
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32)
$writer.Write([uint32]$png.Length); $writer.Write([uint32]22)
$writer.Write($png)
$writer.Flush()
[System.IO.File]::WriteAllBytes($out, $file.ToArray())
$writer.Dispose()
Write-Output "Wrote $out ($($png.Length) byte PNG)"
