# -*- coding: utf-8 -*-
"""品牌图标渲染：单一几何常量源 -> SVG 母版 + 各尺寸 PNG（4x 超采样抗锯齿）。

品牌规范（v1.0.0 ·「此刻 MOMENT」）
- 背景：圆角方形（squircle，圆角 230/1024 ≈ 22.5%，对齐 iOS 风格）
- 背景渐变：上 #5C6CFF -> 下 #3534B8（垂直）
- 时钟圆环：白色，中心 (512,512)，半径 352，线宽 44
- 时针：10 点方向，长 168，宽 48，圆头
- 分针：2 点方向（10:10 经典"微笑时钟"），长 258，宽 36，圆头
- 中心"此刻"点：#FFC53D，半径 40
"""
import math
import os

import PIL.Image as Image
import PIL.ImageDraw as ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "branding")
ICON_DIR = os.path.join(OUT_DIR, "icons")

# ---------- 几何常量（1024 坐标系） ----------
SIZE = 1024
RADIUS = 230           # squircle 圆角
C = SIZE / 2.0         # 中心 512
RING_R = 352           # 圆环半径
RING_W = 44            # 圆环线宽
HOUR_LEN = 168         # 时针长
HOUR_W = 48            # 时针宽
MIN_LEN = 258          # 分针长
MIN_W = 36             # 分针宽
DOT_R = 40             # "此刻"点半径
# 指针方向：12 点方向角 0°，顺时针为正（屏幕坐标 y 向下）
# 10 点 = -60°，2 点 = +60°
HOUR_ANGLE = math.radians(-60)
MIN_ANGLE = math.radians(60)

C_TOP = "#5C6CFF"
C_BOTTOM = "#3534B8"
C_WHITE = "#FFFFFF"
C_AMBER = "#FFC53D"

SS = 4  # 超采样倍数


def hand_tip(length, angle):
    x = C + length * math.sin(angle)
    y = C - length * math.cos(angle)
    return x, y


HOUR_TIP = hand_tip(HOUR_LEN, HOUR_ANGLE)
MIN_TIP = hand_tip(MIN_LEN, MIN_ANGLE)

# ---------- SVG 母版 ----------
SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{C_TOP}"/>
      <stop offset="1" stop-color="{C_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="url(#bg)"/>
  <circle cx="{C:.1f}" cy="{C:.1f}" r="{RING_R}" fill="none" stroke="{C_WHITE}" stroke-width="{RING_W}"/>
  <line x1="{C:.1f}" y1="{C:.1f}" x2="{HOUR_TIP[0]:.1f}" y2="{HOUR_TIP[1]:.1f}" stroke="{C_WHITE}" stroke-width="{HOUR_W}" stroke-linecap="round"/>
  <line x1="{C:.1f}" y1="{C:.1f}" x2="{MIN_TIP[0]:.1f}" y2="{MIN_TIP[1]:.1f}" stroke="{C_WHITE}" stroke-width="{MIN_W}" stroke-linecap="round"/>
  <circle cx="{C:.1f}" cy="{C:.1f}" r="{DOT_R}" fill="{C_AMBER}"/>
</svg>
'''

# ---------- Pillow 渲染 PNG ----------
def render_master():
    S = SIZE * SS
    # 垂直渐变
    mask = Image.linear_gradient("L").resize((S, S))
    top = Image.new("RGB", (S, S), C_TOP)
    bottom = Image.new("RGB", (S, S), C_BOTTOM)
    img = Image.composite(top, bottom, mask)
    # squircle 透明背景
    alpha = Image.new("L", (S, S), 0)
    adraw = ImageDraw.Draw(alpha)
    adraw.rounded_rectangle((0, 0, S - 1, S - 1), radius=RADIUS * SS, fill=255)
    img.putalpha(alpha)
    # 圆环
    d = ImageDraw.Draw(img)
    ring_bbox = ((C - RING_R) * SS, (C - RING_R) * SS, (C + RING_R) * SS, (C + RING_R) * SS)
    d.arc(ring_bbox, 0, 360, fill=C_WHITE, width=RING_W * SS)
    # 指针（line + 两端圆头）
    for (tx, ty), w in ((HOUR_TIP, HOUR_W), (MIN_TIP, MIN_W)):
        r = w * SS / 2
        d.line((C * SS, C * SS, tx * SS, ty * SS), fill=C_WHITE, width=w * SS)
        d.ellipse((tx * SS - r, ty * SS - r, tx * SS + r, ty * SS + r), fill=C_WHITE)
        d.ellipse((C * SS - r, C * SS - r, C * SS + r, C * SS + r), fill=C_WHITE)
    # 中心"此刻"点（最上层）
    r = DOT_R * SS
    d.ellipse((C * SS - r, C * SS - r, C * SS + r, C * SS + r), fill=C_AMBER)
    return img


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    svg_path = os.path.join(OUT_DIR, "app-icon.svg")
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(SVG)
    print("Wrote", svg_path)

    master = render_master()
    for size in (1024, 512, 256, 128, 64, 32):
        out = master.resize((size, size), Image.LANCZOS)
        path = os.path.join(ICON_DIR, f"app-icon-{size}.png")
        out.save(path)
        print("Wrote", path)

    # 文字标（品牌规范示意）
    wordmark = '''<svg xmlns="http://www.w3.org/2000/svg" width="840" height="240" viewBox="0 0 840 240">
  <text x="420" y="132" text-anchor="middle" font-family="'PingFang SC','HarmonyOS Sans SC','Microsoft YaHei',system-ui,sans-serif" font-size="108" font-weight="700" fill="#1B1D3A" letter-spacing="14">此刻</text>
  <text x="420" y="196" text-anchor="middle" font-family="Inter,'Segoe UI',system-ui,sans-serif" font-size="30" font-weight="600" fill="#5C6CFF" letter-spacing="14">MOMENT</text>
</svg>
'''
    wp = os.path.join(OUT_DIR, "wordmark.svg")
    with open(wp, "w", encoding="utf-8") as f:
        f.write(wordmark)
    print("Wrote", wp)


if __name__ == "__main__":
    main()
