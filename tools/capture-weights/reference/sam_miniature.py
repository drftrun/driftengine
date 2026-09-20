"""MobileSAM's own code, run on its seeded miniature.

The other half of the oracle `samMiniature.ts` is held to: `miniature.ts` writes the checkpoint, the
image and the prompts to `.reference/sam-miniature/`, and this builds the upstream's modules at the
miniature's sizes, from the code at the manifest's pinned revision, loads the checkpoint into them
strictly, and prints what they answer — and writes all of it to `output.safetensors`, for the
tolerance to be measured over whole outputs rather than the few values a test asserts.

**One line of the upstream is restated rather than called**: `TinyViT.forward_features` views its
last stage's tokens as a 64 by 64 grid, which is 1024/16 written as a literal, so a 64-pixel image
cannot pass through it. The five lines that follow the stages are repeated here with the grid the
image has, and every module they call is the upstream's.

    env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/sam_miniature.py
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import load_file, save_file

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / ".reference" / "mobilesam"))

from mobile_sam.modeling import MaskDecoder, PromptEncoder, Sam, TinyViT, TwoWayTransformer  # noqa: E402
from mobile_sam.utils.amg import calculate_stability_score  # noqa: E402
from mobile_sam.utils.transforms import ResizeLongestSide  # noqa: E402

FOLDER = ROOT / ".reference" / "sam-miniature"
SIZE = 64
GRID = SIZE // 16

# MINIATURE_MOBILE_SAM, in the upstream's terms.
sam = Sam(
    image_encoder=TinyViT(
        img_size=SIZE,
        in_chans=3,
        num_classes=10,
        embed_dims=[8, 16, 24, 320],
        depths=[1, 2, 1, 1],
        num_heads=[1, 2, 3, 10],
        window_sizes=[7, 3, 4, 2],
        mlp_ratio=4.0,
        drop_rate=0.0,
        drop_path_rate=0.0,
        use_checkpoint=False,
        mbconv_expand_ratio=4.0,
        local_conv_size=3,
        layer_lr_decay=0.8,
    ),
    prompt_encoder=PromptEncoder(
        embed_dim=256,
        image_embedding_size=(GRID, GRID),
        input_image_size=(SIZE, SIZE),
        mask_in_chans=16,
    ),
    mask_decoder=MaskDecoder(
        num_multimask_outputs=3,
        transformer=TwoWayTransformer(depth=2, embedding_dim=256, mlp_dim=32, num_heads=8),
        transformer_dim=256,
        iou_head_depth=3,
        iou_head_hidden_dim=16,
    ),
)
state = load_file(FOLDER / "checkpoint.safetensors")
for name in state:
    if name.endswith("num_batches_tracked"):
        state[name] = state[name].long()
sam.load_state_dict(state, strict=True)
sam.eval()

setup = json.loads((FOLDER / "prompts.json").read_text())
original = (setup["image"]["height"], setup["image"]["width"])
transform = ResizeLongestSide(SIZE)
input_size = transform.get_preprocess_shape(*original, SIZE)
image = load_file(FOLDER / "input.safetensors")["image"]

np.set_printoptions(precision=9, suppress=False, linewidth=120)


def show(label, tensor, picks):
    flat = tensor.reshape(-1)
    print(f"{label}: " + ", ".join(f"[{i}, {flat[i].item()!r}]" for i in picks))


with torch.no_grad():
    encoder = sam.image_encoder
    x = encoder.patch_embed(image)
    for layer in encoder.layers:
        x = layer(x)
    batch, _, channels = x.size()
    x = x.view(batch, GRID, GRID, channels).permute(0, 3, 1, 2)
    embedding = encoder.neck(x)
    show("embedding", embedding, [0, 1, 17, 255, 1000, 2049, 4095])

    dense = sam.prompt_encoder.get_dense_pe()
    show("grid positions [channel · 16 + cell]", dense, [0, 5, 127 * 16 + 3, 128 * 16 + 9, 255 * 16 + 15])

    results = {}
    saved = {"embedding": embedding, "grid": dense}
    for name, prompt in setup["prompts"].items():
        points = None
        if "points" in prompt:
            coords = transform.apply_coords(np.array([p[:2] for p in prompt["points"]], dtype=float), original)
            points = (
                torch.as_tensor(coords, dtype=torch.float)[None],
                torch.as_tensor([p[2] for p in prompt["points"]], dtype=torch.int)[None],
            )
        boxes = None
        if "box" in prompt:
            box = transform.apply_boxes(np.array(prompt["box"], dtype=float), original)
            boxes = torch.as_tensor(box, dtype=torch.float)[None]
        sparse, dense_prompt = sam.prompt_encoder(points=points, boxes=boxes, masks=None)
        print(f"\n{name}: {sparse.shape[1]} tokens")
        show(f"{name} tokens [token · 256 + channel]", sparse, [0, 3, 127, 128, 255, sparse.shape[1] * 256 - 1, 256 + 200])
        masks, quality = sam.mask_decoder.predict_masks(
            image_embeddings=embedding,
            image_pe=dense,
            sparse_prompt_embeddings=sparse,
            dense_prompt_embeddings=dense_prompt,
        )
        results[name] = masks
        print(f"{name} quality: {quality[0].tolist()!r}")
        show(f"{name} masks [mask · 256 + pixel]", masks, [0, 37, 255, 256 + 100, 512 + 17, 768 + 255])
        upscaled = sam.postprocess_masks(masks, input_size, original)
        show(f"{name} at the image [mask · 1728 + pixel]", upscaled, [0, 500, 1727, 1728 + 900, 3 * 1728 + 1200])
        print(f"{name} stability: {calculate_stability_score(upscaled[0], 0.0, 1.0).tolist()!r}")
        saved.update({f"{name}.tokens": sparse, f"{name}.masks": masks, f"{name}.quality": quality, f"{name}.image": upscaled})

    # The point's first mask, refined: its own low-resolution logits given back as the mask input.
    refine = results["point"][:, :1]
    coords = transform.apply_coords(np.array([p[:2] for p in setup["prompts"]["point"]["points"]], dtype=float), original)
    points = (torch.as_tensor(coords, dtype=torch.float)[None], torch.as_tensor([1], dtype=torch.int)[None])
    sparse, dense_prompt = sam.prompt_encoder(points=points, boxes=None, masks=refine)
    masks, quality = sam.mask_decoder.predict_masks(
        image_embeddings=embedding,
        image_pe=dense,
        sparse_prompt_embeddings=sparse,
        dense_prompt_embeddings=dense_prompt,
    )
    print(f"\nrefined quality: {quality[0].tolist()!r}")
    show("refined masks [mask · 256 + pixel]", masks, [0, 37, 255, 256 + 100, 512 + 17, 768 + 255])
    saved.update({"refined.masks": masks, "refined.quality": quality})
    save_file({name: tensor.contiguous() for name, tensor in saved.items()}, FOLDER / "output.safetensors")
