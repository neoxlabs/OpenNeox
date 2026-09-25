# 用 Windows 自带 OCR (Windows.Media.Ocr) 读一张截图 —— 零安装、系统内置。
#
# 用途: 量化"像素层"这条路的能力 —— 自绘应用 (QQ / 任务管理器) 读不到 UIA 元素时,
# 截图 + OCR 到底能拿回多少可点目标, 代价是多少毫秒。
#
# 用法: set OCR_IMG=<绝对路径> && powershell -NoProfile -ExecutionPolicy Bypass -File scripts/win-ocr.ps1
# 参数走**环境变量**而不是 -Path: cmd 下 `-File x.ps1 -Path "C:\..."` 实测绑不上
# (进来是空的, 报 "Empty path name is not legal"), 换成环境变量就没有引号/转义那一层。
#
# 输出三列 (TSV): x \t y \t 文本。结尾一行: TOTAL \t 行数 \t 毫秒数。
param([string]$Path)
if (-not $Path) { $Path = $env:OCR_IMG }
if (-not $Path -or -not (Test-Path $Path)) { Write-Output ("ERR`tfind no image: '" + $Path + "'"); exit 1 }

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait() | Out-Null
  $t.Result
}

[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Output "ERR`tno OCR engine"; exit 1 }

# ⚠️ 不要用 [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream —— 这台机器
# 的 PowerShell 里**根本没有这个类型** (实测 "Unable to find type")。症状极具误导性:
# 报的是 "AsRandomAccessStream 参数 stream 为 null", 看起来像文件打不开, 实际上是
# 那个静态方法压根不存在。绕开它: 纯 WinRT 读字节 (InMemoryRandomAccessStream + DataWriter),
# 一个 interop 扩展类都不用。
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataWriter, Windows.Storage, ContentType = WindowsRuntime] | Out-Null

$bytes = [System.IO.File]::ReadAllBytes($Path)
$mem = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
$dw = [Windows.Storage.Streams.DataWriter]::new($mem.GetOutputStreamAt(0))
$dw.WriteBytes($bytes)
Await ($dw.StoreAsync()) ([uint32]) | Out-Null
Await ($dw.FlushAsync()) ([bool]) | Out-Null
$dw.DetachStream() | Out-Null
$mem.Seek(0)

$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($mem)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$mem.Dispose()

# `$result.Lines` / `$line.Words` 是 WinRT 的 IVectorView —— 直接用索引/Count 会被 PS
# 当成数组数组 (实测: [int]$first.X 报 "无法把 Object[] 转成 Int32")。用 @() 包一层再取。
$lines = 0
foreach ($line in @($result.Lines)) {
  $w = @(@($line.Words) | Select-Object -First 1)
  $x = if ($w.Count -gt 0) { [int]$w[0].BoundingRect.X } else { 0 }
  $y = if ($w.Count -gt 0) { [int]$w[0].BoundingRect.Y } else { 0 }
  if ($line.Text) {
    Write-Output ("{0}`t{1}`t{2}" -f $x, $y, $line.Text)
    $lines++
  }
}
$sw.Stop()
Write-Output ("TOTAL`t{0}`t{1}" -f $lines, $sw.ElapsedMilliseconds)
