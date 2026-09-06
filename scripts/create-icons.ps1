Add-Type -AssemblyName System.Drawing

function Create-PurplePNG {
    param([int]$sz, [string]$path)
    
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    
    $rect = New-Object System.Drawing.Rectangle(0, 0, $sz, $sz)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(108, 92, 231),
        [System.Drawing.Color]::FromArgb(168, 85, 247),
        45
    )
    $g.FillRectangle($brush, $rect)
    
    $pw = [math]::Max(1, [int]($sz / 16))
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $pw)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    
    $margin = [int]($sz * 0.2)
    
    $y3 = [int]($sz * 0.72)
    $g.DrawLine($pen, $margin, $y3, ($sz - $margin), $y3)
    
    $y2 = [int]($sz * 0.50)
    $g.DrawLine($pen, $margin, $y2, [int]($sz * 0.65), $y2)
    
    $y1 = [int]($sz * 0.28)
    $g.DrawLine($pen, [int]($margin * 1.2), $y1, ($sz - [int]($margin * 1.2)), $y1)
    
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    $brush.Dispose()
    $pen.Dispose()
    Write-Host "Created $path"
}

Create-PurplePNG -sz 16 -path "d:\ChromeExtension\assets\icons\icon-16.png"
Create-PurplePNG -sz 48 -path "d:\ChromeExtension\assets\icons\icon-48.png"
Create-PurplePNG -sz 128 -path "d:\ChromeExtension\assets\icons\icon-128.png"
Write-Host "All icons created"
