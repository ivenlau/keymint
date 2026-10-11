#!/usr/bin/env bash
# encoding: utf-8
#
# sample.sh —— sample.ps1 的 Linux / macOS 版本
#
# 用法:
#   chmod +x sample.sh && ./sample.sh
#   或 bash sample.sh
#
# 依赖: bash 3.2+（macOS 自带版本即可）、awk、sudo（提权时）
# 颜色: 优先 24 位真彩色（依据 COLORTERM/TERM 自动检测），不支持时退回 16 色近似；
#       NO_COLOR=1 强制关闭颜色；FORCE_COLOR=1 在非终端输出时仍启用颜色

# ==================== 配色方案 ====================

ESC=$'\033'

# 主色 + 辅助色（纯色，无渐变）：色板名 → 十六进制
palette_hex() {
    case "$1" in
        Primary) printf '%s' "#E3A44B" ;;   # 主色 - 金琥珀
        Green)   printf '%s' "#86B878" ;;   # 辅助色 - 苔绿
        Red)     printf '%s' "#C6574B" ;;   # 辅助色 - 砖红
        Taupe)   printf '%s' "#A2947B" ;;   # 辅助色 - 灰褐
        *) return 1 ;;
    esac
}

# 彩底徽章上的“墨水”文字色（保证彩底上文字清晰）
ink_hex() {
    case "$1" in
        Primary) printf '%s' "#4A3418" ;;   # 深棕
        Green)   printf '%s' "#2F4A28" ;;   # 深绿
        Red)     printf '%s' "#F7F2EC" ;;   # 奶白（砖红底上用浅字）
        Taupe)   printf '%s' "#4A3418" ;;   # 深棕
        *) return 1 ;;
    esac
}

# 16 个 ANSI 标准色（退回模式用）：名称|十六进制|前景代码
CONSOLE_COLORS=(
    "Black|#000000|30"
    "DarkRed|#800000|31"
    "DarkGreen|#008000|32"
    "DarkYellow|#808000|33"
    "DarkBlue|#000080|34"
    "DarkMagenta|#800080|35"
    "DarkCyan|#008080|36"
    "Gray|#C0C0C0|37"
    "DarkGray|#808080|90"
    "Red|#FF0000|91"
    "Green|#00FF00|92"
    "Yellow|#FFFF00|93"
    "Blue|#0000FF|94"
    "Magenta|#FF00FF|95"
    "Cyan|#00FFFF|96"
    "White|#FFFFFF|97"
)

# ==================== 终端真彩色支持 ====================

# 颜色模式检测（rgb / 16 / none），结果缓存
COLOR_MODE=""
detect_color_mode() {
    [[ -n "$COLOR_MODE" ]] && return 0
    if [[ -n "${NO_COLOR:-}" ]]; then
        COLOR_MODE="none"
    elif [[ ! -t 1 && -z "${FORCE_COLOR:-}" ]]; then
        COLOR_MODE="none"   # 输出被重定向时关闭颜色
    elif [[ "$COLORTERM" == *truecolor* || "$COLORTERM" == *24bit* ]]; then
        COLOR_MODE="rgb"
    elif [[ "$TERM" == *truecolor* || "$TERM" == *direct* || "$TERM" == *24bit* ]]; then
        COLOR_MODE="rgb"
    else
        COLOR_MODE="16"
    fi
}

# 控制台色名 → 十六进制
console_hex() {
    local entry rest
    for entry in "${CONSOLE_COLORS[@]}"; do
        if [[ "${entry%%|*}" == "$1" ]]; then
            rest="${entry#*|}"
            printf '%s' "${rest%%|*}"
            return 0
        fi
    done
    return 1
}

# 把颜色名解析为十六进制色值（支持色板名 / #RRGGBB / 控制台色名）
color_hex() {
    local c="$1" h
    [[ -z "$c" ]] && return 1
    [[ "$c" == "#"* ]] && { printf '%s' "$c"; return 0; }
    h=$(palette_hex "$c") && { printf '%s' "$h"; return 0; }
    h=$(ink_hex "$c")     && { printf '%s' "$h"; return 0; }
    h=$(console_hex "$c") && { printf '%s' "$h"; return 0; }
    return 1
}

# 十六进制 → 全局变量 R G B
hex_to_rgb() {
    R=$(( 16#${1:1:2} ))
    G=$(( 16#${1:3:2} ))
    B=$(( 16#${1:5:2} ))
}

# 生成前景色 ANSI 转义序列
fg_seq() {
    local hex
    hex=$(color_hex "$1") || return 0
    hex_to_rgb "$hex"
    printf '%s[38;2;%d;%d;%dm' "$ESC" "$R" "$G" "$B"
}

# 生成背景色 ANSI 转义序列
bg_seq() {
    local hex
    hex=$(color_hex "$1") || return 0
    hex_to_rgb "$hex"
    printf '%s[48;2;%d;%d;%dm' "$ESC" "$R" "$G" "$B"
}

# 找出与目标色最接近的 ANSI 标准色代码（退回模式用）
nearest_console_code() {
    local hex="$1"
    hex_to_rgb "$hex"
    local entry rest name h code rr gg bb d
    local best=37 bestd=999999999
    for entry in "${CONSOLE_COLORS[@]}"; do
        name="${entry%%|*}"
        rest="${entry#*|}"
        h="${rest%%|*}"
        code="${rest##*|}"
        rr=$(( 16#${h:1:2} ))
        gg=$(( 16#${h:3:2} ))
        bb=$(( 16#${h:5:2} ))
        d=$(( (R - rr) * (R - rr) + (G - gg) * (G - gg) + (B - bb) * (B - bb) ))
        if (( d < bestd )); then
            bestd=$d
            best=$code
        fi
    done
    printf '%s' "$best"
}

# 色名 / 十六进制 → ANSI 前景代码（控制台色名直接映射，其余按最近匹配）
console_code() {
    local entry
    for entry in "${CONSOLE_COLORS[@]}"; do
        [[ "${entry%%|*}" == "$1" ]] && { printf '%s' "${entry##*|}"; return 0; }
    done
    local hex
    hex=$(color_hex "$1") || { printf '%s' "37"; return 0; }
    nearest_console_code "$hex"
}

# 彩色输出：真彩色 / 16 色近似 / 无颜色 三种模式
# 用法: write_color "文本" [前景色] [背景色] [1=不换行]
write_color() {
    local text="$1" fg="${2:-}" bg="${3:-}" nl seq=""
    detect_color_mode
    if [[ "${4:-}" == "1" ]]; then nl=""; else nl=$'\n'; fi
    case "$COLOR_MODE" in
        rgb)
            [[ -n "$bg" ]] && seq+="$(bg_seq "$bg")"
            [[ -n "$fg" ]] && seq+="$(fg_seq "$fg")"
            if [[ -n "$seq" ]]; then
                printf '%s' "${seq}${text}${ESC}[0m${nl}"
            else
                printf '%s' "${text}${nl}"
            fi
            ;;
        16)
            if [[ -n "$bg" ]]; then
                seq+="$(printf '%s[%dm' "$ESC" $(( $(console_code "$bg") + 10 )))"
            fi
            if [[ -n "$fg" ]]; then
                seq+="$(printf '%s[%dm' "$ESC" "$(console_code "$fg")")"
            fi
            printf '%s' "${seq}${text}${nl}"
            ;;
        *)
            printf '%s' "${text}${nl}"
            ;;
    esac
}

# ==================== 基础排版工具 ====================

# 重复指定字符生成字符串
repeat_char() {   # $1=字符 $2=次数
    local n="$2" out="" i
    (( n <= 0 )) && return 0
    for (( i = 0; i < n; i++ )); do
        out+="$1"
    done
    printf '%s' "$out"
}

# 计算字符串显示宽度（中文等全角字符按 2 计算）
# 按 UTF-8 字节手动解码，不依赖终端区域设置
display_width() {   # $1=文本
    local s="${1:-}"
    local LC_ALL=C   # 确保按字节切分
    local len=${#s} i=0 j w=0 v cp n b ok
    while (( i < len )); do
        b="${s:i:1}"
        # 这两个字符无法用 printf 探测字节值，直接按 ASCII 处理
        if [[ "$b" == "'" || "$b" == "\\" ]]; then
            (( w += 1 )); (( i += 1 ))
            continue
        fi
        printf -v v '%d' "'$b" 2>/dev/null || v=63
        (( v < 0 )) && (( v += 256 ))
        if (( v < 0x80 )); then
            (( w += 1 )); (( i += 1 ))
            continue
        elif (( (v & 0xE0) == 0xC0 )); then n=2; cp=$(( v & 0x1F ))
        elif (( (v & 0xF0) == 0xE0 )); then n=3; cp=$(( v & 0x0F ))
        elif (( (v & 0xF8) == 0xF0 )); then n=4; cp=$(( v & 0x07 ))
        else
            (( w += 1 )); (( i += 1 ))   # 无效字节按 1 处理
            continue
        fi
        # 解码后续字节
        ok=1
        for (( j = 1; j < n; j++ )); do
            if (( i + j >= len )); then ok=0; break; fi
            b="${s:i+j:1}"
            [[ "$b" == "'" || "$b" == "\\" ]] && { ok=0; break; }
            printf -v v '%d' "'$b" 2>/dev/null || { ok=0; break; }
            (( v < 0 )) && (( v += 256 ))
            if (( (v & 0xC0) != 0x80 )); then ok=0; break; fi
            cp=$(( (cp << 6) | (v & 0x3F) ))
        done
        if (( ok )); then
            if (( (cp >= 0x1100 && cp <= 0x115F) ||
                  (cp >= 0x2E80 && cp <= 0xA4CF) ||
                  (cp >= 0xAC00 && cp <= 0xD7A3) ||
                  (cp >= 0xF900 && cp <= 0xFAFF) ||
                  (cp >= 0xFE30 && cp <= 0xFE6F) ||
                  (cp >= 0xFF00 && cp <= 0xFF60) ||
                  (cp >= 0xFFE0 && cp <= 0xFFE6) )); then
                (( w += 2 ))
            else
                (( w += 1 ))
            fi
        else
            (( w += 1 ))
        fi
        (( i += n ))
    done
    printf '%d' "$w"
}

# 按显示宽度补齐空格（支持左/右/居中对齐）
format_pad() {   # $1=文本 $2=宽度 $3=对齐 Left/Right/Center
    local text="${1:-}" width="$2" align="${3:-Left}" pad left
    pad=$(( width - $(display_width "$text") ))
    if (( pad <= 0 )); then
        printf '%s' "$text"
        return 0
    fi
    case "$align" in
        Right)
            printf '%s%s' "$(repeat_char " " "$pad")" "$text"
            ;;
        Center)
            left=$(( pad / 2 ))
            printf '%s%s%s' "$(repeat_char " " "$left")" "$text" "$(repeat_char " " $(( pad - left )))"
            ;;
        *)
            printf '%s%s' "$text" "$(repeat_char " " "$pad")"
            ;;
    esac
}

# ==================== 日志输出 ====================

ENABLE_DEBUG="${ENABLE_DEBUG:-0}"

# 日志输出函数（彩底徽章，不显示时间）
log() {   # $1=消息 $2=级别 INFO/DEBUG/WARNING/ERROR/SUCCESS
    local message="$1" level="${2:-INFO}"
    local tag tagbg msgfg ink
    if [[ "$level" == "DEBUG" && "$ENABLE_DEBUG" != "1" ]]; then
        return 0
    fi
    case "$level" in
        INFO)    tag=" INFO  "; tagbg="Taupe";   msgfg="Primary" ;;
        DEBUG)   tag=" DEBUG "; tagbg="Taupe";   msgfg="Taupe" ;;
        WARNING) tag=" WARN  "; tagbg="Primary"; msgfg="Primary" ;;
        ERROR)   tag=" ERROR "; tagbg="Red";     msgfg="Red" ;;
        SUCCESS) tag="  OK   "; tagbg="Green";   msgfg="Green" ;;
        *) return 0 ;;
    esac
    if [[ "$message" == $'\n'* ]]; then
        message="${message#$'\n'}"
        printf '\n'
    fi
    ink=$(ink_hex "$tagbg")
    write_color "$tag" "$ink" "$tagbg" 1
    write_color " $message" "$msgfg"
}

debug()   { log "$1" "DEBUG"; }
warning() { log "$1" "WARNING"; }
error()   { log "$1" "ERROR"; }
success() { log "$1" "SUCCESS"; }

# ==================== 美化显示方法 ====================

# 水平分隔线（可带居中标题）
write_separator() {   # $1=标题 $2=宽度 $3=线色 $4=标题色
    local label="${1:-}" width="${2:-60}" color="${3:-Taupe}" label_color="${4:-Primary}"
    local text textw left right
    if [[ -z "$label" ]]; then
        write_color "$(repeat_char "─" "$width")" "$color"
        return 0
    fi
    text=" $label "
    textw=$(display_width "$text")
    left=$(( (width - textw) / 2 - 1 ))
    (( left < 1 )) && left=1
    right=$(( width - textw - left ))
    (( right < 0 )) && right=0
    write_color "$(repeat_char "─" "$left")" "$color" "" 1
    write_color "$text" "$label_color" "" 1
    write_color "$(repeat_char "─" "$right")" "$color"
}

# 区块标题：▶ 标题 + 下划线
write_section() {   # $1=标题 $2=图标 $3=颜色
    local title="$1" icon="${2:-▶}" color="${3:-Primary}"
    printf '\n'
    write_color "  $icon $title" "$color"
    write_color "  $(repeat_char "─" $(( $(display_width "$icon $title") + 1 )))" "Taupe"
}

# 信息框：双线边框 + 可选标题
# 用法: write_box [-t 标题] [-w 总宽度] [-i 缩进] [-bc 线色] [-tc 标题色] [-cc 内容色] 行1 行2 ...
write_box() {
    local title="" width=0 indent=2 padding=2
    local border_color="Taupe" title_color="Primary" content_color="Primary"
    while [[ "${1:-}" == -* && "${1:-}" != "--" ]]; do
        case "$1" in
            -t)  title="$2"; shift 2 ;;
            -w)  width="$2"; shift 2 ;;
            -i)  indent="$2"; shift 2 ;;
            -bc) border_color="$2"; shift 2 ;;
            -tc) title_color="$2"; shift 2 ;;
            -cc) content_color="$2"; shift 2 ;;
            *)   break ;;
        esac
    done
    [[ "${1:-}" == "--" ]] && shift
    local -a lines
    lines=("$@")

    local inner=0 line w lead fill content title_text left_fill right_fill
    for line in "${lines[@]}"; do
        w=$(display_width "$line")
        (( w > inner )) && inner=$w
    done
    if [[ -n "$title" ]]; then
        w=$(( $(display_width " $title ") + 4 ))
        (( w > inner )) && inner=$w
    fi
    inner=$(( inner + padding * 2 ))
    if (( width > 0 && width - 2 > inner )); then inner=$(( width - 2 )); fi
    lead=$(repeat_char " " "$indent")

    # 顶边（标题嵌入边框）
    if [[ -n "$title" ]]; then
        title_text=" $title "
        left_fill=2
        right_fill=$(( inner - $(display_width "$title_text") - left_fill ))
        (( right_fill < 0 )) && right_fill=0
        write_color "${lead}╔$(repeat_char "═" "$left_fill")" "$border_color" "" 1
        write_color "$title_text" "$title_color" "" 1
        write_color "$(repeat_char "═" "$right_fill")╗" "$border_color"
    else
        write_color "$lead╔$(repeat_char "═" "$inner")╗" "$border_color"
    fi

    # 内容
    for line in "${lines[@]}"; do
        content="$(repeat_char " " "$padding")$line"
        fill=$(( inner - $(display_width "$content") ))
        write_color "$lead║" "$border_color" "" 1
        write_color "$content" "$content_color" "" 1
        write_color "$(repeat_char " " "$fill")║" "$border_color"
    done

    # 底边
    write_color "$lead╚$(repeat_char "═" "$inner")╝" "$border_color"
}

# 键值对信息（左对齐标签 + 冒号 + 值）
write_key_value() {   # $1=键 $2=值 $3=键宽
    local key="$1" value="$2" keyw="${3:-8}"
    printf '  '
    write_color "$(format_pad "$key" "$keyw")" "Taupe" "" 1
    write_color " : " "Taupe" "" 1
    write_color "$value" "Primary"
}

# 列表项
write_bullet() {   # $1=消息 $2=图标 $3=图标色 $4=文字色
    local message="$1" icon="${2:-●}" icon_color="${3:-Primary}" color="${4:-Primary}"
    write_color "  $icon " "$icon_color" "" 1
    write_color "$message" "$color"
}

# 步骤进度：[1/3] 消息
write_step() {   # $1=当前步 $2=总步数 $3=消息
    local current="$1" total="$2" message="$3"
    write_color "  [" "Taupe" "" 1
    write_color "$current/$total" "Primary" "" 1
    write_color "] " "Taupe" "" 1
    write_color "$message" "Primary"
}

# 醒目提示框（成功/警告/错误/信息）
write_alert() {   # $1=消息 $2=类型 $3=宽度
    local message="$1" type="${2:-INFO}" width="${3:-48}"
    local icon color text textw fill
    case "$type" in
        SUCCESS) icon="√"; color="Green" ;;
        WARNING) icon="▲"; color="Primary" ;;
        ERROR)   icon="×"; color="Red" ;;
        INFO)    icon="●"; color="Taupe" ;;
        *)       icon="●"; color="Taupe" ;;
    esac
    text="  $icon  $message"
    textw=$(display_width "$text")
    if (( textw + 4 > width )); then width=$(( textw + 4 )); fi
    fill=$(( width - textw ))
    write_color "  ┌$(repeat_char "─" "$width")┐" "$color"
    write_color "  │" "$color" "" 1
    write_color "$text" "$color" "" 1
    write_color "$(repeat_char " " "$fill")│" "$color"
    write_color "  └$(repeat_char "─" "$width")┘" "$color"
}

# 等待用户按回车继续
wait_continue() {
    local message="${1:-按回车继续...}"
    printf '\n'
    write_color "  » " "Primary" "" 1
    write_color "$message" "Taupe"
    read -r
}

# 结束运行
exit_program() {
    read -r
    exit 1
}

# 进度条显示（与 write_step 同风格：Taupe 括号 + 主题色进度条，单行原地刷新）
write_progress_custom() {   # $1=消息 $2=百分比 $3=条宽 $4=颜色 $5=消息宽
    local message="${1:-}" pct="${2:-0}" barw="${3:-24}" color="${4:-Primary}" msgw="${5:-14}"
    local filled shown i bar=""
    # 百分比限制在 0-100（awk 处理小数）
    filled=$(awk -v b="$barw" -v p="$pct" 'BEGIN { if (p < 0) p = 0; if (p > 100) p = 100; printf "%d", int(b * p / 100 + 0.000001) }')
    (( filled > barw )) && filled=$barw
    shown=$(awk -v p="$pct" 'BEGIN { if (p < 0) p = 0; if (p > 100) p = 100; printf "%.1f", p }')
    for (( i = 0; i < filled; i++ )); do bar+="█"; done
    for (( i = filled; i < barw; i++ )); do bar+="░"; done
    printf '\r'
    write_color "  [" "Taupe" "" 1
    write_color "$bar" "$color" "" 1
    write_color "] " "Taupe" "" 1
    write_color "$(printf '%5.1f' "$shown")%" "$color" "" 1
    write_color "  $(format_pad "$message" "$msgw")" "Taupe" "" 1
}

# 用系统默认浏览器打开网址（对应 PowerShell 的 Start-Process）
open_url() {
    if command -v open >/dev/null 2>&1; then
        open "$1"
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1
    fi
}

# 显示 Logo（纯色）
show_ascii_text() {
    local -a lines
    lines=(
        '       __________________  ____  _________    __ __'
        '      / / ____/_  __/ __ )/ __ \/ ____/   |  / //_/'
        ' __  / / __/   / / / __  /_/ / __/ / /| | / ,<   '
        '/ /_/ / /___  / / / /_/ / _, _/ /___/ ___ |/ /| |  '
        '\____/_____/ /_/ /_____/_/ |_/_____/_/  |_/_/ |_|  '
    )
    printf '\n'
    local line
    for line in "${lines[@]}"; do
        write_color "$line" "Primary"
    done
}

# ==================== 主程序 ====================

main() {
    [[ -t 1 ]] && clear

    show_ascii_text
    printf '\n'

    write_box -t "@ivenlau" \
        "欢迎使用 JetBreak" \
        "主页地址：https://k.minimo.qzz.io"

    write_alert "已更新，支持最新版本" "SUCCESS"

    # 提权检测
    if [[ $EUID -ne 0 ]]; then
        write_alert "本程序需要管理员权限运行！" "WARNING"
        wait_continue "即将申请管理员权限运行，按回车继续..."
        # 对应 PowerShell 版的 irm ... | iex：这里用 sudo 重新以 root 执行本脚本
        if command -v sudo >/dev/null 2>&1; then
            exec sudo bash "$0"
        else
            error "未找到 sudo，请直接以 root 身份运行本脚本"
            exit 1
        fi
    fi

    # ==================== 组件示例 ====================

    write_section "示例：日志输出"
    ENABLE_DEBUG=1   # 临时开启，演示 DEBUG 日志
    log "普通信息，用于流程记录" "INFO"
    success "操作成功完成"
    warning "警告信息，提醒注意事项"
    error "错误信息，操作失败时使用"
    debug "调试信息，仅开启调试时显示"
    ENABLE_DEBUG=0   # 恢复默认，隐藏 DEBUG 日志

    write_section "示例：分隔线"
    write_separator
    write_separator "带标题的分隔线" 48

    write_section "示例：信息框与提示"
    write_box \
        "无标题信息框，宽度按内容自适应" \
        "支持 -t 嵌入标题、-w 固定宽度"
    write_alert "警告提示：检测到旧版本残留" "WARNING"
    write_alert "错误提示：配置文件缺失" "ERROR"
    write_alert "信息提示：这是一条普通信息" "INFO"

    write_section "示例：键值对 / 列表 / 步骤"
    write_key_value "版本" "v2026.10"
    write_key_value "作者" "@ivenlau"
    write_bullet "列表项：默认主色圆点"
    write_bullet "列表项：自定义图标与颜色" "√" "Green" "Green"
    write_step 1 3 "第一步：准备环境"
    write_step 2 3 "第二步：执行处理"
    write_step 3 3 "第三步：清理收尾"

    write_section "示例：进度条"
    local i
    for (( i = 0; i <= 100; i += 5 )); do
        write_progress_custom "正在下载补丁包" "$i"
        sleep 0.03
    done
    write_progress_custom "正在下载补丁包" 100 24 "Green"
    printf '\n\n'

    write_section "运行前检查"
    write_bullet "请确保所有相关软件已关闭！"
    wait_continue "确认后按回车继续..."

    write_section "完成"
    write_step 1 2 "启动浏览器访问网站"
    write_key_value "下一步" "请访问网站完成进一步操作"
    write_key_value "网址" "https://k.minimo.qzz.io"
    sleep 2
    open_url "https://k.minimo.qzz.io"
    write_step 2 2 "完成，感谢使用"
    wait_continue "按回车退出程序..."
}

# 直接执行时运行主流程；被 source 时跳过（便于复用组件）
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
