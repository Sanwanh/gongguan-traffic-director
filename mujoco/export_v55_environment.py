"""Run in factory-startup Blender with the V55 release open; never saves the blend.
Usage: blender -b --factory-startup V55.blend --python this_script
The V54 environment supplies the compatible static-object allowlist. Live
signal aspects and actors stay separate and are not duplicated in this export.
"""
import bpy, json, struct, hashlib
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
baseline = ROOT / 'viewer/models/gongguan_v54_environment.glb'
b = baseline.read_bytes()
j = json.loads(b[20:20 + struct.unpack_from('<I', b, 12)[0]])
names = {n.get('name') for n in j['nodes']}
selected = []
for o in list(bpy.context.scene.objects):
    new = any(c.name.startswith('V55 |') for c in o.users_collection)
    if (o.name in names or new) and not o.hide_render and o.type in {'MESH', 'CURVE', 'FONT', 'SURFACE'}:
        selected.append(o)
    else:
        bpy.data.objects.remove(o, do_unlink=True)
# Web GLTF supports image textures and Principled factors, not Cycles noise
# networks. Preserve base factors and image links, dropping only unsupported
# procedural links. The source scene stays unchanged on disk.
procedural = []
for m in bpy.data.materials:
    if not m.node_tree: continue
    for n in m.node_tree.nodes:
        if n.type != 'BSDF_PRINCIPLED': continue
        for key in ('Base Color', 'Roughness', 'Normal'):
            socket = n.inputs.get(key)
            if not socket: continue
            for link in list(socket.links):
                if link.from_node.type not in {'TEX_IMAGE', 'NORMAL_MAP'}:
                    procedural.append(m.name + ':' + key)
                    m.node_tree.links.remove(link)
for o in selected:
    o.hide_set(False)
    o.hide_viewport = False
    o.select_set(True)
# Explicit conversion retains text and curve details in the web asset.
bpy.context.view_layer.objects.active = selected[0]
bpy.ops.object.convert(target='MESH')
out = ROOT / 'viewer/models/gongguan_v55_environment.glb'
bpy.ops.export_scene.gltf(filepath=str(out), export_format='GLB', use_selection=True,
    export_apply=True, export_yup=True, export_animations=False, export_cameras=False,
    export_lights=False, export_extras=False, export_image_format='AUTO',
    export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
report = {'source_release':'https://github.com/Sanwanh/Gongguan-Blender-Scene/releases/tag/v55-video-realism-20260907',
    'source_sha256':hashlib.sha256(Path(bpy.data.filepath).read_bytes()).hexdigest(),
    'environment_sha256':hashlib.sha256(out.read_bytes()).hexdigest(),
    'selected_objects':len(selected), 'procedural_factor_fallbacks':len(procedural),
    'notes':'V55 static scene; original V54 live signals and KBot retained. Cycles procedural microtextures use Principled factors in GLTF; packed facade image textures retained.'}
(ROOT / 'viewer/models/v55_export.json').write_text(json.dumps(report,indent=2)+'\n')
print('V55_EXPORT',json.dumps(report),flush=True)
