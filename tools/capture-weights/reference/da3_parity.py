"""Depth Anything 3 Small, as its upstream runs it, on two pinned frames of one scene.

The upstream half of the real model's parity: this loads the fetched checkpoint into the upstream's
own network at the manifest's pinned revision, prepares the frames with the upstream's
own input processor at its default 504 pixels, and runs the network in single precision on the
first frame alone and on both together. It writes the prepared images and every answer to
`.reference/da3-parity/`, where `parity.ts` holds the engine's graph to them, on the CPU and on
the device.

    node tools/capture-weights/fetch.mjs depth-anything-3-small
    env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/da3_parity.py

It composes the network's parts as `DepthAnything3Net.forward` does, rather than calling it, so the
camera decoder's raw encoding is kept beside the cameras the upstream decodes from it. The upstream's
API would run under autocast at reduced precision on a GPU; this is the network itself.
"""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from safetensors.torch import load_file, save_file

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / ".reference" / "da3" / "src"))

from depth_anything_3.cfg import create_object, load_config  # noqa: E402
from depth_anything_3.model.utils.transform import pose_encoding_to_extri_intri  # noqa: E402
from depth_anything_3.registry import MODEL_REGISTRY  # noqa: E402
from depth_anything_3.utils.geometry import affine_inverse  # noqa: E402
from depth_anything_3.utils.io.input_processor import InputProcessor  # noqa: E402

FOLDER = ROOT / ".reference" / "da3-parity"
manifest = json.loads((ROOT / "tools" / "capture-weights" / "manifest.json").read_text())
model = next(m for m in manifest["models"] if m["name"] == "depth-anything-3-small")
checkpoint = ROOT / "models" / "capture" / model["name"] / Path(model["file"]).name
if hashlib.sha256(checkpoint.read_bytes()).hexdigest() != model["sha256"]:
    raise SystemExit("the checkpoint is not the one the manifest pins; fetch it again")
inputs = json.loads((Path(__file__).parent / "inputs.json").read_text())
frames = []
for image in inputs["images"]:
    path = FOLDER / image["file"]
    if hashlib.sha256(path.read_bytes()).hexdigest() != image["sha256"]:
        raise SystemExit(f"{path} is not the frame the reference pins")
    frames.append(str(path))

network = create_object(load_config(MODEL_REGISTRY["da3-small"]))
state = {name[len("model.") :]: value for name, value in load_file(checkpoint).items()}
# Not strictly, and not loosely either: the published checkpoint lacks the norms of three levels of
# the ray branch the upstream builds -- a branch whose output it discards, and which the engine sets
# aside -- so exactly those may be missing, and nothing else, and nothing may be left over.
result = network.load_state_dict(state, strict=False)
allowed = {f"head.scratch.output_conv2_aux.{level}.2.{part}" for level in (1, 2, 3) for part in ("weight", "bias")}
if result.unexpected_keys or set(result.missing_keys) - allowed:
    raise SystemExit(f"the checkpoint does not load as the upstream's network: {result}")
network.eval()

images, _, _ = InputProcessor()(frames, None, None, 504, "upper_bound_resize")
images = images.float()
height, width = images.shape[-2:]
answers = {"images": images.contiguous()}
# The frames as a host hands them to the engine -- RGBA bytes -- so the engine's own preparation is
# held to the upstream's above without a PNG decoder on its side.
for index, frame in enumerate(frames):
    rgb = np.array(Image.open(frame).convert("RGB"))
    rgba = np.concatenate([rgb, np.full(rgb.shape[:2] + (1,), 255, dtype=np.uint8)], axis=-1)
    answers[f"frame{index}.rgba"] = torch.tensor(rgba.astype(np.float32))
with torch.no_grad():
    for case, views in (("single", images[:1]), ("pair", images)):
        x = views[None]
        features, _ = network.backbone(x, cam_token=None, export_feat_layers=[])
        head = network.head(features, height, width, patch_start_idx=0)
        pose = network.cam_dec(features[-1][1])
        camera_to_world, intrinsics = pose_encoding_to_extri_intri(pose, (height, width))
        answers[f"{case}.depth"] = head["depth"][0].contiguous()
        answers[f"{case}.confidence"] = head["depth_conf"][0].contiguous()
        answers[f"{case}.pose"] = pose[0].contiguous()
        answers[f"{case}.extrinsics"] = affine_inverse(camera_to_world)[0].contiguous()
        answers[f"{case}.intrinsics"] = intrinsics[0].contiguous()

save_file(answers, FOLDER / "output.safetensors")
print(json.dumps({"size": [int(height), int(width)], "pose": answers["pair.pose"].flatten().tolist()}))
