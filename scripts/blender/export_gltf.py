# Export the open .blend as one .glb, the way `npm run bake` delegates to Blender.
#
# Run inside Blender, never imported by the engine:
#
#   blender --background --factory-startup model.blend --python export_gltf.py -- out.glb
#
# **What this is for.** A .blend stores the scene Blender *evaluates*, not the scene it draws:
# modifiers, geometry nodes, constraints and drivers are recipes, and the mesh they produce is
# never written to the file. The direct reader in packages/assets reads what is stored and
# refuses what has to be evaluated; this is the other half, and it is exact by construction,
# because the evaluation is Blender's own.
#
# **The export is Blender's bundled glTF exporter**, the Khronos glTF-Blender-IO add-on, and this
# file only chooses its settings. It is a command, not an add-on: it registers nothing and adds no
# behaviour to Blender. The direct reader is built to agree with these settings, and
# scripts/fixtures/blend holds the exports that hold it to that.
#
# What it gives up: a material Blender draws through nodes glTF has no word for — a procedural
# texture, a mix of two shaders — comes out as whatever the exporter can say, which is usually its
# base colour. That is the exporter's limit and it is the same limit on both paths.
#
# Licence: Apache-2.0, as the rest of this repository. Driving Blender as a separate process
# creates no derived work of it.

import sys

import bpy


SETTINGS = {
    'export_format': 'GLB',
    # What renders, from the scene that is open, which is what a person means by "the model".
    'use_renderable': True,
    'use_active_scene': True,
    'use_selection': False,
    'use_visible': False,
    # Modifiers applied: the evaluated mesh is the whole reason to come here.
    'export_apply': True,
    'export_yup': True,
    'export_texcoords': True,
    'export_normals': True,
    'export_tangents': False,
    'export_materials': 'EXPORT',
    'export_image_format': 'AUTO',
    # A colour attribute is exported where a material reads it, which is when Blender draws it.
    'export_vertex_color': 'MATERIAL',
    'export_extras': True,
    'export_cameras': False,
    'export_lights': True,
    'export_skins': True,
    'export_morph': True,
    'export_morph_normal': True,
    # Dense shape keys: the engine's glTF reader does not expand sparse accessors.
    'export_try_sparse_sk': False,
    'export_try_omit_sparse_sk': False,
    'export_animations': True,
    'export_attributes': False,
    'export_gpu_instances': False,
    'export_draco_mesh_compression_enable': False,
    'export_meshopt_compression_enable': False,
    'export_use_gltfpack': False,
}


def hide_what_does_not_render():
    """Mark hidden from renders every scene object a render of this view layer would not draw.

    The exporter's own rule is narrower than Blender's: it keeps an object in a collection
    *excluded* from the view layer, and it reads only the collections an object is linked into
    directly, so a child of a collection disabled for rendering is kept too. A render draws
    neither. The direct reader follows the render, and so does this, in memory only: the file on
    disk is never saved.
    """
    rendered = set()

    def walk(layer_collection):
        if layer_collection.exclude or layer_collection.collection.hide_render:
            return
        rendered.update(layer_collection.collection.objects)
        for child in layer_collection.children:
            walk(child)

    walk(bpy.context.view_layer.layer_collection)
    for obj in bpy.context.scene.objects:
        if obj not in rendered:
            obj.hide_render = True


def evaluate_as_render():
    """Give every modifier its render settings, because the exporter evaluates the viewport.

    A modifier switched off for render and on in the viewport would otherwise be applied, and a
    subdivision would be exported at its viewport level rather than the one a render draws. In
    memory only, like the visibility above.
    """
    for obj in bpy.context.scene.objects:
        for modifier in obj.modifiers:
            modifier.show_viewport = modifier.show_render
            if modifier.type in ('SUBSURF', 'MULTIRES') and hasattr(modifier, 'render_levels'):
                modifier.levels = modifier.render_levels
    bpy.context.view_layer.update()


def export(filepath, overrides=None):
    """Export the open file to `filepath`, passing only the settings this exporter knows."""
    hide_what_does_not_render()
    evaluate_as_render()
    known = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    settings = dict(SETTINGS)
    settings.update(overrides or {})
    passed = {key: value for key, value in settings.items() if key in known}
    dropped = sorted(set(settings) - set(passed))
    if dropped:
        print('drift-export: this exporter has no ' + ', '.join(dropped))
    result = bpy.ops.export_scene.gltf(filepath=filepath, **passed)
    if 'FINISHED' not in result:
        raise RuntimeError('drift-export: the glTF exporter did not finish: ' + str(result))


def summary():
    """One line the baker prints, so a person knows what was exported and by what."""
    import addon_utils

    version = 'unknown'
    for module in addon_utils.modules():
        if module.__name__.endswith('io_scene_gltf2'):
            version = '.'.join(str(n) for n in module.bl_info.get('version', ()))
    scene = bpy.context.scene
    return 'drift-export: Blender {}, glTF exporter {}, scene "{}", {} objects'.format(
        bpy.app.version_string, version, scene.name, len(scene.objects)
    )


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if len(argv) != 1:
        raise SystemExit('usage: blender --background file.blend --python export_gltf.py -- out.glb')
    print(summary())
    export(argv[0])
    # Leave without Blender's teardown, which has segfaulted after a finished export (exit 139 on
    # 5.2 with a 13 MB character): the file is written and nothing after this line is wanted.
    import os
    sys.stdout.flush()
    os._exit(0)
