# 生成 Blender 测试工程：默认场景（相机 + 灯光保留）中放一只 Suzanne，
# 引擎强制 Cycles CPU（无头渲染的安全底线），输出路径由环境变量 BLEND_OUT 指定。
import bpy
import os

for o in list(bpy.data.objects):
    if o.type == 'MESH':
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.mesh.primitive_monkey_add(location=(0, 0, 1))

scene = bpy.context.scene
scene.render.resolution_x = 480
scene.render.resolution_y = 270
scene.render.engine = 'CYCLES'
if hasattr(scene, 'cycles'):
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 16

bpy.ops.wm.save_as_mainfile(filepath=os.environ['BLEND_OUT'])
print('saved: ' + os.environ['BLEND_OUT'])
