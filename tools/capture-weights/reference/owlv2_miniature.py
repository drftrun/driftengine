"""Transformers' own OWLv2, run on the seeded miniature of its layout.

The other half of the oracle `owlv2Miniature.ts` is held to: `miniature.ts` writes the checkpoint,
an image and three queries as token ids to `.reference/owlv2-miniature/`, and this builds the
upstream's detector at the miniature's sizes, at the Transformers revision the manifest pins, loads
the checkpoint through `from_pretrained` -- refusing the run if any tensor is missing, unexpected
or mismatched -- and writes what the model answers to `output.safetensors`, for the tolerance to be
measured over whole outputs, and prints the values a test asserts.

    env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/owlv2_miniature.py
"""

import json
import shutil
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file
from transformers import Owlv2Config, Owlv2ForObjectDetection, Owlv2ImageProcessor

ROOT = Path(__file__).resolve().parents[3]
FOLDER = ROOT / ".reference" / "owlv2-miniature"
MODEL = FOLDER / "model"
MODEL.mkdir(exist_ok=True)

# MINIATURE_OWLV2, in Transformers' terms.
config = Owlv2Config(
    text_config=dict(
        vocab_size=517, hidden_size=24, intermediate_size=40, num_hidden_layers=2, num_attention_heads=2,
        max_position_embeddings=16, hidden_act="quick_gelu", layer_norm_eps=1e-5,
    ),
    vision_config=dict(
        hidden_size=32, intermediate_size=48, num_hidden_layers=2, num_attention_heads=2, num_channels=3,
        image_size=64, patch_size=16, hidden_act="quick_gelu", layer_norm_eps=1e-5,
    ),
    projection_dim=24,
)
config.save_pretrained(MODEL)
shutil.copy(FOLDER / "checkpoint.safetensors", MODEL / "model.safetensors")
model, info = Owlv2ForObjectDetection.from_pretrained(MODEL, output_loading_info=True)
problems = {key: value for key, value in info.items() if value}
if problems:
    raise SystemExit(f"the miniature does not load as the upstream's layout: {problems}")
model.eval()

image = load_file(FOLDER / "input.safetensors")["image"]
setup = json.loads((FOLDER / "queries.json").read_text())
ids = torch.zeros(len(setup["queries"]), 16, dtype=torch.long)
mask = torch.zeros_like(ids)
for q, query in enumerate(setup["queries"]):
    ids[q, : len(query)] = torch.tensor(query)
    mask[q, : len(query)] = 1

# What the engine's graphs answer, before the host joins them: taken where the upstream computes it.
captured = {}


def keep(name):
    def hook(_module, _inputs, output):
        captured[name] = output.detach().clone()

    return hook


model.class_head.dense0.register_forward_hook(keep("classes"))
model.class_head.logit_shift.register_forward_hook(keep("shift"))
model.class_head.logit_scale.register_forward_hook(keep("scale"))
model.owlv2.text_projection.register_forward_hook(keep("queries"))


def show(label, tensor, picks):
    flat = tensor.reshape(-1)
    print(f"{label}: " + ", ".join(f"[{i}, {flat[i].item()!r}]" for i in picks))


with torch.no_grad():
    out = model(input_ids=ids, pixel_values=image, attention_mask=mask)

saved = {
    "classes": captured["classes"][0].contiguous(),
    "shift": captured["shift"][0].contiguous(),
    "scale": captured["scale"][0].contiguous(),
    "boxes": out.pred_boxes[0].contiguous(),
    "objectness": out.objectness_logits[0].contiguous(),
    "queries": captured["queries"].contiguous(),
    "logits": out.logits[0].contiguous(),
    "box_bias": model.box_bias.contiguous(),
}
show("box bias [cell · 4 + axis]", saved["box_bias"], [0, 1, 2, 3, 13, 38, 63])
show("classes [cell · 24 + channel]", saved["classes"], [0, 7, 23, 24 * 9 + 4, 383])
show("shift", saved["shift"], [0, 5, 15])
show("scale", saved["scale"], [0, 5, 15])
show("boxes [cell · 4 + axis]", saved["boxes"], [0, 1, 2, 3, 26, 63])
show("objectness", saved["objectness"], [0, 6, 15])
show("queries [query · 24 + channel]", saved["queries"], [0, 13, 24 + 5, 48 + 19, 71])
show("logits [cell · 3 + query]", saved["logits"], [0, 1, 2, 3 * 7 + 1, 47])

height, width = setup["image"]["height"], setup["image"]["width"]
processor = Owlv2ImageProcessor()
for threshold in (0.3,):
    found = processor.post_process_object_detection(out, threshold=threshold, target_sizes=[(height, width)])[0]
    print(f"\ndetections above {threshold}: {len(found['scores'])}")
    for score, label, box in zip(found["scores"], found["labels"], found["boxes"]):
        print(f"  label {label.item()}, score {score.item()!r}, box {[b.item() for b in box]!r}")
    saved["detections.scores"] = found["scores"].contiguous()
    saved["detections.labels"] = found["labels"].to(torch.float32).contiguous()
    saved["detections.boxes"] = found["boxes"].contiguous()

save_file(saved, FOLDER / "output.safetensors")
print(f"\nwrote {FOLDER / 'output.safetensors'}")
