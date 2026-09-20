"""SAM 2.1 tiny, as its upstream runs it, tracking two objects through two pinned real frames.

The upstream half of the real model's parity: this loads the fetched checkpoint into Transformers'
`Sam2VideoModel` at the manifest's pinned revision, refusing anything missing or left over, opens a
video session with the upstream's own processor -- each frame resized to 1024 square and normalised
by ImageNet's statistics -- prompts a point on the building's middle roof and a box around the
building on the first frame, and tracks both into the second. It writes the prepared frames and
every answer to `.reference/sam21-parity/`, where `sam21_parity.ts` holds the engine's tracker to
them, on the CPU and on the device.

    node tools/capture-weights/fetch.mjs sam-2.1-tiny
    env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/sam21_parity.py

The frames are Depth Anything 3's two pinned frames of one scene (`inputs.json`), checked by their
hashes. The model folder is the fetched checkpoint beside the configuration and processor files at
the same revision, under `.reference/sam2/model/`.
"""

import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from safetensors.torch import save_file
from transformers import Sam2VideoModel, Sam2VideoProcessor

ROOT = Path(__file__).resolve().parents[3]
FOLDER = ROOT / ".reference" / "sam21-parity"
FOLDER.mkdir(exist_ok=True)
MODEL = ROOT / ".reference" / "sam2" / "model"
manifest = json.loads((ROOT / "tools" / "capture-weights" / "manifest.json").read_text())
entry = next(m for m in manifest["models"] if m["name"] == "sam-2.1-tiny")
if hashlib.sha256((MODEL / "model.safetensors").read_bytes()).hexdigest() != entry["sha256"]:
    raise SystemExit("the checkpoint is not the one the manifest pins; fetch it again")
frames = []
for image in json.loads((Path(__file__).parent / "inputs.json").read_text())["images"]:
    path = ROOT / ".reference" / "da3-parity" / image["file"]
    if hashlib.sha256(path.read_bytes()).hexdigest() != image["sha256"]:
        raise SystemExit(f"{path} is not the frame the reference pins")
    frames.append(np.array(Image.open(path).convert("RGB")))

model, info = Sam2VideoModel.from_pretrained(MODEL, output_loading_info=True)
problems = {key: value for key, value in info.items() if value}
if problems:
    raise SystemExit(f"the checkpoint does not load as the upstream's model: {problems}")
model.eval()
processor = Sam2VideoProcessor.from_pretrained(MODEL)

PROMPTS = {"1": {"points": [[540, 300, 1]]}, "2": {"box": [215, 215, 940, 665]}}
(FOLDER / "prompts.json").write_text(json.dumps(PROMPTS, indent=2))

with torch.inference_mode():
    session = processor.init_video_session(video=frames, inference_device="cpu", dtype=torch.float32)
    processor.add_inputs_to_inference_session(
        session, frame_idx=0, obj_ids=[1], input_points=[[[[540, 300]]]], input_labels=[[[1]]]
    )
    processor.add_inputs_to_inference_session(
        session, frame_idx=0, obj_ids=[2], input_boxes=[[[215, 215, 940, 665]]]
    )
    session.obj_with_new_inputs = [1, 2]
    outputs = [model(session, frame_idx=0)]
    outputs += list(model.propagate_in_video_iterator(session, start_frame_idx=0))[1:]
    answers = {"original": torch.tensor([session.video_height, session.video_width], dtype=torch.float32)}
    # The frames as a host hands them to the engine, for the engine's own preparation to be held to
    # the processor's above.
    for index, rgb in enumerate(frames):
        answers[f"frame{index}.rgba"] = torch.tensor(
            np.concatenate([rgb, np.full(rgb.shape[:2] + (1,), 255, dtype=np.uint8)], axis=-1).astype(np.float32)
        )
    for index in range(len(frames)):
        answers[f"frame{index}"] = session.get_frame(index).contiguous()
    for index, output in enumerate(outputs):
        masks = output.pred_masks[:, 0].contiguous()
        answers[f"frame{index}.masks"] = masks
        answers[f"frame{index}.scores"] = output.object_score_logits.reshape(-1).contiguous()
        full = processor.post_process_masks(
            [output.pred_masks], original_sizes=[[session.video_height, session.video_width]], binarize=False
        )[0]
        answers[f"frame{index}.image"] = full[:, 0].contiguous()
        print(
            f"frame {index}: scores {output.object_score_logits.reshape(-1).tolist()}, "
            f"pixels on {(full[:, 0] > 0).sum(dim=(1, 2)).tolist()}"
        )

save_file(answers, FOLDER / "output.safetensors")
