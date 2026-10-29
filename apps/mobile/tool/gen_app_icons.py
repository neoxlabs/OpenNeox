#!/usr/bin/env python3
"""
gen_app_icons.py — 从唯一的品牌源重烤 iOS / Android 全套应用图标.

    python3 tool/gen_app_icons.py            # 重烤并写盘
    python3 tool/gen_app_icons.py --check     # 只报告当前占比, 不写盘

── 为什么是脚本而不是一次性命令 ──────────────────────────────────────────────

    2026-08-29 Windows 那次: ICO 的源指到一张后来被删掉的 neox_logo_icon.png,
    结果烤成了一个蓝紫 3D "N"，而且**没有任何报错**。图标这种东西改一次隔几个月
    才看一眼，不可复现的手工步骤等于埋雷。所以源、占比、尺寸表全部写在这里。

── 占比怎么定的 (2026-09-04) ────────────────────────────────────────────────

    统一按**可见区 76%**。

    · 76% 的来源: Apple 图标网格里圆形基准线是 800/1024 ≈ 78%。圆形 mark 在方形
      画布里视觉上会显小, 所以比方形标要放大些。真实主屏尺寸 (120px) 下逐档比过:
      68% 明显缩水, 72% 偏小, 80% 上下已经压到圆角起弯处显得憋屈, 76% 是最后一个
      还留住呼吸的档。
    · 改之前是 iOS 53% / Android 可见 82.6% —— 两端根本不一样, 用户实拍指出
      "iOS 的 logo 占比明显比较小"。原因不是源图不同 (两边源图都是 53%),
      而是 Android 自适应图标**会裁掉外圈**。

    ⚠️ Android 不能照抄 iOS 的 76%:
       自适应图标画布 108dp, 实际只显示中间 72dp (66.7%), 安全区 66dp (61%)。
       要让"看见的"是 76%, 画布上只能放 76% × 72/108 = 50.7%。
       直接写 76% 会被裁掉一圈 —— 这正是"每次大小都不太对"的那类错。
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
# 2026-10-16 定稿老漩涡 v2: 黑底 + 白瓷漩涡 (源 = Neox/assets/brand/neox-logo/vortex-v2/mark-white.png 裁到墨迹)
SRC = ROOT / 'assets' / 'brand' / 'mark-white-1024.png'

BG = (8, 8, 10, 255)          # 品牌黑 —— 跟 Android ic_launcher_background 一致
VISIBLE_OCC = 0.70            # 可见区占比 (漩涡外圈是圆, 跟桌面图标漩涡占底板比例一致)

IOS_DIR = ROOT / 'ios' / 'Runner' / 'Assets.xcassets' / 'AppIcon.appiconset'
AND_RES = ROOT / 'android' / 'app' / 'src' / 'main' / 'res'
AND_BRAND = ROOT / 'android' / 'brand' / 'ic_launcher_1024.png'

# 自适应图标: 画布 108dp 只显示中间 72dp
ADAPTIVE_VISIBLE = 72 / 108
ADAPTIVE_OCC = VISIBLE_OCC * ADAPTIVE_VISIBLE      # ≈ 0.507
ADAPTIVE_SAFE = 66 / 108                            # 内容必须在 61% 以内


def load_mark() -> Image.Image:
    if not SRC.exists():
        sys.exit(f'❌ 找不到品牌源 {SRC}\n   它是从 Neox/design/neox-logo/official-vortex/mark-white-1024.png vendor 过来的')
    im = Image.open(SRC).convert('RGBA')
    box = im.getbbox()
    if not box:
        sys.exit('❌ 源图是空的')
    return im.crop(box)          # 去掉源图自带留白, 从纯墨迹开始算占比


def compose(mark: Image.Image, canvas: int, occ: float, transparent_bg=False) -> Image.Image:
    # 按长边缩放, 保持宽高比 (n 结不是正方形, 直接拉成方的会变形)
    side = max(1, round(canvas * occ))
    k = side / max(mark.width, mark.height)
    w, h = max(1, round(mark.width * k)), max(1, round(mark.height * k))
    m = mark.resize((w, h), Image.LANCZOS)
    bg = (0, 0, 0, 0) if transparent_bg else BG
    out = Image.new('RGBA', (canvas, canvas), bg)
    out.alpha_composite(m, ((canvas - w) // 2, (canvas - h) // 2))
    return out


def measure(path: Path) -> str:
    """报告一张图里前景相对画布的占比 —— --check 用."""
    if not path.exists():
        return '缺失'
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    px = im.load()
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(4))
    xs = []
    step = max(1, w // 300)
    for y in range(0, h, step):
        for x in range(0, w, step):
            p = px[x, y]
            if p[3] < 20:
                continue
            if abs(p[0] - bg[0]) + abs(p[1] - bg[1]) + abs(p[2] - bg[2]) > 60:
                xs.append(x)
    if not xs:
        return f'{w}x{h} 检不出前景'
    return f'{w}x{h} 占比 {(max(xs) - min(xs)) / w:.0%}'


def gen_ios(mark, write: bool) -> None:
    contents = json.loads((IOS_DIR / 'Contents.json').read_text())
    done = {}
    for entry in contents['images']:
        fn = entry.get('filename')
        if not fn or fn in done:
            continue
        px = round(float(entry['size'].split('x')[0]) * int(entry['scale'].rstrip('x')))
        done[fn] = px
    for fn, px in sorted(done.items(), key=lambda kv: kv[1]):
        target = IOS_DIR / fn
        if write:
            # iOS 图标**不能有 alpha** —— 带透明通道会被 App Store 直接拒收
            compose(mark, px, VISIBLE_OCC).convert('RGB').save(target)
        print(f'  iOS  {fn:30s} {px:>4}px')
    print(f'  → iOS 共 {len(done)} 个规格, 占比 {VISIBLE_OCC:.0%}, 无 alpha')


def gen_android(mark, write: bool) -> None:
    if ADAPTIVE_OCC > ADAPTIVE_SAFE:
        sys.exit(f'❌ 自适应占比 {ADAPTIVE_OCC:.1%} 超出安全区 {ADAPTIVE_SAFE:.1%}, 会被裁')
    for d in sorted(AND_RES.glob('mipmap-*')):
        fg = d / 'ic_launcher_foreground.png'
        bgp = d / 'ic_launcher_background.png'
        legacy = d / 'ic_launcher.png'
        if fg.exists():
            canvas = Image.open(fg).size[0]
            if write:
                # 前景层透明底 —— 背景层是另一张图, 叠上去才成图标
                compose(mark, canvas, ADAPTIVE_OCC, transparent_bg=True).save(fg)
            print(f'  AND  {fg.relative_to(ROOT)} {canvas}px 占比 {ADAPTIVE_OCC:.0%} (可见 {VISIBLE_OCC:.0%})')
        if bgp.exists() and write:
            c = Image.open(bgp).size[0]
            Image.new('RGBA', (c, c), BG).save(bgp)
        if legacy.exists():
            # 旧版方形图标不走自适应裁切, 按 iOS 同一口径
            c = Image.open(legacy).size[0]
            if write:
                compose(mark, c, VISIBLE_OCC).convert('RGB').save(legacy)
            print(f'  AND  {legacy.relative_to(ROOT)} {c}px 占比 {VISIBLE_OCC:.0%}')
    if AND_BRAND.exists():
        if write:
            compose(mark, 1024, VISIBLE_OCC).convert('RGB').save(AND_BRAND)
        print(f'  AND  {AND_BRAND.relative_to(ROOT)} 1024px 占比 {VISIBLE_OCC:.0%}')


def main() -> None:
    check_only = '--check' in sys.argv
    if check_only:
        print('当前盘上的图标 (不写盘):')
        print(' ', IOS_DIR.name, measure(IOS_DIR / 'Icon-App-1024x1024@1x.png'))
        print('  android/brand', measure(AND_BRAND))
        p = AND_RES / 'mipmap-xxxhdpi' / 'ic_launcher_foreground.png'
        print('  adaptive fg  ', measure(p))
        return
    mark = load_mark()
    print(f'源: {SRC.relative_to(ROOT)}  可见区占比 {VISIBLE_OCC:.0%}')
    gen_ios(mark, True)
    gen_android(mark, True)
    print('✅ 完成')


if __name__ == '__main__':
    main()
