"""Transformers' own SAM 2.1, run on the seeded miniature of its layout.

The other half of the oracle `sam21Miniature.ts` is held to: `miniature.ts` writes the checkpoint and
three frames to `.reference/sam21-miniature/`, and this builds the upstream's video model at the
miniature's sizes, at the Transformers revision the manifest pins, loads the checkpoint through
`from_pretrained` -- refusing the run if any tensor is missing, unexpected or mismatched -- and
writes what the model answers to `output.safetensors`, for the tolerance to be measured over whole
outputs, and prints the values a test asserts.

    env -u LD_LIBRARY_PATH .reference/venv-da3/bin/python tools/capture-weights/reference/sam21_miniature.py
"""

import json
import shutil
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file
from transformers import Sam2VideoConfig, Sam2VideoModel
from transformers.models.sam2_video.modeling_sam2_video import Sam2VideoInferenceSession
from transformers.models.sam2.processing_sam2 import Sam2Processor

ROOT = Path(__file__).resolve().parents[3]
FOLDER = ROOT / ".reference" / "sam21-miniature"
MODEL = FOLDER / "model"
MODEL.mkdir(exist_ok=True)

# MINIATURE_SAM_21, in Transformers' terms.
config = Sam2VideoConfig(
    vision_config=dict(
        backbone_config=dict(
            model_type="sam2_hiera_det_model", hidden_size=8, num_attention_heads=1, num_channels=3,
            image_size=[64, 64], patch_kernel_size=[7, 7], patch_stride=[4, 4], patch_padding=[3, 3],
            query_stride=[2, 2], window_positional_embedding_background_size=[7, 7], num_query_pool_stages=3,
            blocks_per_stage=[1, 2, 3, 2], embed_dim_per_stage=[8, 16, 32, 64],
            num_attention_heads_per_stage=[1, 2, 2, 4], window_size_per_stage=[8, 4, 14, 7],
            global_attention_blocks=[4], mlp_ratio=4.0, hidden_act="gelu", layer_norm_eps=1e-6,
        ),
        backbone_channel_list=[64, 32, 16, 8], backbone_feature_sizes=[[16, 16], [8, 8], [4, 4]],
        fpn_hidden_size=128, fpn_kernel_size=1, fpn_stride=1, fpn_padding=0, fpn_top_down_levels=[2, 3],
        num_feature_levels=3, hidden_act="gelu", layer_norm_eps=1e-6,
    ),
    prompt_encoder_config=dict(
        hidden_size=128, image_size=64, patch_size=16, mask_input_channels=16, num_point_embeddings=4,
        hidden_act="gelu", layer_norm_eps=1e-6, scale=1,
    ),
    mask_decoder_config=dict(
        hidden_size=128, hidden_act="gelu", mlp_dim=32, num_hidden_layers=2, num_attention_heads=2,
        attention_downsample_rate=2, num_multimask_outputs=3, iou_head_depth=3, iou_head_hidden_dim=16,
        dynamic_multimask_via_stability=True, dynamic_multimask_stability_delta=0.05,
        dynamic_multimask_stability_thresh=0.98,
    ),
    image_size=64, num_maskmem=7, max_object_pointers_in_encoder=16,
    memory_attention_hidden_size=128, memory_attention_num_layers=2, memory_attention_num_attention_heads=1,
    memory_attention_downsample_rate=1, memory_attention_feed_forward_hidden_size=32,
    memory_attention_feed_forward_hidden_act="relu", memory_attention_dropout=0.1,
    rope_parameters={"rope_type": "axial", "rope_theta": 10000}, memory_attention_rope_feat_sizes=[4, 4],
    memory_attention_rope_dropout=0.1, memory_encoder_hidden_size=128, memory_encoder_output_channels=64,
    mask_downsampler_embed_dim=128, mask_downsampler_kernel_size=3, mask_downsampler_stride=2,
    mask_downsampler_padding=1, mask_downsampler_total_stride=16, mask_downsampler_hidden_act="gelu",
    memory_fuser_num_layers=2, memory_fuser_embed_dim=128, memory_fuser_intermediate_dim=64,
    memory_fuser_kernel_size=7, memory_fuser_padding=3, memory_fuser_layer_scale_init_value=1e-6,
    memory_fuser_hidden_act="gelu",
)
config.save_pretrained(MODEL)
shutil.copy(FOLDER / "checkpoint.safetensors", MODEL / "model.safetensors")
model, info = Sam2VideoModel.from_pretrained(MODEL, output_loading_info=True)
problems = {key: value for key, value in info.items() if value}
if problems:
    raise SystemExit(f"the miniature does not load as the upstream's layout: {problems}")
model.eval()

frames = load_file(FOLDER / "input.safetensors")
saved = {}


def show(label, tensor, picks):
    flat = tensor.reshape(-1)
    print(f"{label}: " + ", ".join(f"[{i}, {flat[i].item()!r}]" for i in picks))


with torch.no_grad():
    # The encoder: the three levels as `get_image_features` leaves them, flattened to HW x B x C.
    vision = model.get_image_features(frames["frame0"], return_dict=True)
    high0, high1, features = vision.fpn_hidden_states
    for name, level in (("high0", high0), ("high1", high1), ("features", features)):
        channel_major = level.permute(1, 2, 0)[0].contiguous()  # C x HW
        saved[f"encoder.{name}"] = channel_major
        show(f"encoder {name} [channel · cells + cell]", channel_major, [0, 5, 37, channel_major.numel() // 2, channel_major.numel() - 1])

    # The decoder on the first frame with nothing remembered, for each prompt: every mask raw --
    # multimask gives masks 1 to 3, and the single mask with the stability fallback switched off,
    # through the model's own attribute, gives mask 0 -- with its quality, the object score, and
    # every mask token's object pointer.
    setup = json.loads((FOLDER / "prompts.json").read_text())
    original = (setup["image"]["height"], setup["image"]["width"])
    grids = [(16, 16), (8, 8), (4, 4)]
    maps = [level.permute(1, 2, 0).reshape(1, -1, *grid) for level, grid in zip(vision.fpn_hidden_states, grids)]
    image_embedding = maps[2] + model.no_memory_embedding.permute(0, 2, 1).reshape(1, -1, 1, 1)
    positions = model.get_image_wide_positional_embeddings()
    saved["decoder.positions"] = positions[0].contiguous()
    show("decoder positions [channel · 16 + cell]", positions, [0, 5, 63 * 16 + 3, 64 * 16 + 9, 127 * 16 + 15])
    for name, prompt in setup["prompts"].items():
        points = labels = boxes = None
        if "points" in prompt:
            coords = torch.tensor([p[:2] for p in prompt["points"]], dtype=torch.float32)
            points = Sam2Processor._normalize_coordinates(None, 64, coords, original)[None, None]
            labels = torch.tensor([p[2] for p in prompt["points"]], dtype=torch.int32)[None, None]
        if "box" in prompt:
            box = torch.tensor(prompt["box"], dtype=torch.float32)
            boxes = Sam2Processor._normalize_coordinates(None, 64, box, original, is_bounding_box=True).reshape(1, 1, 4)
        sparse, dense = model.prompt_encoder(input_points=points, input_labels=labels, input_boxes=boxes, input_masks=None)
        decoded = {}
        for multimask in (True, False):
            model.mask_decoder.dynamic_multimask_via_stability = False
            masks, quality, tokens, score = model.mask_decoder(
                image_embeddings=image_embedding, image_positional_embeddings=positions,
                sparse_prompt_embeddings=sparse, dense_prompt_embeddings=dense,
                multimask_output=multimask, high_resolution_features=maps[:2],
            )
            decoded[multimask] = (masks[0, 0], quality[0, 0], model.object_pointer_proj(tokens[0, 0]), score[0, 0])
        masks = torch.cat([decoded[False][0], decoded[True][0]], 0)
        quality = torch.cat([decoded[False][1], decoded[True][1]], 0)
        pointers = torch.cat([decoded[False][2], decoded[True][2]], 0)
        score = decoded[True][3]
        saved[f"{name}.tokens"] = sparse[0, 0].contiguous()
        saved[f"{name}.masks"] = masks.contiguous()
        saved[f"{name}.quality"] = quality.contiguous()
        saved[f"{name}.pointers"] = pointers.contiguous()
        saved[f"{name}.object"] = score.contiguous()
        print(f"\n{name}: {sparse.shape[2]} tokens; quality {quality.tolist()!r}; object {score.tolist()!r}")
        show(f"{name} tokens [token · 128 + channel]", sparse, [0, 3, 63, 64, 127, sparse.numel() - 1, 128 + 100])
        show(f"{name} masks [mask · 256 + pixel]", masks, [0, 37, 255, 256 + 100, 512 + 17, 768 + 255])
        show(f"{name} pointers [mask · 128 + channel]", pointers, [0, 77, 128 + 5, 511])

    # The video half: four frames, three objects prompted on the first -- a point, a box, and two
    # points, which decode one mask and fall back to the best of three -- tracked through the
    # upstream's own session and loop. Twice: once with the object-score head's
    # last bias raised to 2, so both objects are present and their masks are real, and once as
    # drawn, where the score is negative and every absent-object path is taken instead.
    video = torch.cat([frames[f"frame{i}"] for i in range(4)], 0)
    drawn_bias = model.mask_decoder.pred_obj_score_head.proj_out.bias.clone()
    for scenario, bias in (("present", torch.full_like(drawn_bias, 2.0)), ("absent", drawn_bias)):
        model.mask_decoder.pred_obj_score_head.proj_out.bias.copy_(bias)
        model.mask_decoder.dynamic_multimask_via_stability = True
        session = Sam2VideoInferenceSession(video=video, video_height=original[0], video_width=original[1], dtype=torch.float32)
        coords = torch.tensor([setup["prompts"]["point"]["points"][0][:2]], dtype=torch.float32)
        point = Sam2Processor._normalize_coordinates(None, 64, coords, original)
        box = Sam2Processor._normalize_coordinates(
            None, 64, torch.tensor(setup["prompts"]["box"]["box"], dtype=torch.float32), original, is_bounding_box=True
        )
        first = session.obj_id_to_idx(1)
        session.add_point_inputs(first, 0, {"point_coords": point[None, None], "point_labels": torch.tensor([[[1]]], dtype=torch.int32)})
        second = session.obj_id_to_idx(2)
        session.add_point_inputs(second, 0, {"point_coords": box.reshape(1, 1, 2, 2), "point_labels": torch.tensor([[[2, 3]]], dtype=torch.int32)})
        pair = Sam2Processor._normalize_coordinates(
            None, 64, torch.tensor([p[:2] for p in setup["prompts"]["both"]["points"]], dtype=torch.float32), original
        )
        third = session.obj_id_to_idx(3)
        session.add_point_inputs(third, 0, {"point_coords": pair[None, None], "point_labels": torch.tensor([[[1, 0]]], dtype=torch.int32)})
        session.obj_with_new_inputs = [1, 2, 3]
        outputs = [model(session, frame_idx=0)]
        outputs += list(model.propagate_in_video_iterator(session, start_frame_idx=0))[1:]
        for index, output in enumerate(outputs):
            masks = output.pred_masks[:, 0].contiguous()
            saved[f"{scenario}.frame{index}.masks"] = masks
            saved[f"{scenario}.frame{index}.scores"] = output.object_score_logits.reshape(-1).contiguous()
            print(f"{scenario} frame {output.frame_idx}: scores {output.object_score_logits.reshape(-1).tolist()!r}")
            show(f"{scenario} frame {output.frame_idx} masks [object · 256 + pixel]", masks, [0, 37, 255, 256 + 100, 511, 512 + 40, 767])
        memory = session.output_dict_per_obj[first]["cond_frame_outputs"][0]["maskmem_features"]
        saved[f"{scenario}.memory0"] = memory.float().reshape(-1).contiguous()
    model.mask_decoder.pred_obj_score_head.proj_out.bias.copy_(drawn_bias)

save_file(saved, FOLDER / "output.safetensors")
