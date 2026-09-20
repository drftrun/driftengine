"""The upstream's own code, run on the seeded miniature of Depth Anything 3.

The other half of the oracle the model's tests are held to: `miniature.ts` writes the checkpoint
and inputs, and this loads them into the upstream's modules at the manifest's pinned revision --
strictly, so a tensor whose name or shape differs from the upstream's fails here, before any number
is compared -- runs them in single precision, and writes and prints what they answer.

    env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/da3_miniature.py

It composes the three modules as the upstream's `DepthAnything3Net.forward` does -- backbone, head
at patch start 0, camera decoder on the last tap's camera token -- because that class also builds a
camera encoder the miniature has no weights for and never runs.
"""

import json
import sys
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / ".reference" / "da3" / "src"))

from depth_anything_3.model.cam_dec import CameraDec  # noqa: E402
from depth_anything_3.model.dinov2.vision_transformer import DinoVisionTransformer  # noqa: E402
from depth_anything_3.model.dualdpt import DualDPT  # noqa: E402

FOLDER = ROOT / ".reference" / "da3-miniature"
weights = load_file(FOLDER / "checkpoint.safetensors")


def part(prefix):
    return {name[len(prefix) :]: value for name, value in weights.items() if name.startswith(prefix)}


# MINIATURE_DEPTH_ANYTHING_3, in the upstream's terms.
backbone = DinoVisionTransformer(
    img_size=28,
    patch_size=14,
    embed_dim=32,
    depth=4,
    num_heads=4,
    mlp_ratio=4,
    alt_start=2,
    qknorm_start=2,
    rope_start=2,
    rope_freq=100,
    cat_token=True,
)
head = DualDPT(dim_in=64, output_dim=2, features=16, out_channels=[4, 8, 8, 16])
camera = CameraDec(dim_in=64)
backbone.load_state_dict(part("model.backbone.pretrained."), strict=True)
head.load_state_dict(part("model.head."), strict=True)
camera.load_state_dict(part("model.cam_dec."), strict=True)
for module in (backbone, head, camera):
    module.eval()

inputs = load_file(FOLDER / "input.safetensors")
answers = {}
with torch.no_grad():
    for case, images in inputs.items():
        features, _ = backbone.get_intermediate_layers(images, [0, 1, 2, 3])
        height, width = images.shape[-2:]
        result = head(features, height, width, patch_start_idx=0)
        answers[f"{case}.depth"] = result["depth"][0].contiguous()
        answers[f"{case}.confidence"] = result["depth_conf"][0].contiguous()
        answers[f"{case}.pose"] = camera(features[-1][1])[0].contiguous()

save_file(answers, FOLDER / "output.safetensors")
print(json.dumps({name: value.flatten().tolist()[:6] for name, value in answers.items()}, indent=1))
