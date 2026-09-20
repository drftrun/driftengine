"""MobileSAM, as its upstream runs it, on a pinned real frame with three prompts.

The upstream half of the real model's parity: this loads the fetched checkpoint into the upstream's
own `build_sam_vit_t` at the manifest's pinned revision, strictly, prepares the first pinned frame
the way its predictor does -- the longest side to 1024 through `ResizeLongestSide`, normalised and
padded by `Sam.preprocess` -- and answers three prompts in the predictor's own coordinates: a point
on the building's middle roof, a box around the building, and that point with a second, off the
object, on the water. It writes the prepared image and every answer to `.reference/sam-parity/`,
where `sam_parity.ts` holds the engine's graphs to them, on the CPU and on the device.

    node tools/capture-weights/fetch.mjs mobilesam
    env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/sam_parity.py

The frame is Depth Anything 3's first pinned frame (`inputs.json`), checked by its hash: a real
photograph with one large object in it, which is what a point prompt is for.
"""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from safetensors.torch import save_file

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / ".reference" / "mobilesam"))

from mobile_sam import sam_model_registry  # noqa: E402
from mobile_sam.utils.amg import calculate_stability_score  # noqa: E402
from mobile_sam.utils.transforms import ResizeLongestSide  # noqa: E402

FOLDER = ROOT / ".reference" / "sam-parity"
FOLDER.mkdir(exist_ok=True)
manifest = json.loads((ROOT / "tools" / "capture-weights" / "manifest.json").read_text())
model = next(m for m in manifest["models"] if m["name"] == "mobilesam")
checkpoint = ROOT / "models" / "capture" / model["name"] / Path(model["file"]).name
if hashlib.sha256(checkpoint.read_bytes()).hexdigest() != model["sha256"]:
    raise SystemExit("the checkpoint is not the one the manifest pins; fetch it again")
frame = json.loads((Path(__file__).parent / "inputs.json").read_text())["images"][0]
path = ROOT / ".reference" / "da3-parity" / frame["file"]
if hashlib.sha256(path.read_bytes()).hexdigest() != frame["sha256"]:
    raise SystemExit(f"{path} is not the frame the reference pins")

# Strictly: `build_sam_vit_t` loads with `load_state_dict`'s default, which refuses anything missing
# or left over.
sam = sam_model_registry["vit_t"](checkpoint=str(checkpoint))
sam.eval()

PROMPTS = {
    "point": {"points": [[540, 300, 1]]},
    "box": {"box": [215, 215, 940, 665]},
    "both": {"points": [[540, 300, 1], [1040, 520, 0]], "box": [215, 215, 940, 665]},
}
(FOLDER / "prompts.json").write_text(json.dumps(PROMPTS, indent=2))

image = np.array(Image.open(path).convert("RGB"))
original = image.shape[:2]
transform = ResizeLongestSide(sam.image_encoder.img_size)
prepared = torch.as_tensor(transform.apply_image(image)).permute(2, 0, 1).contiguous()[None]
input_size = tuple(prepared.shape[-2:])
answers = {"original": torch.tensor(original, dtype=torch.float32), "input": torch.tensor(input_size, dtype=torch.float32)}
# The frame as a host hands it to the engine, so the engine's own preparation is held to the
# upstream's without a PNG decoder on its side.
answers["frame.rgba"] = torch.tensor(
    np.concatenate([image, np.full(image.shape[:2] + (1,), 255, dtype=np.uint8)], axis=-1).astype(np.float32)
)
with torch.no_grad():
    normalised = sam.preprocess(prepared.float())
    answers["prepared"] = normalised[0].clone().contiguous()
    answers["image"] = normalised[0].contiguous()
    embedding = sam.image_encoder(normalised)
    answers["embedding"] = embedding[0].contiguous()
    dense = sam.prompt_encoder.get_dense_pe()
    low = {}
    for name, prompt in PROMPTS.items():
        points = None
        if "points" in prompt:
            coords = transform.apply_coords(np.array([p[:2] for p in prompt["points"]], dtype=float), original)
            points = (
                torch.as_tensor(coords, dtype=torch.float)[None],
                torch.as_tensor([p[2] for p in prompt["points"]], dtype=torch.int)[None],
            )
        boxes = None
        if "box" in prompt:
            boxes = torch.as_tensor(transform.apply_boxes(np.array(prompt["box"], dtype=float), original), dtype=torch.float)[None]
        sparse, dense_prompt = sam.prompt_encoder(points=points, boxes=boxes, masks=None)
        masks, quality = sam.mask_decoder.predict_masks(
            image_embeddings=embedding,
            image_pe=dense,
            sparse_prompt_embeddings=sparse,
            dense_prompt_embeddings=dense_prompt,
        )
        low[name] = masks
        upscaled = sam.postprocess_masks(masks, input_size, original)
        answers[f"{name}.tokens"] = sparse[0].contiguous()
        answers[f"{name}.masks"] = masks[0].contiguous()
        answers[f"{name}.quality"] = quality[0].contiguous()
        answers[f"{name}.image"] = upscaled[0].contiguous()
        answers[f"{name}.stability"] = calculate_stability_score(upscaled[0], 0.0, 1.0).contiguous()
        print(f"{name}: quality {quality[0].tolist()}, stability {answers[f'{name}.stability'].tolist()}, "
              f"pixels on {(upscaled[0] > 0).sum(dim=(1, 2)).tolist()}")
    # The point's best mask by predicted quality, given back to be refined, as an interactive loop does.
    best = int(answers["point.quality"].argmax())
    coords = transform.apply_coords(np.array([PROMPTS["point"]["points"][0][:2]], dtype=float), original)
    points = (torch.as_tensor(coords, dtype=torch.float)[None], torch.as_tensor([1], dtype=torch.int)[None])
    sparse, dense_prompt = sam.prompt_encoder(points=points, boxes=None, masks=low["point"][:, best : best + 1])
    masks, quality = sam.mask_decoder.predict_masks(
        image_embeddings=embedding,
        image_pe=dense,
        sparse_prompt_embeddings=sparse,
        dense_prompt_embeddings=dense_prompt,
    )
    answers["refined.from"] = torch.tensor([best], dtype=torch.float32)
    answers["refined.masks"] = masks[0].contiguous()
    answers["refined.quality"] = quality[0].contiguous()
    print(f"refined from mask {best}: quality {quality[0].tolist()}")

save_file(answers, FOLDER / "output.safetensors")
print(f"prepared {original[0]}x{original[1]} at {input_size[0]}x{input_size[1]} in a {sam.image_encoder.img_size} square")
