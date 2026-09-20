"""Transformers' own code, run on the seeded miniature of Depth Anything V2.

The V2 half of the oracle: `miniature.ts` writes `checkpoint2.safetensors` in the older names the
published checkpoint keeps, and this loads it the way the published one is loaded -- through
`from_pretrained`, which renames those names as it reads them -- at the Transformers revision the
manifest pins, then refuses the run if any tensor is missing, unexpected or mismatched, before a
number is compared. It answers for the single case, one view on a grid its positions are resized to.

    env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/da2_miniature.py
"""

import json
import shutil
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file
from transformers import DepthAnythingConfig, DepthAnythingForDepthEstimation, Dinov2Config

ROOT = Path(__file__).resolve().parents[3]
FOLDER = ROOT / ".reference" / "da3-miniature"
MODEL = FOLDER / "da2"
MODEL.mkdir(exist_ok=True)

# MINIATURE_DEPTH_ANYTHING_2, in Transformers' terms: every block tapped, through the last norm.
backbone = Dinov2Config(
    hidden_size=32,
    num_hidden_layers=4,
    num_attention_heads=4,
    mlp_ratio=4,
    image_size=28,
    patch_size=14,
    out_indices=[1, 2, 3, 4],
    reshape_hidden_states=False,
    apply_layernorm=True,
    layer_norm_eps=1e-6,
)
config = DepthAnythingConfig(
    backbone_config=backbone,
    patch_size=14,
    reassemble_hidden_size=32,
    reassemble_factors=[4, 2, 1, 0.5],
    neck_hidden_sizes=[4, 8, 8, 16],
    fusion_hidden_size=16,
    head_hidden_size=8,
    head_in_index=-1,
    depth_estimation_type="relative",
    max_depth=1,
)
config.save_pretrained(MODEL)
shutil.copy(FOLDER / "checkpoint2.safetensors", MODEL / "model.safetensors")
model, info = DepthAnythingForDepthEstimation.from_pretrained(MODEL, output_loading_info=True)
problems = {key: value for key, value in info.items() if value}
if problems:
    raise SystemExit(f"the miniature does not load as the upstream's layout: {problems}")
model.eval()

image = load_file(FOLDER / "input.safetensors")["single"][0]  # [1, 3, H, W]
with torch.no_grad():
    depth = model(pixel_values=image).predicted_depth.contiguous()
save_file({"single.depth": depth}, FOLDER / "output2.safetensors")
print(json.dumps({"single.depth": depth.flatten().tolist()[:6]}, indent=1))
