"""生成 control-your-video 的 README 封面横幅（约 2:1）。

只用真实素材：三张取自那支 5 分 12 秒实测成片的静帧 + 仓库自带的 icon.svg 配色。
不画虚构界面，不写口号。
"""

from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1600, 800
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")

BG_TOP = (13, 20, 27)
BG_BOT = (29, 39, 51)
ACCENT = (61, 139, 255)
ACCENT_LIGHT = (127, 212, 255)
TEXT = (233, 240, 247)
MUTED = (138, 156, 173)

FONT_BD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_RG = r"C:\Windows\Fonts\msyh.ttc"

canvas = Image.new("RGB", (W, H), BG_TOP)
draw = ImageDraw.Draw(canvas)

# 竖向渐变背景
for y in range(H):
    t = y / (H - 1)
    r = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
    g = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
    b = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)
    draw.line([(0, y), (W, y)], fill=(r, g, b))

# 右侧三帧真实的成片静帧，斜向层叠但不互相压字
FRAMES = [
    ("01-cold-open.jpg", 860, 92, 470),
    ("02-open-vs-closed.jpg", 1010, 322, 430),
    ("03-mechanism.jpg", 800, 548, 400),
]
for name, x, y, w in FRAMES:
    path = os.path.join(ASSETS, name)
    if not os.path.exists(path):
        continue
    img = Image.open(path).convert("RGB")
    h = int(img.height * (w / img.width))
    img = img.resize((w, h), Image.LANCZOS)
    # 圆角遮罩
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=10, fill=255)
    # 描边：只画在圆角边界内，避免右上角出现色块
    border_mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(border_mask).rounded_rectangle(
        [0, 0, w - 1, h - 1], radius=10, outline=255, width=1
    )
    canvas.paste(Image.new("RGB", (w, h), (46, 67, 86)), (x, y), border_mask)
    canvas.paste(img, (x, y), mask)
    draw = ImageDraw.Draw(canvas)

# 左侧文字区
f_title = ImageFont.truetype(FONT_RG, 54)
f_sub = ImageFont.truetype(FONT_BD, 30)
f_small = ImageFont.truetype(FONT_RG, 22)
f_tag = ImageFont.truetype(FONT_RG, 19)

# 顶部细线
draw.rounded_rectangle([80, 118, 132, 124], radius=3, fill=ACCENT)

draw.text((80, 150), "control-your-video", font=f_title, fill=TEXT)
draw.text((80, 228), "让 AI 真的会做片子", font=f_sub, fill=ACCENT_LIGHT)

lines = [
    "一个 Preset 装配能力，13 个 Skill 提供专业方法",
    "作品放你自己的文件夹，经验沉淀成你自己的资产库",
]
yy = 300
for ln in lines:
    draw.text((80, yy), ln, font=f_small, fill=MUTED)
    yy += 38

# 分隔线
draw.line([(80, 410), (560, 410)], fill=(46, 67, 86), width=1)

tags = ["DeepSeek Harness 插件", "MIT", "v0.2.1"]
xx = 80
for t in tags:
    tw = draw.textlength(t, font=f_tag)
    draw.rounded_rectangle([xx, 440, xx + tw + 28, 484], radius=22,
                           outline=(46, 67, 86), width=1, fill=(22, 31, 41))
    draw.text((xx + 14, 452), t, font=f_tag, fill=MUTED)
    xx += tw + 42

draw.text((80, 620), "画面取自本插件从零做到交付的 5 分 12 秒科普片",
          font=f_tag, fill=(98, 114, 130))

out = os.path.join(ASSETS, "cover.png")
canvas.save(out, "PNG", optimize=True)
print(f"{out} {os.path.getsize(out)} bytes {canvas.size}")
