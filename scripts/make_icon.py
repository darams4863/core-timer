"""앱 아이콘(열리는 자물쇠) 생성: python3 scripts/make_icon.py → assets/app-icon.png"""
from PIL import Image, ImageDraw

S, SS = 1024, 2
W = S * SS
R = lambda v: int(v * SS)
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([R(64), R(64), R(960), R(960)], radius=R(220), fill=(16, 24, 36, 255))
d.rounded_rectangle([R(64), R(64), R(960), R(960)], radius=R(220), outline=(255, 255, 255, 22), width=R(6))

# 고리: 위로 들린 상태(열림), 오른쪽 다리만 몸통에 꽂힘
cx, cy, ro, ri, lift = 512, 400, 190, 118, 70
th = ro - ri
white = (232, 238, 245, 255)
top = cy - lift
d.arc([R(cx - ro + th / 2), R(top - ro + th / 2), R(cx + ro - th / 2), R(top + ro - th / 2)], 180, 360, fill=white, width=R(th))
d.rectangle([R(cx + ri), R(top - 1), R(cx + ro), R(560)], fill=white)
d.rounded_rectangle([R(cx - ro), R(top - 1), R(cx - ri), R(top + 64)], radius=R(18), fill=white)
d.rectangle([R(cx - ro), R(top - 1), R(cx - ri), R(top + 30)], fill=white)

# '딸깍' 움직임 표시
for x, y, l in [(262, 300, 58), (242, 365, 78), (262, 430, 58)]:
    d.rounded_rectangle([R(x - l), R(y - 9), R(x), R(y + 9)], radius=R(9), fill=(255, 214, 102, 230))

# 몸통: 오전(민트) → 오후(보라) 그라데이션, 아래부터 차오르는 진행 바 느낌
bx0, by0, bx1, by1 = 262, 470, 762, 860
grad = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
c1, c2 = (79, 209, 165), (138, 168, 255)
for x in range(R(bx0), R(bx1)):
    t = (x - R(bx0)) / (R(bx1) - R(bx0))
    gd.line([(x, R(by0)), (x, R(by1))], fill=tuple(int(c1[k] * (1 - t) + c2[k] * t) for k in range(3)) + (255,))
gd.rectangle([R(bx0), R(by0), R(bx1), R(620)], fill=None)
shade = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(shade).rectangle([R(bx0), R(by0), R(bx1), R(620)], fill=(10, 20, 30, 80))
grad = Image.alpha_composite(grad, shade)
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([R(bx0), R(by0), R(bx1), R(by1)], radius=R(80), fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
hole = (16, 24, 36, 255)
d.ellipse([R(466), R(594), R(558), R(686)], fill=hole)
d.polygon([(R(486), R(660)), (R(538), R(660)), (R(550), R(770)), (R(474), R(770))], fill=hole)

img.resize((S, S), Image.LANCZOS).save("assets/app-icon.png")
print("assets/app-icon.png")
