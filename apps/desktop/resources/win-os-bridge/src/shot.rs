//! 窗口截图 —— 自绘界面 (读不到 UIA 元素) 的兜底眼睛。
//!
//! 对应 mac 的 `screencapture -x -t jpg` + `sips -Z 1280`。Windows 这边是 GDI:
//! `PrintWindow` 拿窗口位图 (PW_RENDERFULLCONTENT, 能拿到被遮挡/后台窗口的内容),
//! 失败退回 `BitBlt` 从屏幕 DC 抓窗口矩形。
//!
//! ─── 两个必须做的处理 ──────────────────────────────────────────────────────
//!   · **缩放**: 4K 屏上原图是几 MB, 而那几个 MB 要重新喂给模型 —— mac 那边靠
//!     sips 缩到 1280, 这里自己做一个盒式降采样 (area average), 不引 image crate:
//!     它拖进来的传递依赖实测在网差的机器上会直接拉不下来。
//!   · **落盘位置由调用方给**: 上层传 path (它必须落在 ~/.neox/run/shots/ 才被
//!     neox-asset:// 放行, 写系统临时目录的话渲染层 403, 卡片上是个破图)。
//!
//! 坐标: PrintWindow 出来的是**窗口矩形**的像素, 跟 UIA 的 bounding rect 同一
//! 坐标系 (都是物理像素, 因为桥声明了 PerMonitorV2)。所以模型按截图估的比例
//! (dx/dy, 0~1) 换算回窗口坐标是准的。

use std::fs::File;
use std::io::BufWriter;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};

/// 最长边缩到多少 (跟 mac 的 `sips -Z 1280` 对齐)
const MAX_EDGE: u32 = 1280;
const JPEG_QUALITY: u8 = 72;

/// 把窗口 (或屏幕对应区域) 存成 JPEG。
pub fn capture_window(hwnd: HWND, rect: RECT, path: &str) -> Result<(u32, u32, u64), String> {
    let w = (rect.right - rect.left).max(1) as u32;
    let h = (rect.bottom - rect.top).max(1) as u32;
    let (bgra, bw, bh) = grab_bgra(hwnd, rect, w as i32, h as i32)?;

    /* BGRA → RGB (省掉一行 alpha), 同时按需降采样 */
    let (rgb, ow, oh) = to_rgb_scaled(&bgra, bw, bh, MAX_EDGE);

    let file = File::create(path).map_err(|e| format!("写不进 {path}: {e}"))?;
    let mut writer = BufWriter::new(file);
    let encoder = jpeg_encoder::Encoder::new(&mut writer, JPEG_QUALITY);
    encoder
        .encode(&rgb, ow as u16, oh as u16, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| format!("编 JPEG 失败: {e}"))?;

    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok((ow, oh, bytes))
}

/// BGRA → RGB, 超过 max_edge 时做盒式降采样 (每个目标像素取源块的平均值)。
/// 盒式而不是最近邻: 截图要拿给模型看文字, 最近邻会把小字抽成噪点。
fn to_rgb_scaled(src: &[u8], w: u32, h: u32, max_edge: u32) -> (Vec<u8>, u32, u32) {
    let (ow, oh) = if w.max(h) > max_edge {
        let scale = max_edge as f64 / w.max(h) as f64;
        (
            ((w as f64 * scale).round() as u32).max(1),
            ((h as f64 * scale).round() as u32).max(1),
        )
    } else {
        (w, h)
    };

    let mut out = vec![0u8; (ow * oh * 3) as usize];
    for oy in 0..oh {
        let y0 = (oy * h) / oh;
        let y1 = (((oy + 1) * h) / oh).max(y0 + 1);
        for ox in 0..ow {
            let x0 = (ox * w) / ow;
            let x1 = (((ox + 1) * w) / ow).max(x0 + 1);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1.min(h) {
                for x in x0..x1.min(w) {
                    let i = ((y * w + x) * 4) as usize;
                    b += src[i] as u32;
                    g += src[i + 1] as u32;
                    r += src[i + 2] as u32;
                    n += 1;
                }
            }
            let n = n.max(1);
            let o = ((oy * ow + ox) * 3) as usize;
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
        }
    }
    (out, ow, oh)
}

/// 抓一份 BGRA 像素。先 PrintWindow (窗口自己的内容, 不受遮挡影响),
/// 不成再 BitBlt 屏幕对应区域 (那一刻它得是可见的)。
///
/// Qt / WPS 这类 GPU 窗 PrintWindow 经常**回报成功但图是纯黑**, 所以黑图也算失败,
/// 改从屏幕 DC 抓。
fn grab_bgra(hwnd: HWND, rect: RECT, w: i32, h: i32) -> Result<(Vec<u8>, u32, u32), String> {
    unsafe {
        let screen = GetDC(None);
        if screen.0.is_null() {
            return Err("拿不到屏幕 DC".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());

        /* PW_RENDERFULLCONTENT = 2: 不传它的话 Electron / UWP 窗口经常抓出一片白 */
        let mut printed =
            !hwnd.0.is_null() && PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(2)).as_bool();

        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;

        let mut buf = vec![0u8; (w * h * 4) as usize];
        let mut got = if printed {
            GetDIBits(
                mem,
                bmp,
                0,
                h as u32,
                Some(buf.as_mut_ptr() as *mut _),
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
        if got == 0 || almost_black(&buf) {
            printed = BitBlt(mem, 0, 0, w, h, Some(screen), rect.left, rect.top, SRCCOPY).is_ok();
            if printed {
                got = GetDIBits(
                    mem,
                    bmp,
                    0,
                    h as u32,
                    Some(buf.as_mut_ptr() as *mut _),
                    &mut info,
                    DIB_RGB_COLORS,
                );
            }
        }

        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        if got == 0 {
            return Err("GetDIBits 拿不到位图".into());
        }
        if !printed {
            return Err("窗口既 PrintWindow 失败也抓不到屏幕区域 (最小化时就是这样)".into());
        }
        Ok((buf, w as u32, h as u32))
    }
}

fn almost_black(buf: &[u8]) -> bool {
    if buf.len() < 16 {
        return false;
    }
    let mut sum = 0u64;
    let mut n = 0u64;
    let mut i = 0usize;
    while i + 2 < buf.len() {
        sum += buf[i] as u64 + buf[i + 1] as u64 + buf[i + 2] as u64;
        n += 1;
        i += 4 * 23;
    }
    n > 0 && (sum / n) < 10
}
