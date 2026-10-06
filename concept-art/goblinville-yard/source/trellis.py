"""Image to textured 3D model with TRELLIS.2 on the local image studio's ComfyUI.

  python trellis.py IMAGE OUT.glb [--seed N] [--faces N] [--texture N]

The graph is ComfyUI's TRELLIS.2 template (structure, shape, upsample (1536 voxels by default) and
texture stages with its CFG schedule), remeshed, decimated to --faces, unwrapped
and baked at --texture: base colour, metallic and roughness from the texture
voxels, and normal and ambient occlusion from the full-detail remesh.
Background removal is BiRefNet (MIT), or a given mask.
"""
import argparse, json, shutil, time, urllib.error, urllib.request, uuid
from pathlib import Path

HOST = 'http://127.0.0.1:8188'
OUTPUTS = Path('D:/local-image-studio/outputs')
# A clear 16 GB card takes about three minutes; far longer means it is swapping.
TIMEOUT = 600

def graph(image, seed, faces, texture, mask=None, resolution=1536, background='#000000', remesh=768):
    g = {}
    def node(cls, **inputs):
        key = str(len(g) + 1)
        g[key] = {'class_type': cls, 'inputs': inputs}
        return key
    out = lambda key, slot=0: [key, slot]
    load = node('LoadImage', image=image)
    if mask:
        cut = node('ImageToMask', image=out(node('LoadImage', image=mask)), channel='red')
    else:
        bg = node('LoadBackgroundRemovalModel', bg_removal_name='birefnet.safetensors')
        cut = node('RemoveBackground', bg_removal_model=out(bg), image=out(load))
    crop = node('ImageCropToMask', images=out(load), masks=out(cut), width=1024, height=1024,
                pad_factor=1.1, grow_mask=0, background=background)
    clip = node('CLIPVisionLoader', clip_name='dino_v3_vit_l.safetensors')
    cond = node('Trellis2Conditioning', clip_vision_model=out(clip), image=out(crop))
    unet = node('UNETLoader', unet_name='trellis_2_int8_convrot.safetensors', weight_dtype='default')
    shape_vae = node('VAELoader', vae_name='trellis_2_shape_vae_bf16.safetensors')
    tex_vae = node('VAELoader', vae_name='trellis_2_texture_vae_bf16.safetensors')
    # The template's CFG schedule matches the reference pipeline.
    s_model = node('ModelSamplingSD3', model=out(node('RescaleCFG', model=out(node('CFGOverride', model=out(unet), cfg=1, start_percent=.667, end_percent=1)), multiplier=.7)), shift=5)
    shape_model = node('RescaleCFG', model=out(node('CFGOverride', model=out(unet), cfg=1, start_percent=.769, end_percent=1)), multiplier=.5)
    def sample(model, stage, steps, cfg, scheduler, offset):
        return node('KSampler', model=out(model), positive=out(stage, 0), negative=out(stage, 1), latent_image=out(stage, 2),
                    seed=seed + offset, steps=steps, cfg=cfg, sampler_name='euler', scheduler=scheduler, denoise=1)
    empty = node('EmptyTrellis2LatentStructure', batch_size=1)
    structure = node('KSampler', model=out(s_model), positive=out(cond, 0), negative=out(cond, 1), latent_image=out(empty),
                     seed=seed, steps=12, cfg=7.5, sampler_name='euler', scheduler='normal', denoise=1)
    voxel = node('VaeDecodeStructureTrellis2', samples=out(structure), vae=out(shape_vae), resolution='32')
    shape_stage = node('Trellis2ShapeStage', positive=out(cond, 0), negative=out(cond, 1), voxel=out(voxel))
    shape = sample(shape_model, shape_stage, 20, 7.5, 'normal', 1)
    if resolution > 512:
        up_stage = node('Trellis2UpsampleStage', positive=out(shape_stage, 0), negative=out(shape_stage, 1),
                        shape_latent=out(shape), vae=out(shape_vae), target_resolution=resolution)
        upsampled = sample(shape_model, up_stage, 12, 7.5, 'simple', 2)
    else:  # small subjects: the 512 shape, with no upsample
        up_stage, upsampled = shape_stage, shape
    decoded = node('VaeDecodeShapeTrellis', samples=out(upsampled), vae=out(shape_vae))
    tex_stage = node('Trellis2TextureStage', positive=out(up_stage, 0), negative=out(up_stage, 1), shape_latent=out(upsampled))
    colors = node('VaeDecodeTextureTrellis', samples=out(sample(unet, tex_stage, 12, 1, 'normal', 3)), vae=out(tex_vae),
                  shape_subdivides=out(decoded, 1))
    remeshed = node('RemeshMesh', mesh=out(decoded), resolution=remesh, sign_mode='udf', **{'sign_mode.qef': False,
                  'sign_mode.drop_inverted_components': False, 'sign_mode.drop_enclosed_components': False},
                  band=1, project_back=0, fix_poles=False, smooth_iters=20, drop_small_components=.01,
                  precluster_max_verts=20000000)
    low = node('DecimateMesh', mesh=out(remeshed), target_face_count=faces, placement_mode='midpoint')
    low = node('MeshSmoothNormals', mesh=out(low), crease_angle=180)
    low = node('UnwrapMesh', mesh=out(low), segmenter='pec', resolution=texture, padding=2, weld_distance=.0002)
    baked = node('BakeTextureFromVoxel', mesh=out(low), voxel_colors=out(colors), texture_size=texture, reference_mesh=out(decoded))
    ao = node('BakeAmbientOcclusion', low_poly=out(low), high_poly=out(remeshed), resolution=texture // 2, samples=64,
              max_distance=.71, strength=1, bias=.01)
    normal = node('BakeNormalMapFromMesh', low_poly=out(low), high_poly=out(remeshed), resolution=texture, cage_distance=.05,
                  ignore_backfaces=True)
    final = node('ApplyTextureToMesh', mesh=out(low), base_color=out(baked, 0), metallic=out(baked, 1), roughness=out(baked, 2),
                 occlusion=out(ao), normal_map=out(normal))
    final = node('MeshSmoothNormals', mesh=out(final), crease_angle=180)
    prefix = 'goblinville-yard/' + uuid.uuid4().hex[:8]
    node('SaveGLB', mesh=out(final), filename_prefix=prefix)
    return g, prefix

def upload(path):
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{path.name}"\r\n'
            'Content-Type: image/png\r\n\r\n').encode() + path.read_bytes() + \
           f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request(HOST + '/upload/image', data=body,
                                 headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())['name']

def free():
    """Unload every model first: the 1536 upsample needs nearly all of a 16 GB card,
    and anything left resident spills it into much slower shared memory."""
    body = json.dumps({'unload_models': True, 'free_memory': True}).encode()
    urllib.request.urlopen(urllib.request.Request(HOST + '/free', data=body, headers={'Content-Type': 'application/json'}))
    time.sleep(2)

def cancel(prompt_id):
    """Take this job off the GPU: drop it from the queue, or stop it if running."""
    try:
        post = lambda path, body: urllib.request.urlopen(urllib.request.Request(
            HOST + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}))
        post('/queue', {'delete': [prompt_id]})
        with urllib.request.urlopen(HOST + '/queue') as r:
            if any(q[1] == prompt_id for q in json.loads(r.read())['queue_running']):
                post('/interrupt', {'prompt_id': prompt_id})
    except OSError:
        pass

def run(image, out, seed=42, faces=60000, texture=2048, mask=None, resolution=1536, background='#000000', remesh=768):
    free()
    name = upload(Path(image))
    g, prefix = graph(name, seed, faces, texture, mask and upload(Path(mask)), resolution, background, remesh)
    body = json.dumps({'prompt': g, 'client_id': 'goblinville-yard'}).encode()
    req = urllib.request.Request(HOST + '/prompt', data=body, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            prompt_id = json.loads(r.read())['prompt_id']
    except urllib.error.HTTPError as e:
        raise SystemExit(e.read().decode())
    start = time.time()
    try:
        while True:
            with urllib.request.urlopen(f'{HOST}/history/{prompt_id}') as r:
                history = json.loads(r.read()).get(prompt_id)
            if history and history.get('status', {}).get('completed'):
                break
            if history and history.get('status', {}).get('status_str') == 'error':
                raise SystemExit(json.dumps(history['status'], indent=1)[:4000])
            if time.time() - start > TIMEOUT:
                raise SystemExit(f'TRELLIS.2 took over {TIMEOUT}s on {image}; cancelled')
            time.sleep(3)
    except BaseException:
        cancel(prompt_id)
        raise
    finally:
        free()
    files = sorted((OUTPUTS / prefix).parent.glob(Path(prefix).name + '*.glb'))
    if not files:
        raise SystemExit('No GLB written for ' + prefix)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(files[-1], out)
    print('TRELLIS', out, f'{time.time() - start:.0f}s', flush=True)

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('image'); p.add_argument('out')
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--faces', type=int, default=60000)
    p.add_argument('--texture', type=int, default=2048)
    p.add_argument('--mask', help='cut-out mask (white subject) instead of BiRefNet')
    p.add_argument('--resolution', type=int, default=1536, help='shape voxels: 512 (no upsample), 1024 or 1536')
    p.add_argument('--background', default='#000000', help='colour behind the cut-out subject')
    p.add_argument('--remesh', type=int, default=768, help='remesh voxel resolution')
    a = p.parse_args()
    run(a.image, a.out, a.seed, a.faces, a.texture, a.mask, a.resolution, a.background, a.remesh)
