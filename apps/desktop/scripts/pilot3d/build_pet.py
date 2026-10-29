"""
Pilot 3D 形象 (2026-10-01) —— 用 Blender 脚本把猫 / 柯基从零搭出来, 绑好骨, 导出 glb。

    blender -b -P build_pet.py -- cat   <out.glb> [预览图目录]
    blender -b -P build_pet.py -- corgi <out.glb> [预览图目录]

风格对齐 2D 头像 (assets/mascots/*-idle.webp): 软胶玩具, 大头小身子, 没有写实毛发。

舞台 (PilotStage.tsx) 认的东西, 名字别乱改:
  骨头   head (看人 / 点头 / 歪头)、ear.L/R、tail.1..n、paw.L/R
  形变   blink (眼睛)、mouthOpen (嘴)
  材质   glow (胸口的灯, 说话时跟着亮)
  动作   Idle (循环)、Wave (开场挥爪)

坐标: Blender Z 朝上、角色脸朝 -Y; 导出成 glTF 后是 Y 朝上、脸朝 +Z (正对舞台相机)。
所有部件都是蒙皮网格: 硬的部件整块权重 1 挂一根骨头, 尾巴按长度渐变分给几节骨头。
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SPECIES = argv[0] if argv else 'cat'
OUT = argv[1] if len(argv) > 1 else f'/tmp/{SPECIES}.glb'
PREVIEW_DIR = argv[2] if len(argv) > 2 else None


# ───────────────────────── 外观参数 ─────────────────────────

def srgb(hex_):
    """#rrggbb → 线性 RGB (Blender 材质吃线性值)"""
    c = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def _ss(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def corgi_head_color(co):
    """柯基的脸: 一道白从脑门往下变宽, 接上奶白的下半张脸; 其余橘色。边缘软过渡, 不然减面后是锯齿"""
    orange, cream = srgb('#e3a25e'), srgb('#fbefdc')
    low = _ss((0.5 - 0.12 * (co.x / 0.46) ** 2 - co.z) / 0.03 + 0.5) * _ss((0.05 - co.y) / 0.04)
    width = 0.03 + max(0.0, 0.8 - co.z) * 0.45
    stripe = _ss((width - abs(co.x)) / 0.015 + 0.5) * _ss((-0.12 - co.y) / 0.04) * _ss((co.z - 0.45) / 0.03)
    k = max(low, stripe)
    return tuple(orange[i] + (cream[i] - orange[i]) * k for i in range(3))


def corgi_body_color(co):
    """柯基的身子: 橘色, 爪子 (腿的下截) 和胸口奶白"""
    orange, cream = srgb('#e3a25e'), srgb('#fbefdc')
    paws = _ss((0.24 - co.z) / 0.04 + 0.5) * _ss((0.02 - co.y) / 0.05)
    chest = _ss((0.14 - abs(co.x)) / 0.04 + 0.5) * _ss((-0.08 - co.y) / 0.05)
    k = max(paws, chest)
    return tuple(orange[i] + (cream[i] - orange[i]) * k for i in range(3))


LOOKS = {
    'cat': dict(
        fur='#f4f3f6', fur2='#f4f3f6', inner_ear='#efdfe2', nose=None,
        ear=dict(r=0.16, h=0.19, sink=0.08, x=0.3, tilt=0.4, flat=0.5, tip=0.28),
        eye_x=0.19, eye_z=0.57,
        head_color=lambda co: srgb('#f4f3f6'),
        body_color=lambda co: srgb('#f4f3f6'),
        tail='cat',
    ),
    'corgi': dict(
        fur='#e3a25e', fur2='#fbefdc', inner_ear='#f5c9b8', nose='#2a1d1a',
        ear=dict(r=0.18, h=0.3, sink=0.08, x=0.28, tilt=0.42, flat=0.42, tip=0.22),
        eye_x=0.18, eye_z=0.63,
        head_color=lambda co: corgi_head_color(co),
        body_color=lambda co: corgi_body_color(co),
        tail='stub',
    ),
}
L = LOOKS[SPECIES]


# ───────────────────────── 场景 / 材质 ─────────────────────────

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def material(name, hex_, rough=0.6, coat=0.08, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*srgb(hex_), 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Coat Weight'].default_value = coat
    b.inputs['Coat Roughness'].default_value = 0.3
    if emit:
        b.inputs['Emission Color'].default_value = (*srgb(emit), 1)
        b.inputs['Emission Strength'].default_value = strength
    return m


M = {
    'fur': material('fur', L['fur']),
    'fur2': material('fur2', L['fur2']),
    'inner_ear': material('inner_ear', L['inner_ear'], rough=0.6, coat=0),
    'eye': material('eye', '#141418', rough=0.08, coat=1),
    'mouth': material('mouth', '#4a2228', rough=0.7, coat=0),
    'glow': material('glow', '#ffffff', rough=0.3, coat=0.5, emit='#c9c2ff', strength=0.25),
}
M['head'] = material('head', '#ffffff')
M['body'] = material('body', '#ffffff')


# 灯 (紫蓝粉渐变) 和头 (花色) 的底色走顶点色, 导出成 COLOR_0, three 那边自动乘上
def use_vertex_color(m):
    t = m.node_tree
    attr = t.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    t.links.new(attr.outputs['Color'], t.nodes['Principled BSDF'].inputs['Base Color'])


use_vertex_color(M['glow'])
use_vertex_color(M['head'])
use_vertex_color(M['body'])
if L['nose']:
    M['nose'] = material('nose', L['nose'], rough=0.15, coat=1)


# ───────────────────────── 造型工具 ─────────────────────────

def new_obj(name, bm, mat, subsurf=0):
    me = bpy.data.meshes.new(name)
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(me)
    bm.free()
    # 网格名带 m_ 前缀: 跟骨头 (head / paw.R / tail…) 同名的话, three 按名字绑动作会绑到网格上, 头直接翻过去
    ob = bpy.data.objects.new('m_' + name, me)
    scene.collection.objects.link(ob)
    me.materials.append(mat)
    if subsurf:
        mod = ob.modifiers.new('subsurf', 'SUBSURF')
        mod.levels = mod.render_levels = subsurf
    return ob


def xform(loc=(0, 0, 0), scale=(1, 1, 1), rot=(0, 0, 0)):
    r = Matrix.Rotation(rot[2], 4, 'Z') @ Matrix.Rotation(rot[1], 4, 'Y') @ Matrix.Rotation(rot[0], 4, 'X')
    s = Matrix.Diagonal((*scale, 1))
    return Matrix.Translation(loc) @ r @ s


def blob(name, loc, radii, mat, rot=(0, 0, 0), seg=28, rings=16, subsurf=1):
    """椭球 —— 整只都是这种圆鼓鼓的东西拼起来的"""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1)
    bmesh.ops.transform(bm, matrix=xform(loc, radii, rot), verts=bm.verts)
    return new_obj(name, bm, mat, subsurf)


# 头 = 圆角方块 (超椭球 |x/a|^n + |y/b|^n + |z/c|^n = 1, n>2 越大越方), 跟 2D 头像的"软方块"一致
HEAD_C = Vector((0, 0, 0.62))
HEAD_R = (0.46, 0.38, 0.355)
HEAD_N = 2.25


def superellipsoid(bm, center, radii, n, seg=64, rings=40):
    a, b, c = radii
    made = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1)['verts']
    for v in made:
        d = v.co.normalized()
        s = (abs(d.x / a) ** n + abs(d.y / b) ** n + abs(d.z / c) ** n) ** (-1 / n)
        v.co = center + d * s


def head_front_y(x, z):
    """头前表面 (脸) 在 (x, z) 处的 y —— 眼睛 / 嘴 / 口鼻按它贴脸"""
    a, b, c = HEAD_R
    k = 1 - abs(x / a) ** HEAD_N - abs((z - HEAD_C.z) / c) ** HEAD_N
    return HEAD_C.y - b * max(k, 0) ** (1 / HEAD_N)


def head_top_z(x):
    a, b, c = HEAD_R
    return HEAD_C.z + c * max(1 - abs(x / a) ** HEAD_N, 0) ** (1 / HEAD_N)


def ear_frame(side):
    """耳朵的根部中心和朝向: 从头顶两角往外斜着长出来"""
    e = L['ear']
    x = e['x'] * side
    axis = Vector((math.sin(e['tilt']) * side, 0.12, math.cos(e['tilt']))).normalized()
    base = Vector((x, 0.02, head_top_z(x))) - axis * e['sink']
    return base, axis


def add_cone(bm, base, axis, r, h, flat, tip=0.14):
    made = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=32, radius1=r, radius2=r * tip, depth=h)['verts']
    up = axis.normalized()
    side_ = Vector((0, 1, 0)).cross(up).normalized()  # 耳朵宽的方向
    thin = up.cross(side_).normalized()                # 耳朵薄的方向 (前后)
    m = Matrix((side_, thin * flat, up)).transposed().to_4x4()
    for v in made:
        v.co = base + (m @ (v.co + Vector((0, 0, h / 2))))


def fuse(ob, voxel=0.005, smooth=24, keep=0.16):
    """重叠的几块并成一张连续的皮: 体素重建 → 平滑 (接缝处自然鼓成圆角) → 减面"""
    rm = ob.modifiers.new('remesh', 'REMESH')
    rm.mode = 'VOXEL'
    rm.voxel_size = voxel
    # 体素表面是台阶状的, 光一打就是一格一格的棱 —— 平滑够了才是软胶的面
    sm = ob.modifiers.new('smooth', 'SMOOTH')
    sm.factor = 0.9
    sm.iterations = smooth
    dc = ob.modifiers.new('decimate', 'DECIMATE')
    dc.ratio = keep
    bpy.context.view_layer.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    ob.modifiers.clear()
    old = ob.data
    ob.data = me
    bpy.data.meshes.remove(old)
    me.shade_smooth()
    return ob


def add_ellipsoid(bm, center, radii, seg=32, rings=20):
    made = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1)['verts']
    for v in made:
        v.co = Vector(center) + Vector((v.co.x * radii[0], v.co.y * radii[1], v.co.z * radii[2]))


def toe_creases(ob, center, radii, depth=0.055):
    """爪子前端压出两道趾缝 (只动爪子附近的顶点, 融合后的整张皮也能用)"""
    for v in ob.data.vertices:
        lx, ly, lz = ((v.co[i] - center[i]) / radii[i] for i in range(3))
        if lx * lx + ly * ly + lz * lz > 1.5:
            continue
        front = max(0.0, min(1.0, (-ly - 0.1) / 0.6))
        if front <= 0:
            continue
        k = sum(math.exp(-((lx - s) / 0.11) ** 2) for s in (-0.32, 0.32)) * front * depth
        v.co = Vector(center) + (v.co - Vector(center)) * (1 - k)


def tube(name, pts, r0, r1, mat, ring=14, steps=28):
    """沿一条贝塞尔走的圆管, 末端收成圆头 —— 尾巴"""
    p0, p1, p2, p3 = (Vector(p) for p in pts)

    def at(t):
        return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3

    bm = bmesh.new()
    rings_ = []
    centers = []
    up = Vector((1, 0, 0))
    for i in range(steps + 1):
        t = i / steps
        c = at(t)
        tan = (at(min(1, t + 0.01)) - at(max(0, t - 0.01))).normalized()
        n = tan.cross(up).normalized()
        b = tan.cross(n).normalized()
        r = r0 + (r1 - r0) * t
        if i == steps:
            r *= 0.75
        ring_v = [bm.verts.new(c + (n * math.cos(a) + b * math.sin(a)) * r)
                  for a in (2 * math.pi * k / ring for k in range(ring))]
        rings_.append(ring_v)
        centers.append((c, t))
    for a, b_ in zip(rings_, rings_[1:]):
        for k in range(ring):
            bm.faces.new((a[k], a[(k + 1) % ring], b_[(k + 1) % ring], b_[k]))
    tip = bm.verts.new(at(1) + (at(1) - at(0.97)).normalized() * r1 * 0.45)
    for k in range(ring):
        bm.faces.new((rings_[-1][k], rings_[-1][(k + 1) % ring], tip))
    root = bm.verts.new(at(0) - (at(0.03) - at(0)).normalized() * r0 * 0.5)
    for k in range(ring):
        bm.faces.new((rings_[0][(k + 1) % ring], rings_[0][k], root))
    bm.normal_update()
    ob = new_obj(name, bm, mat, subsurf=1)
    return ob, at


# ───────────────────────── 身体 ─────────────────────────
#   照 2D 头像: 软方块大头 + 头顶两角长出的耳朵, 两只大圆爪搭在下巴底下, 身子几乎藏在头后面

parts = {}  # 部件 → 挂哪根骨头 (整块)
skinned = {}  # 部件 → 按顶点分权重的函数

# 头和两只耳朵并成一张皮 (耳根是圆角过渡, 不是插上去的锥子)
bm = bmesh.new()
superellipsoid(bm, HEAD_C, HEAD_R, HEAD_N)
e = L['ear']
for side in (1, -1):
    base, axis = ear_frame(side)
    add_cone(bm, base, axis, e['r'], e['h'] + e['sink'], e['flat'], tip=e['tip'])
    # 耳尖补一颗小球, 并进去就是圆头 (锥子的平顶平滑不掉)
    tr = e['r'] * e['tip']
    made = bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=tr)['verts']
    tip_c = base + axis * (e['h'] + e['sink'] - tr * 0.3)
    for v in made:
        v.co = tip_c + Vector((v.co.x, v.co.y * e['flat'], v.co.z))
if SPECIES == 'corgi':
    # 口鼻从脸上鼓出来 (并进头里, 不是贴一块)
    MZ = 0.5
    MUZZLE_FRONT = head_front_y(0, MZ) + 0.12 - 0.19
    add_ellipsoid(bm, (0, head_front_y(0, MZ) + 0.12, MZ), (0.30, 0.19, 0.155))
head = fuse(new_obj('head', bm, M['head']))

# 头上的花色画在顶点色里 (柯基的白脑门 / 白下巴), 不再贴凸起的色块
hc = head.data.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
for v in head.data.vertices:
    hc.data[v.index].color = (*L['head_color'](v.co), 1)


def head_weights(v):
    """耳朵那截归耳朵骨头, 根部渐变, 其余归头"""
    for side, tag in ((1, 'L'), (-1, 'R')):
        base, axis = ear_frame(side)
        p = v.co - base
        h = p.dot(axis)
        if (p - axis * h).length < e['r'] * 1.5 and h > -0.02:
            w = max(0.0, min(1.0, (h - e['sink'] * 0.6) / 0.08))
            return {f'ear.{tag}': w, 'head': 1 - w}
    return {'head': 1.0}


skinned[head] = head_weights

for side, tag in ((1, 'L'), (-1, 'R')):
    # 内耳: 贴在耳朵正面的一片浅粉
    base, axis = ear_frame(side)
    bm = bmesh.new()
    front = Vector((0, -1, 0)) - axis * Vector((0, -1, 0)).dot(axis)
    add_cone(bm, base + axis * (e['sink'] + 0.02) + front.normalized() * (e['r'] * e['flat'] * 0.55),
             axis, e['r'] * 0.58, e['h'] * 0.72, e['flat'] * 0.45, tip=0.2)
    inner = new_obj(f'ear.{tag}.inner', bm, M['inner_ear'], subsurf=1)
    parts[inner] = f'ear.{tag}'

    # 眼睛: 小小的黑亮豆子, 偏下、分得开 —— 就是 2D 头像那双
    ex, ez = L['eye_x'] * side, L['eye_z']
    eye = blob(f'eye.{tag}', (ex, head_front_y(ex, ez) + 0.012, ez), (0.04, 0.022, 0.046), M['eye'], seg=24, rings=16, subsurf=0)
    parts[eye] = 'head'

# 身子 + 两条前腿 + 爪子 + 后腿并成一张皮: 前腿从肩膀顺下来, 末端鼓成大圆爪, 不是一颗颗球摆着
PAW_R = (0.118, 0.145, 0.105)


def paw_center(side):
    return Vector((0.165 * side, -0.2, 0.14))


def shoulder(side):
    return Vector((0.14 * side, -0.04, 0.32))


bm = bmesh.new()
add_ellipsoid(bm, (0, 0.07, 0.23), (0.25, 0.23, 0.24))
for side in (1, -1):
    s, p = shoulder(side), paw_center(side)
    for i in range(7):  # 前腿: 一串由粗到略细的球, 融合后就是一根圆润的腿
        t = i / 6
        r = 0.1 - 0.02 * t
        add_ellipsoid(bm, s + (p - s) * t * 0.85, (r, r, r))
    add_ellipsoid(bm, p, PAW_R)
    add_ellipsoid(bm, (0.2 * side, 0.12, 0.11), (0.12, 0.15, 0.115))  # 后腿
body = fuse(new_obj('body', bm, M['body']))
for side in (1, -1):
    toe_creases(body, paw_center(side), PAW_R)


# 身子这张皮用 Blender 的热扩散自动权重 (见蒙皮段): 手算范围总会漏顶点, 抬爪时拉出丝
bc = body.data.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
for v in body.data.vertices:
    bc.data[v.index].color = (*L['body_color'](v.co), 1)

# 胸口的灯: 两只爪子中间一小块, 紫 → 蓝 → 粉
gc, gr = (0, -0.19, 0.15), (0.07, 0.03, 0.055)
glow = blob('chest.glow', gc, gr, M['glow'], seg=24, rings=16, subsurf=0)
col = glow.data.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
stops = [srgb('#9b8cff'), srgb('#8fd3ff'), srgb('#ffb0d8')]
for v in glow.data.vertices:
    t = max(0.0, min(1.0, ((v.co.x - gc[0]) / gr[0] + 1) / 2))
    a, b_, k = (stops[0], stops[1], t * 2) if t < 0.5 else (stops[1], stops[2], t * 2 - 1)
    col.data[v.index].color = (*(a[i] + (b_[i] - a[i]) * k for i in range(3)), 1)
parts[glow] = 'body'

if SPECIES == 'corgi':
    # 柯基: 下半张脸奶白 + 黑鼻头, 额头一道白
    nose = blob('nose', (0, MUZZLE_FRONT + 0.022, MZ + 0.06), (0.05, 0.03, 0.036), M['nose'])
    parts[nose] = 'head'
    mouth_z, mouth_y = MZ - 0.05, MUZZLE_FRONT + 0.05
else:
    mouth_z = L['eye_z'] - 0.09
    mouth_y = head_front_y(0, mouth_z)

# 嘴: 平时整个缩在脸里面看不见 (2D 头像也没有嘴), mouthOpen 往外推出来、张成小椭圆
mouth = blob('mouth', (0, mouth_y + 0.03, mouth_z), (0.032, 0.015, 0.005), M['mouth'], seg=24, rings=12, subsurf=0)
parts[mouth] = 'head'

if L['tail'] == 'cat':
    tail, tail_at = tube('tail', ((0, 0.3, 0.06), (0.08, 0.52, 0.06), (0.18, 0.54, 0.30), (0.13, 0.44, 0.50)), 0.055, 0.04, M['fur'])
    TAIL_BONES = 4
else:
    tail, tail_at = tube('tail', ((0, 0.32, 0.14), (0, 0.40, 0.16), (0, 0.44, 0.21), (0, 0.45, 0.26)), 0.075, 0.06, M['fur'])
    TAIL_BONES = 2


# ───────────────────────── 形变 ─────────────────────────

def shape_key(ob, name, fn):
    if not ob.data.shape_keys:
        ob.shape_key_add(name='Basis')
    k = ob.shape_key_add(name=name)
    k.value = 0  # Blender 5 新加的形变默认是 1, 不归零的话导出后一上来就是闭眼张嘴
    c =sum((v.co for v in ob.data.vertices), Vector()) / len(ob.data.vertices)
    for i, v in enumerate(ob.data.vertices):
        k.data[i].co = fn(v.co, c)


for tag in 'LR':
    shape_key(bpy.data.objects[f'm_eye.{tag}'], 'blink',
              lambda co, c: Vector((co.x, co.y, c.z + (co.z - c.z) * 0.08 + 0.012)))
shape_key(mouth, 'mouthOpen',
          lambda co, c: Vector((c.x + (co.x - c.x) * 1.1, co.y - 0.042, c.z + (co.z - c.z) * 7 - 0.006)))


# ───────────────────────── 骨架 ─────────────────────────

arm_data = bpy.data.armatures.new('rig')
arm = bpy.data.objects.new('rig', arm_data)
scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones


def bone(name, head_, tail_, parent=None):
    b = eb.new(name)
    b.head, b.tail = head_, tail_
    b.roll = 0
    if parent:
        b.parent = eb[parent]
    return b


bone('root', (0, 0, 0), (0, 0, 0.12))
bone('body', (0, 0.1, 0.05), (0, 0.1, 0.32), 'root')
bone('head', (0, 0, 0.32), (0, 0, 0.85), 'body')
for side, tag in ((1, 'L'), (-1, 'R')):
    base, axis = ear_frame(side)
    root_ = base + axis * L['ear']['sink']
    bone(f'ear.{tag}', root_, root_ + axis * L['ear']['h'], 'head')
    # 前爪从肩膀垂下来: 挥手 = 绕肩膀把爪子抬起来
    bone(f'paw.{tag}', shoulder(side), paw_center(side), 'body')
prev = 'root'
for i in range(TAIL_BONES):
    t0, t1 = i / TAIL_BONES, (i + 1) / TAIL_BONES
    name = f'tail.{i + 1}'
    bone(name, tail_at(t0), tail_at(t1), prev)
    eb[name].use_connect = i > 0
    prev = name
bpy.ops.object.mode_set(mode='OBJECT')


# ───────────────────────── 蒙皮 ─────────────────────────

def bind(ob, weights):
    """weights: 骨头名 → (顶点下标 → 权重) 或 1.0 (整块)"""
    for bname, w in weights.items():
        g = ob.vertex_groups.new(name=bname)
        if isinstance(w, float):
            g.add(range(len(ob.data.vertices)), w, 'REPLACE')
        else:
            for vi, wv in w.items():
                if wv > 0:
                    g.add([vi], wv, 'REPLACE')
    ob.parent = arm
    mod = ob.modifiers.new('rig', 'ARMATURE')
    mod.object = arm


for ob, bname in parts.items():
    bind(ob, {bname: 1.0})
for ob in scene.objects:
    ob.select_set(False)
body.select_set(True)
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
_groups = {g.name for g in body.vertex_groups}
print('[build_pet] body auto weights:', sorted(_groups))
assert {'body', 'paw.L', 'paw.R'} <= _groups, '自动权重没算出来 (热扩散失败), 别带着坏蒙皮导出'

for ob, fn in skinned.items():
    ws = {}
    for v in ob.data.vertices:
        for bname, w in fn(v).items():
            ws.setdefault(bname, {})[v.index] = w
    bind(ob, ws)

# 尾巴: 每个顶点找它在曲线上的位置 t, 按 t 在相邻两节骨头之间线性分
samples = [(tail_at(i / 200), i / 200) for i in range(201)]
tail_w = {f'tail.{i + 1}': {} for i in range(TAIL_BONES)}
for v in tail.data.vertices:
    t = min(samples, key=lambda s: (s[0] - v.co).length)[1]
    f = t * TAIL_BONES - 0.5
    i0 = max(0, min(TAIL_BONES - 1, math.floor(f)))
    i1 = min(TAIL_BONES - 1, i0 + 1)
    k = max(0.0, min(1.0, f - i0))
    tail_w[f'tail.{i0 + 1}'][v.index] = tail_w[f'tail.{i0 + 1}'].get(v.index, 0) + (1 - k)
    tail_w[f'tail.{i1 + 1}'][v.index] = tail_w[f'tail.{i1 + 1}'].get(v.index, 0) + k
bind(tail, tail_w)

# 修改器顺序: 先细分再蒙皮 (导出时只烘焙细分, 蒙皮交给 three)
for ob in list(parts) + [tail]:
    ss = ob.modifiers.get('subsurf')
    if ss:
        ob.modifiers.move(ob.modifiers.find('subsurf'), 0)


# ───────────────────────── 动作 ─────────────────────────

FPS = 24
scene.render.fps = FPS
for pb in arm.pose.bones:
    pb.rotation_mode = 'XYZ'


def make_action(name, length, keys):
    """keys: [(帧, 骨头, (rx, ry, rz))] —— 每根出现过的骨头首尾自动补 0, 循环接得上"""
    arm.animation_data_create()
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.rotation_euler = (0, 0, 0)
    touched = {b for _, b, _ in keys}
    for b in touched:
        for f in (1, length + 1):
            arm.pose.bones[b].rotation_euler = (0, 0, 0)
            arm.pose.bones[b].keyframe_insert('rotation_euler', frame=f)
    for f, b, r in keys:
        arm.pose.bones[b].rotation_euler = r
        arm.pose.bones[b].keyframe_insert('rotation_euler', frame=f)
    act = arm.animation_data.action
    act.name = name
    arm.animation_data.action = None
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.name = name
    for pb in arm.pose.bones:
        pb.rotation_euler = (0, 0, 0)
    return act


# 待机 4 秒: 尾巴慢慢摆, 第 2.5 秒左右耳朵抖一下
idle = []
for i in range(TAIL_BONES):
    amp = 0.18 + 0.1 * i if L['tail'] == 'cat' else 0.35
    for f, s in ((25, 1), (73, -1)):
        idle.append((f + i * 3, f'tail.{i + 1}', (0, s * amp, s * amp * 0.5)))
idle += [(58, 'ear.L', (0.25, 0, 0)), (62, 'ear.L', (0, 0, 0)), (65, 'ear.L', (0.15, 0, 0)), (69, 'ear.L', (0, 0, 0))]
make_action('Idle', 96, idle)

# 挥爪 2 秒: 右爪抬到脸旁边, 左右晃三下, 放下
def aim_bone(name, target):
    """搜一组旋转, 让骨头末端 (爪子) 落到 target —— 骨头局部轴朝哪靠猜会猜反, 直接量"""
    pb = arm.pose.bones[name]
    best = None
    steps = [i * 0.1 for i in range(-22, 23)]
    for rx in steps:
        for rz in steps:
            pb.rotation_euler = (rx, 0, rz)
            bpy.context.view_layer.update()
            d = (arm.matrix_world @ pb.tail - Vector(target)).length
            if best is None or d < best[0]:
                best = (d, (rx, 0, rz))
    pb.rotation_euler = (0, 0, 0)
    return best[1]


# 挥爪: 右爪抬到右脸颊外侧 (腿是一张皮, 抬太猛肩膀会扯烂), 左右摆三下
WAVE_UP = aim_bone('paw.R', (-0.36, -0.22, 0.36))
wave = [(10, 'paw.R', WAVE_UP)]
for k, f in enumerate((16, 22, 28, 34)):
    wave.append((f, 'paw.R', (WAVE_UP[0], 0, WAVE_UP[2] + (0.22 if k % 2 == 0 else -0.22))))
wave += [(40, 'paw.R', WAVE_UP)]
# 头不进任何动作: 舞台每帧自己算头 (看鼠标 / 歪头 / 点头), 动作再写头会跟它打架
make_action('Wave', 48, wave)


# ───────────────────────── 导出 ─────────────────────────

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
for ob in scene.objects:
    ob.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    export_apply=True,
    export_yup=True,
    export_skins=True,
    export_morph=True,
    export_animations=True,
    export_animation_mode='NLA_TRACKS',
    export_materials='EXPORT',
    export_vertex_color='MATERIAL',
)
print('[build_pet] wrote', OUT, os.path.getsize(OUT), 'bytes')


# ───────────────────────── 预览 ─────────────────────────
#   正面 / 3/4 / 侧面 / 背面 + 挥爪那一帧, 拼成一张图看

if PREVIEW_DIR:
    import numpy as np

    os.makedirs(PREVIEW_DIR, exist_ok=True)
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.56, 0.6, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.45
    scene.world = world
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-30))
    scene.collection.objects.link(sun)
    rim = bpy.data.objects.new('rim', bpy.data.lights.new('rim', 'SUN'))
    rim.data.energy = 1.2
    rim.rotation_euler = (math.radians(60), 0, math.radians(160))
    scene.collection.objects.link(rim)
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = scene.render.resolution_y = 520
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'Standard'
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.lens = 75
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = Vector((0, 0, 0.5))

    shots = []

    def shot(label, yaw_deg, frame=None, action=None):
        a = math.radians(yaw_deg)
        cam.location = target + Vector((math.sin(a) * 3.4, -math.cos(a) * 3.4, 0.55))
        cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
        for tr in arm.animation_data.nla_tracks:
            tr.mute = tr.name != action
        scene.frame_set(frame or 1)
        path = os.path.join(PREVIEW_DIR, f'{SPECIES}-{label}.png')
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        shots.append(path)

    shot('front', 0)
    shot('34', 35)
    shot('side', 90)
    shot('back', 180)
    shot('wave', 15, frame=22, action='Wave')
    shot('blink', 0, action='__none__')

    # blink 那张: 把形变拉满看闭眼 + 张嘴
    # (上一张已经渲完, 这里补一张单独的)
    for tag in 'LR':
        bpy.data.objects[f'm_eye.{tag}'].data.shape_keys.key_blocks['blink'].value = 1
    mouth.data.shape_keys.key_blocks['mouthOpen'].value = 1
    scene.render.filepath = shots[-1]
    bpy.ops.render.render(write_still=True)

    imgs = [bpy.data.images.load(p) for p in shots]
    w = h = 520
    grid = np.ones((h * 2, w * 3, 4), dtype=np.float32)
    for i, im in enumerate(imgs):
        px = np.empty(w * h * 4, dtype=np.float32)
        im.pixels.foreach_get(px)
        r, c = divmod(i, 3)
        grid[(1 - r) * h:(2 - r) * h, c * w:(c + 1) * w] = px.reshape(h, w, 4)
    sheet = bpy.data.images.new('sheet', w * 3, h * 2)
    sheet.pixels.foreach_set(grid.ravel())
    sheet.filepath_raw = os.path.join(PREVIEW_DIR, f'{SPECIES}-sheet.png')
    sheet.file_format = 'PNG'
    sheet.save()
    print('[build_pet] preview', sheet.filepath_raw)
