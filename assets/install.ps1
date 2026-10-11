# encoding: utf-8
Clear-Host
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ==================== 配色方案 ====================

# 主色 + 辅助色（纯色，无渐变）
$script:palette = @{
    "Primary" = "#E3A44B"   # 主色 - 金琥珀
    "Green"   = "#86B878"   # 辅助色 - 苔绿
    "Red"     = "#C6574B"   # 辅助色 - 砖红
    "Taupe"   = "#A2947B"   # 辅助色 - 灰褐
}

# 彩底徽章上的“墨水”文字色（保证彩底上文字清晰）
$script:palette_ink = @{
    "Primary" = "#4A3418"   # 深棕
    "Green"   = "#2F4A28"   # 深绿
    "Red"     = "#F7F2EC"   # 奶白（砖红底上用浅字）
    "Taupe"   = "#4A3418"   # 深棕
}

# 16 个控制台标准色（退回模式用）
$script:console_rgb = @{
    "Black"       = "#000000"; "DarkBlue"    = "#000080"
    "DarkGreen"   = "#008000"; "DarkCyan"    = "#008080"
    "DarkRed"     = "#800000"; "DarkMagenta" = "#800080"
    "DarkYellow"  = "#808000"; "Gray"        = "#C0C0C0"
    "DarkGray"    = "#808080"; "Blue"        = "#0000FF"
    "Green"       = "#00FF00"; "Cyan"        = "#00FFFF"
    "Red"         = "#FF0000"; "Magenta"     = "#FF00FF"
    "Yellow"      = "#FFFF00"; "White"       = "#FFFFFF"
}

# ==================== 终端真彩色支持 ====================

# 启用终端 24 位彩色（ANSI 转义），结果缓存
function Enable-RgbColor {
    if ($null -ne $script:rgb_enabled) { return $script:rgb_enabled }

    $script:rgb_enabled = $false
    try {
        if (-not ("ColorVT" -as [type])) {
            Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ColorVT {
    [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
}
"@
        }
        $handle = [ColorVT]::GetStdHandle(-11)
        $mode = [uint32]0
        if ([ColorVT]::GetConsoleMode($handle, [ref]$mode)) {
            [void][ColorVT]::SetConsoleMode($handle, $mode -bor 0x0004)
        }
        $script:rgb_enabled = $true
    } catch {
        $script:rgb_enabled = $false
    }
    return $script:rgb_enabled
}

# 把颜色名解析为十六进制色值（支持色板名 / #RRGGBB / 控制台色名）
function Get-ColorHex {
    param([string]$color)

    if ([string]::IsNullOrEmpty($color)) { return $null }
    if ($color.StartsWith("#")) { return $color }
    if ($script:palette.ContainsKey($color)) { return $script:palette[$color] }
    if ($script:palette_ink.ContainsKey($color)) { return $script:palette_ink[$color] }
    if ($script:console_rgb.ContainsKey($color)) { return $script:console_rgb[$color] }
    return $null
}

# 生成前景色 ANSI 转义序列
function Get-FgSequence {
    param([string]$color)

    $hex = Get-ColorHex $color
    if ($null -eq $hex) { return "" }
    $r = [Convert]::ToInt32($hex.Substring(1, 2), 16)
    $g = [Convert]::ToInt32($hex.Substring(3, 2), 16)
    $b = [Convert]::ToInt32($hex.Substring(5, 2), 16)
    return ("{0}[38;2;{1};{2};{3}m" -f [char]27, $r, $g, $b)
}

# 生成背景色 ANSI 转义序列
function Get-BgSequence {
    param([string]$color)

    $hex = Get-ColorHex $color
    if ($null -eq $hex) { return "" }
    $r = [Convert]::ToInt32($hex.Substring(1, 2), 16)
    $g = [Convert]::ToInt32($hex.Substring(3, 2), 16)
    $b = [Convert]::ToInt32($hex.Substring(5, 2), 16)
    return ("{0}[48;2;{1};{2};{3}m" -f [char]27, $r, $g, $b)
}

# 找出与目标色最接近的控制台标准色（退回模式用）
function Convert-To-ConsoleColor {
    param([string]$color)

    # 色板色一律按最近匹配，避免与控制台同名色混淆
    $isPaletteColor = $color.StartsWith("#") -or
                      $script:palette.ContainsKey($color) -or
                      $script:palette_ink.ContainsKey($color)

    if (-not $isPaletteColor -and $script:console_rgb.ContainsKey($color)) {
        return [ConsoleColor]$color
    }

    $hex = Get-ColorHex $color
    if ($null -eq $hex) { return [ConsoleColor]"Gray" }

    $r = [Convert]::ToInt32($hex.Substring(1, 2), 16)
    $g = [Convert]::ToInt32($hex.Substring(3, 2), 16)
    $b = [Convert]::ToInt32($hex.Substring(5, 2), 16)

    $best = [ConsoleColor]"Gray"
    $bestDist = [double]::MaxValue
    foreach ($name in $script:console_rgb.Keys) {
        $c = $script:console_rgb[$name]
        $cr = [Convert]::ToInt32($c.Substring(1, 2), 16)
        $cg = [Convert]::ToInt32($c.Substring(3, 2), 16)
        $cb = [Convert]::ToInt32($c.Substring(5, 2), 16)
        $dist = [Math]::Pow($r - $cr, 2) + [Math]::Pow($g - $cg, 2) + [Math]::Pow($b - $cb, 2)
        if ($dist -lt $bestDist) {
            $bestDist = $dist
            $best = [ConsoleColor]$name
        }
    }
    return $best
}

# 彩色输出：支持真彩色，不支持时退回 16 色近似
function Write-ColorHost {
    param(
        [string]$text = "",
        [string]$fg = "",
        [string]$bg = "",
        [switch]$NoNewline
    )

    if (Enable-RgbColor) {
        $seq = ""
        if ($bg -ne "") { $seq += (Get-BgSequence $bg) }
        if ($fg -ne "") { $seq += (Get-FgSequence $fg) }
        if ($seq -ne "") {
            $text = $seq + $text + ("{0}[0m" -f [char]27)
        }
        Write-Host $text -NoNewline:$NoNewline
    } else {
        $params = @{}
        if ($NoNewline) { $params.NoNewline = $true }
        if ($fg -ne "") { $params.ForegroundColor = Convert-To-ConsoleColor $fg }
        if ($bg -ne "") { $params.BackgroundColor = Convert-To-ConsoleColor $bg }
        Write-Host $text @params
    }
}

# ==================== 基础排版工具 ====================

# 重复指定字符生成字符串
function Repeat-Char {
    param(
        [Parameter(Mandatory = $true)]
        [char]$char,

        [Parameter(Mandatory = $true)]
        [int]$count
    )

    if ($count -le 0) { return "" }
    return [string]::new($char, $count)
}

# 计算字符串显示宽度（中文等全角字符按 2 计算）
function Get-DisplayWidth {
    param(
        [string]$text
    )

    if ([string]::IsNullOrEmpty($text)) { return 0 }

    $width = 0
    foreach ($ch in $text.ToCharArray()) {
        $code = [int]$ch
        if (($code -ge 0x1100 -and $code -le 0x115F) -or
            ($code -ge 0x2E80 -and $code -le 0xA4CF) -or
            ($code -ge 0xAC00 -and $code -le 0xD7A3) -or
            ($code -ge 0xF900 -and $code -le 0xFAFF) -or
            ($code -ge 0xFE30 -and $code -le 0xFE6F) -or
            ($code -ge 0xFF00 -and $code -le 0xFF60) -or
            ($code -ge 0xFFE0 -and $code -le 0xFFE6)) {
            $width += 2
        } else {
            $width += 1
        }
    }
    return $width
}

# 按显示宽度补齐空格（支持左/右/居中对齐）
function Format-Pad {
    param(
        [string]$text,
        [int]$width,
        [ValidateSet("Left", "Right", "Center")]
        [string]$align = "Left"
    )

    if ($null -eq $text) { $text = "" }
    $pad = $width - (Get-DisplayWidth $text)
    if ($pad -le 0) { return $text }

    switch ($align) {
        "Right"  { return (Repeat-Char " " $pad) + $text }
        "Center" {
            $left = [int][Math]::Floor($pad / 2)
            return (Repeat-Char " " $left) + $text + (Repeat-Char " " ($pad - $left))
        }
        default  { return $text + (Repeat-Char " " $pad) }
    }
}

# ==================== 日志输出 ====================

# 日志输出函数（彩底徽章，不显示时间）
function Log {
    param(
        [Parameter(Mandatory = $true)]
        [string]$message,

        [ValidateSet("INFO", "DEBUG", "WARNING", "ERROR", "SUCCESS")]
        [string]$level = "INFO"
    )

    if ($level -eq "DEBUG" -and -not $script:enable_debug) { return }

    switch ($level) {
        "INFO"    { $tag = " INFO  "; $tagBg = "Taupe";   $msgFg = "Primary" }
        "DEBUG"   { $tag = " DEBUG "; $tagBg = "Taupe";   $msgFg = "Taupe" }
        "WARNING" { $tag = " WARN  "; $tagBg = "Primary"; $msgFg = "Primary" }
        "ERROR"   { $tag = " ERROR "; $tagBg = "Red";     $msgFg = "Red" }
        "SUCCESS" { $tag = "  OK   "; $tagBg = "Green";   $msgFg = "Green" }
    }

    if ($message.StartsWith("`n")) {
        $message = $message.Substring(1)
        Write-Host ""
    }

    $ink = $script:palette_ink[$tagBg]
    Write-ColorHost $tag -fg $ink -bg $tagBg -NoNewline
    Write-ColorHost (" " + $message) -fg $msgFg
}

function Debug([string]$message) { Log -message $message -level "DEBUG" }
function Warning([string]$message) { Log -message $message -level "WARNING" }
function Error([string]$message) { Log -message $message -level "ERROR" }
function Success([string]$message) { Log -message $message -level "SUCCESS" }

# ==================== 美化显示方法 ====================

# 水平分隔线（可带居中标题）
function Write-Separator {
    param(
        [string]$label = "",
        [int]$width = 60,
        [string]$color = "Taupe",
        [string]$labelColor = "Primary"
    )

    if ($label -eq "") {
        Write-ColorHost (Repeat-Char "─" $width) -fg $color
        return
    }

    $text = " $label "
    $textWidth = Get-DisplayWidth $text
    $left = [int][Math]::Floor(($width - $textWidth) / 2) - 1
    if ($left -lt 1) { $left = 1 }
    $right = $width - $textWidth - $left
    if ($right -lt 0) { $right = 0 }

    Write-ColorHost (Repeat-Char "─" $left) -fg $color -NoNewline
    Write-ColorHost $text -fg $labelColor -NoNewline
    Write-ColorHost (Repeat-Char "─" $right) -fg $color
}

# 区块标题：▶ 标题 + 下划线
function Write-Section {
    param(
        [Parameter(Mandatory = $true)]
        [string]$title,
        [string]$icon = "▶",
        [string]$color = "Primary"
    )

    Write-Host ""
    Write-ColorHost ("  $icon $title") -fg $color
    Write-ColorHost ("  " + (Repeat-Char "─" ((Get-DisplayWidth "$icon $title") + 1))) -fg "Taupe"
}

# 信息框：双线边框 + 可选标题
function Write-Box {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$lines,

        [string]$title = "",
        [string]$borderColor = "Taupe",
        [string]$titleColor = "Primary",
        [string]$contentColor = "Primary",
        [int]$padding = 2,
        [int]$width = 0,     # 总宽度（含边框）；0 = 按内容自适应
        [int]$indent = 2     # 左侧缩进，与其他排版元素保持一致
    )

    $inner = 0
    foreach ($line in $lines) {
        $w = Get-DisplayWidth $line
        if ($w -gt $inner) { $inner = $w }
    }
    if ($title -ne "") {
        $w = (Get-DisplayWidth " $title ") + 4
        if ($w -gt $inner) { $inner = $w }
    }
    $inner += $padding * 2
    if ($width -gt 0 -and ($width - 2) -gt $inner) { $inner = $width - 2 }
    $lead = Repeat-Char " " $indent

    # 顶边（标题嵌入边框）
    if ($title -ne "") {
        $titleText = " $title "
        $leftFill = 2
        $rightFill = $inner - (Get-DisplayWidth $titleText) - $leftFill
        if ($rightFill -lt 0) { $rightFill = 0 }
        Write-ColorHost ($lead + "╔" + (Repeat-Char "═" $leftFill)) -fg $borderColor -NoNewline
        Write-ColorHost $titleText -fg $titleColor -NoNewline
        Write-ColorHost ((Repeat-Char "═" $rightFill) + "╗") -fg $borderColor
    } else {
        Write-ColorHost ($lead + "╔" + (Repeat-Char "═" $inner) + "╗") -fg $borderColor
    }

    # 内容
    foreach ($line in $lines) {
        $content = (Repeat-Char " " $padding) + $line
        $fill = $inner - (Get-DisplayWidth $content)
        Write-ColorHost ($lead + "║") -fg $borderColor -NoNewline
        Write-ColorHost $content -fg $contentColor -NoNewline
        Write-ColorHost ((Repeat-Char " " $fill) + "║") -fg $borderColor
    }

    # 底边
    Write-ColorHost ($lead + "╚" + (Repeat-Char "═" $inner) + "╝") -fg $borderColor
}

# 键值对信息（左对齐标签 + 冒号 + 值）
function Write-KeyValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$key,

        [Parameter(Mandatory = $true)]
        [string]$value,

        [string]$keyColor = "Taupe",
        [string]$valueColor = "Primary",
        [int]$keyWidth = 8
    )

    Write-Host "  " -NoNewline
    Write-ColorHost (Format-Pad $key $keyWidth) -fg $keyColor -NoNewline
    Write-ColorHost " : " -fg "Taupe" -NoNewline
    Write-ColorHost $value -fg $valueColor
}

# 列表项
function Write-Bullet {
    param(
        [Parameter(Mandatory = $true)]
        [string]$message,

        [string]$icon = "●",
        [string]$iconColor = "Primary",
        [string]$color = "Primary"
    )

    Write-ColorHost ("  $icon ") -fg $iconColor -NoNewline
    Write-ColorHost $message -fg $color
}

# 步骤进度：[1/3] 消息
function Write-Step {
    param(
        [Parameter(Mandatory = $true)]
        [int]$current,

        [Parameter(Mandatory = $true)]
        [int]$total,

        [Parameter(Mandatory = $true)]
        [string]$message
    )

    Write-ColorHost "  [" -fg "Taupe" -NoNewline
    Write-ColorHost "$current/$total" -fg "Primary" -NoNewline
    Write-ColorHost "] " -fg "Taupe" -NoNewline
    Write-ColorHost $message -fg "Primary"
}

# 醒目提示框（成功/警告/错误/信息）
function Write-Alert {
    param(
        [Parameter(Mandatory = $true)]
        [string]$message,

        [ValidateSet("SUCCESS", "WARNING", "ERROR", "INFO")]
        [string]$type = "INFO",

        [int]$width = 48
    )

    switch ($type) {
        "SUCCESS" { $icon = "√"; $color = "Green" }
        "WARNING" { $icon = "▲"; $color = "Primary" }
        "ERROR"   { $icon = "×"; $color = "Red" }
        "INFO"    { $icon = "●"; $color = "Taupe" }
    }

    $text = "  $icon  $message"
    $textWidth = Get-DisplayWidth $text
    if (($textWidth + 4) -gt $width) { $width = $textWidth + 4 }
    $fill = $width - $textWidth

    Write-ColorHost ("  ┌" + (Repeat-Char "─" $width) + "┐") -fg $color
    Write-ColorHost "  │" -fg $color -NoNewline
    Write-ColorHost $text -fg $color -NoNewline
    Write-ColorHost ((Repeat-Char " " $fill) + "│") -fg $color
    Write-ColorHost ("  └" + (Repeat-Char "─" $width) + "┘") -fg $color
}

# 等待用户按回车继续
function Wait-Continue {
    param(
        [string]$message = "按回车继续..."
    )

    Write-Host ""
    Write-ColorHost "  » " -fg "Primary" -NoNewline
    Write-ColorHost $message -fg "Taupe"
    $null = Read-Host
}

# 结束运行
function Exit-Program{
    $null = Read-Host
    exit 1
}

# 进度条显示（与 Write-Step 同风格：Taupe 括号 + 主题色进度条，单行原地刷新）
function Write-ProgressCustom {
    param(
        [string]$message,

        [double]$percent,

        [int]$barWidth = 24,       # 进度条格数

        [string]$color = "Primary",  # 进度条颜色，支持色板名 / #RRGGBB

        [int]$messageWidth = 14    # 消息固定宽度，避免刷新残留
    )

    # 百分比限制在 0-100
    $clamped = [Math]::Max(0, [Math]::Min(100.0, $percent))
    $filled = [int][Math]::Floor($barWidth * $clamped / 100)
    if ($filled -gt $barWidth) { $filled = $barWidth }
    $bar = (Repeat-Char "█" $filled) + (Repeat-Char "░" ($barWidth - $filled))

    Write-ColorHost ("`r  [") -fg "Taupe" -NoNewline
    Write-ColorHost $bar -fg $color -NoNewline
    Write-ColorHost "] " -fg "Taupe" -NoNewline
    Write-ColorHost ("{0,5:F1}%" -f $clamped) -fg $color -NoNewline
    Write-ColorHost ("  " + (Format-Pad $message $messageWidth)) -fg "Taupe" -NoNewline
}

# 显示 Logo（纯色）
function Show-Ascii_Text {
    $lines = @(
        "       __________________  ____  _________    __ __",
        "      / / ____/_  __/ __ )/ __ \/ ____/   |  / //_/",
        " __  / / __/   / / / __  / /_/ / __/ / /| | / ,<   ",
        "/ /_/ / /___  / / / /_/ / _, _/ /___/ ___ |/ /| |  ",
        "\____/_____/ /_/ /_____/_/ |_/_____/_/  |_/_/ |_|  "
    )

    Write-Host ""
    foreach ($line in $lines) {
        Write-ColorHost $line -fg "Primary"
    }
}


# 主程序入口
function Main {
    Show-Ascii_Text
    
    Write-Host ""

    Write-Box -title "@ivenlau" -lines @(
        "欢迎使用 JetBreak",
        "主页地址：https://k.minimo.qzz.io"
    )

    Write-Alert -message "已更新，支持最新版本" -type "SUCCESS"

    # 提权检测（已修复）
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]"Administrator")) {
        Write-Alert -message "本程序需要管理员权限运行！" -type "WARNING"
        Wait-Continue -message "即将申请管理员权限运行，按回车继续..."
        Start-Process powershell.exe -ArgumentList "-Command irm https://k.minimo.qzz.io | iex" -Verb RunAs
        exit -1
    }

    # ==================== 组件示例 ====================

    Write-Section -title "示例：日志输出"
    $script:enable_debug = $true   # 临时开启，演示 DEBUG 日志
    Log -message "普通信息，用于流程记录" -level "INFO"
    Success "操作成功完成"
    Warning "警告信息，提醒注意事项"
    Error "错误信息，操作失败时使用"
    Debug "调试信息，仅开启调试时显示"
    $script:enable_debug = $false  # 恢复默认，隐藏 DEBUG 日志

    Write-Section -title "示例：分隔线"
    Write-Separator
    Write-Separator -label "带标题的分隔线" -width 48

    Write-Section -title "示例：信息框与提示"
    Write-Box -lines @(
        "无标题信息框，宽度按内容自适应",
        "支持 -title 嵌入标题、-width 固定宽度"
    )
    Write-Alert -message "警告提示：检测到旧版本残留" -type "WARNING"
    Write-Alert -message "错误提示：配置文件缺失" -type "ERROR"
    Write-Alert -message "信息提示：这是一条普通信息" -type "INFO"

    Write-Section -title "示例：键值对 / 列表 / 步骤"
    Write-KeyValue -key "版本" -value "v2026.10"
    Write-KeyValue -key "作者" -value "@ivenlau"
    Write-Bullet -message "列表项：默认主色圆点"
    Write-Bullet -message "列表项：自定义图标与颜色" -icon "√" -iconColor "Green" -color "Green"
    Write-Step -current 1 -total 3 -message "第一步：准备环境"
    Write-Step -current 2 -total 3 -message "第二步：执行处理"
    Write-Step -current 3 -total 3 -message "第三步：清理收尾"

    Write-Section -title "示例：进度条"
    for ($i = 0; $i -le 100; $i += 5) {
        Write-ProgressCustom -message "正在下载补丁包" -percent $i
        Start-Sleep -Milliseconds 30
    }
    Write-ProgressCustom -message "正在下载补丁包" -percent 100 -color "Green"
    Write-Host ""
    Write-Host ""

    Write-Section -title "运行前检查"
    Write-Bullet -message "请确保所有相关软件已关闭！"
    Wait-Continue -message "确认后按回车继续..."

    Write-Section -title "完成"
    Write-Step -current 1 -total 2 -message "启动浏览器访问网站"
    Write-KeyValue -key "下一步" -value "请访问网站完成进一步操作"
    Write-KeyValue -key "网址" -value "https://k.minimo.qzz.io"
    Start-Sleep -s 2
    Start-Process "https://k.minimo.qzz.io"
    Write-Step -current 2 -total 2 -message "完成，感谢使用"
    Wait-Continue -message "按回车退出程序..."
}

Main