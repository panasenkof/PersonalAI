#!/usr/bin/env python3
"""Generate an offline, reproducible JPG test kit from committed definitions.

These are deliberately synthetic *illustrations*, not photographic evidence.
They are useful for smoke-testing query/ranking/negative pairs, NOT a claim
about real-photo Recall@K. Requires Pillow; no network at runtime.
"""
from __future__ import annotations
import hashlib
import json
import math
import random
import sys
import zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
W, H = 640, 440
PALETTE = {
    "red": "#c83139", "blue": "#245ab5", "green": "#48965b",
    "pink": "#ee94af", "brown": "#996344", "orange": "#d98532",
    "white": "#e7dfd4", "gray": "#69747b", "glass": "#92d2d6",
    "tabby": "#b7a089",
}
def poly(d, coords, fill, outline=None, width=2):
    d.polygon(coords, fill=fill)
    if outline:
        d.line(coords + [coords[0]], fill=outline, width=width, joint="curve")

def background(d, scene, rng):
    indoor = scene in ("sofa", "chair", "living", "table", "shelf", "bowl")
    for y in range(H):
        if indoor:
            fill = (239-max(0,y//17), 229-max(0,y//22), 208-max(0,y//24))
        elif scene in ("mountains", "snow", "beach", "city"):
            fill = (127+y//18, 174+y//25, 215+y//30)
        else:
            fill = (159+y//30, 205+y//37, 234+y//45)
        d.line([(0,y),(W,y)],fill=fill)
    if scene in ("mountains","snow"):
        poly(d, [(0,235),(120,75),(245,242)], "#777b8b")
        poly(d, [(145,245),(336,40),(531,256)], "#6e8197")
        poly(d, [(306,86),(336,40),(378,115),(352,105),(330,86)], "#f9fcff")
        poly(d, [(92,112),(120,75),(153,117)], "#f5faff")
        d.rectangle((0,262,W,H),fill="#447b9d" if scene=="mountains" else "#d6e7f1")
    elif scene=="beach":
        d.rectangle((0,210,W,350),fill="#277da6")
        d.rectangle((0,350,W,H),fill="#ead29e")
    elif scene=="city":
        d.rectangle((0,340,W,H),fill="#505a65")
        for x in range(20,640,73):
            height=rng.randrange(120,225)
            d.rectangle((x,342-height,x+52,342),fill="#53627b")
            for wx in range(x+7,x+47,15):
                for wy in range(355-height,320,23):
                    d.rectangle((wx,wy,wx+7,wy+12),fill="#f4df98")
    elif indoor:
        d.rectangle((0,293,W,H),fill="#bc9a7c")
        for x in range(0,W,55):
            d.line((x,293,x-30,H),fill="#a68873",width=2)
        if scene=="shelf":
            d.rectangle((60,150,590,180),fill="#a86e45")
            d.rectangle((60,295,590,317),fill="#a86e45")
        elif scene in ("table","bowl"):
            d.rounded_rectangle((72,288,582,337),radius=8,fill="#a86d42")
            d.rectangle((107,334,128,H),fill="#855236")
            d.rectangle((530,334,550,H),fill="#855236")
    else:
        d.rectangle((0,286,W,H),fill="#8ab16e")
        for i in range(80):
            x,y=rng.randrange(0,W),rng.randrange(285,H)
            d.ellipse((x,y,x+3,y+2),fill=rng.choice(["#709f58","#6b9254","#a4b77a"]))
        if scene=="home":
            d.rectangle((50,125,530,293),fill="#eee1d0")
            poly(d,[(30,126),(290,43),(550,126)],"#744c3b")
            for x in (95,407):
                d.rectangle((x,167,x+85,255),fill="#5786a0")
                d.line((x+42,167,x+42,255),fill="white",width=5)
        if scene=="bench":
            d.rounded_rectangle((55,248,320,271),6,fill="#855b3e")
            d.rectangle((80,270,94,361),fill="#554332")
            d.rectangle((295,270,307,361),fill="#554332")

def tree(d, x=112):
    d.polygon([(x-22,355),(x-14,142),(x+20,142),(x+28,355)],fill="#745840")
    for dx,dy,rad in [(0,113,78),(-44,170,60),(44,159,60),(-32,87,45)]:
        d.ellipse((x+dx-rad,dy-rad,x+dx+rad,dy+rad),fill="#4a8b45")
    for y in range(180,320,22):
        d.line((x-4,y,x+8,y+7),fill="#4b372b",width=3)

def bicycle(d, color, dx=0, dy=0, identity=""):
    c=PALETTE.get(color,color)
    x,y=215+dx,318+dy
    radius=66
    for wx in (x, x+240):
        d.ellipse((wx-radius,y-radius,wx+radius,y+radius),outline="#242a2f",width=11)
        d.ellipse((wx-radius+11,y-radius+11,wx+radius-11,y+radius-11),outline="#c5ccd1",width=3)
        for angle in range(0,360,30):
            th=math.radians(angle)
            d.line((wx,y,wx+49*math.cos(th),y+49*math.sin(th)),fill="#c7cbd0",width=1)
    # Intentionally consistent triangle structure for the same synthetic bike identity.
    tail=(x,y);pedal=(x+107,y-12); seat=(x+72,y-111); head=(x+177,y-125)
    for a,b in [(tail,seat),(seat,pedal),(pedal,tail),(pedal,head),(head,seat)]:
        d.line((*a,*b),fill=c,width=13,joint="curve")
        d.line((*a,*b),fill="#f0d3d0",width=2)
    d.line((head[0],head[1],x+240,y),fill="#343c46",width=7)
    d.line((head[0]-10,head[1]-18,head[0]+29,head[1]-19),fill="#2b343a",width=7)
    d.line((seat[0]-15,seat[1]-13,seat[0]+33,seat[1]-14),fill="#353434",width=8)
    d.ellipse((pedal[0]-8,pedal[1]-8,pedal[0]+8,pedal[1]+8),fill="#22272e")
    if identity=="B":
        d.rectangle((x+86,y-113,x+111,y-100),fill="#171717")

def motor(d,color):
    c=PALETTE.get(color,color)
    for x in (220,455):
        d.ellipse((x-64,268,x+64,396),fill="#2a333a")
        d.ellipse((x-46,284,x+46,380),fill="#bdc3c8")
    poly(d,[(175,270),(294,232),(388,244),(448,290),(324,332)],c)
    d.line((415,260,458,189,492,195),fill="#222831",width=9)
    d.rounded_rectangle((269,218,380,237),radius=5,fill="#39383c")

def car(d,color,kind="car"):
    c=PALETTE.get(color,color)
    if kind=="bus":
        d.rounded_rectangle((170,170,530,348),radius=24,fill=c)
        for x in range(201,469,80):
            d.rectangle((x,197,x+63,273),fill="#74a9bf")
    else:
        poly(d,[(130,305),(175,241),(275,232),(329,165),(444,165),(502,238),(542,257),(555,330),(123,330)],c)
        poly(d,[(305,227),(339,185),(430,185),(474,231)],"#85b8c8")
    for x in (210,466):
        d.ellipse((x-41,302,x+41,383),fill="#24292f")
        d.ellipse((x-20,323,x+20,364),fill="#bec2c4")

def sofa(d):
    d.rounded_rectangle((119,223,535,370),22,fill="#6f7b87")
    d.rounded_rectangle((144,185,508,300),25,fill="#8d949c")
    d.line((325,208,325,348),fill="#596773",width=5)
    d.rectangle((141,363,157,409),fill="#584a42")
    d.rectangle((506,363,522,409),fill="#584a42")

def pet(d, kind, surface, rng):
    if surface=="sofa": sofa(d)
    if surface=="chair":
        d.rounded_rectangle((225,273,465,319),10,fill="#77563b")
        d.rectangle((244,317,260,407),fill="#6d543e")
    if kind=="sofa": return
    is_cat=kind=="cat"
    body="#b8aa91" if is_cat else "#b37c52"
    d.ellipse((245,250,450,369),fill=body)
    d.ellipse((335,166,468,299),fill=body)
    if is_cat:
        poly(d,[(357,200),(350,155),(396,182)],body)
        poly(d,[(417,179),(446,145),(444,206)],body)
        for x in (368,417):
            d.ellipse((x,220,x+12,234),fill="#4f725b")
        d.polygon([(393,246),(405,247),(399,256)],fill="#654b4f")
        for dy in range(268,311,21):
            d.arc((280,dy,430,dy+40),190,300,fill="#806b5d",width=5)
        d.arc((181,223,285,350),20,330,fill=body,width=13)
    else:
        d.ellipse((347,210,363,224),fill="#4b382d")
        d.ellipse((423,210,439,224),fill="#4b382d")
        d.ellipse((390,241,410,257),fill="#352b24")
        d.ellipse((330,164,358,240),fill="#855638")
        d.ellipse((450,173,478,242),fill="#855638")

def flowers(d,color,scene,kind):
    c=PALETTE.get(color,color)
    vase=(kind=="vase" or scene=="table") and kind not in ("flowers_garden",)
    if scene=="table":
        d.polygon([(286,275),(410,275),(391,390),(307,390)],fill="#9bc9d0")
        d.line((287,282,408,282),fill="#e4fbfe",width=6)
    elif kind=="vase":
        d.polygon([(286,260),(410,260),(391,379),(307,379)],fill="#9ac9cf")
    if kind in ("flowers","tulips"):
        for i in range(7):
            x=255+i*27;y=130+(i%3)*19
            d.line((350,290,x,y),fill="#428e58",width=5)
            if kind=="tulips":
                poly(d,[(x-19,y+12),(x-10,y-17),(x,y-7),(x+11,y-20),(x+20,y+12)],c)
            else:
                for angle in range(0,360,72):
                    t=math.radians(angle)
                    px=x+15*math.cos(t);py=y+15*math.sin(t)
                    d.ellipse((px-13,py-13,px+13,py+13),fill=c)
                d.ellipse((x-7,y-7,x+7,y+7),fill="#e7c96a")

def food(d, kind, scene, rng):
    d.ellipse((160,220,490,398),fill="#f5f5ee",outline="#c4c6ca",width=9)
    d.ellipse((195,250,455,369),fill="#d5dadc" if scene=="bowl" else "#f1f0e7")
    if kind=="plate": return
    if kind=="salad":
        for j in range(55):
            x,y=rng.randrange(224,430),rng.randrange(267,348)
            d.ellipse((x-12,y-7,x+14,y+8),fill=rng.choice(["#409552","#57a567","#d65d43"]))
    elif kind=="soup":
        d.ellipse((204,259,445,359),fill="#ca653b")
    else:
        for j in range(45):
            x,y=rng.randrange(210,435),rng.randrange(262,360)
            d.arc((x,y,x+42,y+26),10,250,fill=rng.choice(["#eab761","#ca8b38","#cd7443"]),width=4)

def household(d,kind,color):
    c=PALETTE.get(color,color)
    if kind=="table": return
    if kind=="mug":
        d.rounded_rectangle((273,188,405,315),10,fill=c)
        d.arc((384,203,470,297),270,90,fill=c,width=15)
        d.ellipse((278,184,401,207),fill="#d4d0c1")
    elif kind=="vase":
        d.polygon([(277,187),(397,187),(380,340),(299,340)],fill=c)

def landscape(d,kind,scene,rng):
    if kind=="lake":
        d.ellipse((28,300,610,458),fill="#4484b9")
        for y in range(310,435,22):
            d.line((rng.randrange(20,185),y,rng.randrange(380,620),y),fill="#8db7c6",width=3)
    elif kind=="forest":
        d.polygon([(250,240),(380,240),(580,440),(75,440)],fill="#b9a98b")
        for x in range(30,640,73):
            d.line((x,110,x,313),fill="#5e4b3a",width=17)
            d.ellipse((x-70,50,x+75,190),fill="#3b7848")
    elif kind=="sea":
        d.ellipse((100,327,590,421),fill="#e3ce9d")
    elif kind=="mountain":
        pass

def render(item):
    seed=int(hashlib.sha256(item["id"].encode()).hexdigest()[:8],16)
    rng=random.Random(seed)
    img=Image.new("RGB",(W,H))
    d=ImageDraw.Draw(img)
    scene=item["scene"]; kind=item["object"]; color=item["color"]
    background(d,scene,rng)
    if kind in ("bicycle","motorcycle","tree","bench") and scene in ("park","bench"):
        if scene=="park": tree(d,105)
    if kind=="bicycle":
        identity=item.get("identity","")
        dx=-24 if item["id"]=="candidate_bike_A_angle" else 0
        bicycle(d,color,dx=dx,dy=4 if identity=="A" else 0,identity=identity)
    elif kind=="motorcycle": motor(d,color)
    elif kind in ("car","bus"): car(d,color,kind)
    elif kind=="house": pass
    elif kind in ("cat","dog","sofa"): pet(d,kind,scene,rng)
    elif kind in ("flowers","tulips") or (kind=="vase" and item["group"]=="FLOWERS"):
        flowers(d,color,scene,kind)
    elif kind in ("pasta","salad","plate","soup"): food(d,kind,scene,rng)
    elif kind in ("mug","vase","table"): household(d,kind,color)
    elif kind in ("lake","mountain","forest","sea","city"): landscape(d,kind,scene,rng)
    elif kind=="bench":
        d.rounded_rectangle((225,246,485,274),7,fill="#996b42")
        d.rectangle((255,272,268,370),fill="#654a38")
        d.rectangle((450,272,464,370),fill="#654a38")
    # Slight per-case camera grain, deterministic and free of text overlays.
    for j in range(850):
        x,y=rng.randrange(W),rng.randrange(H)
        r,g,b=img.getpixel((x,y)); shift=rng.randrange(-8,9)
        d.point((x,y),fill=(max(0,min(255,r+shift)),max(0,min(255,g+shift)),max(0,min(255,b+shift))))
    return img.filter(ImageFilter.GaussianBlur(0.35))

def main():
    out=Path(sys.argv[1] if len(sys.argv)>1 else "build/vision-fixtures")
    out.mkdir(parents=True,exist_ok=True)
    (out/"images").mkdir(exist_ok=True)
    manifest=json.loads((HERE/"cases.json").read_text(encoding="utf-8"))
    count=0
    for group in manifest["groups"]:
        for item in group["cases"]:
            render({**item,"group":group["group"]}).save(
                out/"images"/(item["id"]+".jpg"),
                format="JPEG",quality=88,optimize=True
            )
            count+=1
    assert count==41, f"unexpected fixture count: {count}"
    (out/"cases.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
    readme=(
        "PersAI Vision Lab: 41 ПРОЦЕДУРНО СГЕНЕРИРОВАННАЯ ИЛЛЮСТРАЦИЯ (НЕ ФОТОГРАФИИ)\n"
        "Картинки без встроенных подписей, чтобы не искажать визуальный поиск.\n"
        "Выберите группу из cases.json. Для текста возьмите query и 2-5 файлов.\n"
        "Метки positive / hard / negative заданы ЗАРАНЕЕ человеком.\n"
        "Для PHOTO_TO_PHOTO выберите ref_bike_A как образец, а кандидатов по номерам.\n"
        "Это smoke-тест механики ранжирования, НЕ доказательство Recall на реальных фото.\n"
        "Все изображения созданы генератором из репозитория: fixtures/generate.py.\n"
    )
    (out/"README_RU.txt").write_text(readme,encoding="utf-8")
    archive=out/"PersAI_Vision_41_cases.zip"
    with zipfile.ZipFile(archive,"w",compression=zipfile.ZIP_DEFLATED) as z:
        for p in sorted(out.glob("images/*.jpg")):
            z.write(p,p.relative_to(out))
        z.write(out/"cases.json","cases.json")
        z.write(out/"README_RU.txt","README_RU.txt")
    print(f"Generated {count} JPEG cases + labels: {archive}")
if __name__=="__main__": main()
