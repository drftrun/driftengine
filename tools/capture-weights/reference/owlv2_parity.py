"""OWLv2 base patch16, as its upstream runs it, finding four named things in a pinned real frame.

The upstream half of the real model's parity: this loads the fetched checkpoint into Transformers'
`Owlv2ForObjectDetection` at the manifest's pinned revision, refusing anything missing or left
over, prepares the first of Depth Anything 3's two pinned frames and four text queries with the
upstream's own processor -- the image padded to a square after its end, blurred against aliasing and
resized to 960, normalised by CLIP's statistics; each query tokenized and padded to 16 -- and writes
the prepared image, the token ids, what the model computes before its class head joins them, its
answers and its detections to `.reference/owlv2-parity/`, where `owlv2_parity.ts` holds the engine to
them, on the CPU and on the device. **And the tokenizer's answer for a list of awkward strings**, so
the engine's tokenizer is held to the upstream's on the real vocabulary.

    node tools/capture-weights/fetch.mjs owlv2-base-patch16
    env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/owlv2_parity.py

The model folder is the fetched checkpoint beside the configuration, processor and tokenizer files
at the same revision, under `.reference/owlv2/model/`.
"""

import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from safetensors.torch import save_file
from transformers import Owlv2ForObjectDetection, Owlv2Processor

ROOT = Path(__file__).resolve().parents[3]
FOLDER = ROOT / ".reference" / "owlv2-parity"
FOLDER.mkdir(exist_ok=True)
MODEL = ROOT / ".reference" / "owlv2" / "model"
manifest = json.loads((ROOT / "tools" / "capture-weights" / "manifest.json").read_text())
entry = next(m for m in manifest["models"] if m["name"] == "owlv2-base-patch16")
if hashlib.sha256((MODEL / "model.safetensors").read_bytes()).hexdigest() != entry["sha256"]:
    raise SystemExit("the checkpoint is not the one the manifest pins; fetch it again")
for extra in entry["extra"]:
    if hashlib.sha256((MODEL / extra["file"]).read_bytes()).hexdigest() != extra["sha256"]:
        raise SystemExit(f"{extra['file']} is not the one the manifest pins")
image = json.loads((Path(__file__).parent / "inputs.json").read_text())["images"][0]
path = ROOT / ".reference" / "da3-parity" / image["file"]
if hashlib.sha256(path.read_bytes()).hexdigest() != image["sha256"]:
    raise SystemExit(f"{path} is not the frame the reference pins")
frame = Image.open(path).convert("RGB")

model, info = Owlv2ForObjectDetection.from_pretrained(MODEL, output_loading_info=True)
problems = {key: value for key, value in info.items() if value}
if problems:
    raise SystemExit(f"the checkpoint does not load as the upstream's model: {problems}")
model.eval()
processor = Owlv2Processor.from_pretrained(MODEL)

QUERIES = ["a skyscraper", "a bridge", "a boat", "a tree"]
# Strings for the tokenizer alone: case, runs of space, contractions, digits, punctuation runs,
# accents composed and not, a soft hyphen, the padding token inside a word, the specials by name,
# and a word the merges build in several steps.
STRINGS = [
    "a photo of a cat", "  A   Photo\tOF a\nCAT  ", "it's the dog's bone, isn't it?", "route 66 and 2024",
    "...!!!???", "café, café and CAFÉ", "soft­hyphen", "wow! great!", "<|startoftext|>a<|endoftext|>b",
    "<|StartOfText|>c", "antidisestablishmentarianism", "ΣΟΦΊΑ σοφία", "東京タワー", "emoji 🚲 bike",
]

with torch.inference_mode():
    tokens = {s: processor.tokenizer(s)["input_ids"] for s in STRINGS}
    inputs = processor(text=[QUERIES], images=frame, return_tensors="pt")
    captured = {}

    def keep(name):
        def hook(_module, _inputs, output):
            captured[name] = output.detach().clone()

        return hook

    model.class_head.dense0.register_forward_hook(keep("classes"))
    model.class_head.logit_shift.register_forward_hook(keep("shift"))
    model.class_head.logit_scale.register_forward_hook(keep("scale"))
    model.owlv2.text_projection.register_forward_hook(keep("queries"))
    out = model(**inputs)
    found = processor.post_process_grounded_object_detection(
        out, threshold=0.1, target_sizes=[(frame.height, frame.width)], text_labels=[QUERIES]
    )[0]

rgb = np.array(frame)
answers = {
    "image": inputs["pixel_values"][0].contiguous(),
    # The frame as a host hands it to the engine, for the engine's own preparation to be held to the
    # processor's above.
    "frame.rgba": torch.tensor(
        np.concatenate([rgb, np.full(rgb.shape[:2] + (1,), 255, dtype=np.uint8)], axis=-1).astype(np.float32)
    ),
    "tokens": inputs["input_ids"].to(torch.float32).contiguous(),
    "original": torch.tensor([frame.height, frame.width], dtype=torch.float32),
    "classes": captured["classes"][0].contiguous(),
    "shift": captured["shift"][0].contiguous(),
    "scale": captured["scale"][0].contiguous(),
    "boxes": out.pred_boxes[0].contiguous(),
    "objectness": out.objectness_logits[0].contiguous(),
    "queries": captured["queries"].contiguous(),
    "logits": out.logits[0].contiguous(),
    "detections.scores": found["scores"].contiguous(),
    "detections.labels": found["labels"].to(torch.float32).contiguous(),
    "detections.boxes": found["boxes"].contiguous(),
}
save_file(answers, FOLDER / "output.safetensors")
(FOLDER / "tokens.json").write_text(json.dumps({"queries": QUERIES, "strings": tokens}, indent=2, ensure_ascii=False))
print(f"{len(found['scores'])} detections above 0.1 on the {frame.width}×{frame.height} frame")
for score, label, box in zip(found["scores"], found["text_labels"], found["boxes"]):
    print(f"  {label}: {score.item():.3f} at {[round(b.item(), 1) for b in box]}")
