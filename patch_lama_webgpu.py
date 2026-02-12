"""Patch lama_fp32.onnx so that it can run on the WebGPU execution provider.

Problem
-------
The LaMa ONNX model contains FFC (Fast Fourier Convolution) layers whose
custom ``irfft`` reconstruction uses a Concat → Einsum → … → Transpose
pipeline.  The WASM backend computes the intermediate FFT spectrum with
N/2 + 1 elements (as per the mathematical convention), but the WebGPU
backend sometimes produces only N/2 elements.  This makes one operand of
the subsequent ``Add`` node one element shorter on one spatial axis,
crashing the WebGPU kernel with:

    [WebGPU] Kernel "[Add] …/convg2g/Add" failed.
    Error: Can't perform binary op on the given tensors

The 36 affected ``Add`` nodes all follow the pattern
``/generator/model/model.*/conv*/ffc/convg2g/Add`` and add:

*  input[0] – conv branch output  (correct shape)
*  input[1] – Fourier-unit branch (``fu/Transpose_10_output_0``,
   possibly 1 element short on H and/or W)

Fix
---
For every such ``Add`` we replace it with a small sub-graph that:

1. Reads the shapes of both inputs.
2. Computes ``delta = shape(input_0) - shape(input_1)`` for axes 2 & 3
   (the H and W spatial dims).
3. Builds ``[0, 0, 0, 0, 0, 0, delta_H, delta_W]`` as pad amounts and
   pads input_1 with zeros on the right/bottom ("edge" would also work
   but zero-pad keeps it simple and the difference is < 1 pixel).
4. Adds the (now equal-sized) tensors.

Because the padding is computed from runtime shapes the patch is safe on
*every* backend: if the shapes already match (WASM), delta is 0 and the
Pad is a no-op.

Usage
-----
    py -3 patch_lama_webgpu.py [--input path] [--output path]

Defaults read ``public/models/lama_fp32.onnx`` and write
``public/models/lama_fp32.onnx`` (in-place).
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper


def _make_unique(base: str, existing: set[str], suffix: str = "") -> str:
    name = f"{base}{suffix}"
    i = 0
    while name in existing:
        i += 1
        name = f"{base}{suffix}_{i}"
    existing.add(name)
    return name


def patch_convg2g_adds(model: onnx.ModelProto) -> int:
    """Replace every ``convg2g/Add`` with a shape-aware Pad+Add sub-graph."""

    all_names: set[str] = set()
    for node in model.graph.node:
        all_names.add(node.name)
        for o in node.output:
            all_names.add(o)

    # Collect target Add nodes (by index) – we will splice them out later.
    targets: list[tuple[int, onnx.NodeProto]] = []
    for idx, node in enumerate(model.graph.node):
        if node.op_type == "Add" and node.name.endswith("/convg2g/Add"):
            targets.append((idx, node))

    if not targets:
        return 0

    # We need a single zero constant (int64 scalar 0) shared across all
    # patches and a constant [0,0,0,0,0,0] prefix for the pad vector.
    zero_scalar_name = _make_unique("_patch/zero_scalar", all_names)
    zero_scalar_init = helper.make_tensor(
        zero_scalar_name, TensorProto.INT64, [1], [0]
    )
    model.graph.initializer.append(zero_scalar_init)

    pad_prefix_name = _make_unique("_patch/pad_prefix", all_names)
    pad_prefix_init = helper.make_tensor(
        pad_prefix_name, TensorProto.INT64, [6], [0, 0, 0, 0, 0, 0]
    )
    model.graph.initializer.append(pad_prefix_init)

    zero_const_name = _make_unique("_patch/zero_const", all_names)
    zero_const_init = helper.make_tensor(
        zero_const_name, TensorProto.FLOAT, [], [0.0]
    )
    model.graph.initializer.append(zero_const_init)

    # Process in reverse index order so that earlier indices stay valid.
    new_node_batches: list[tuple[int, list[onnx.NodeProto]]] = []
    for orig_idx, add_node in reversed(targets):
        conv_input = add_node.input[0]   # shape is always correct
        fft_input = add_node.input[1]    # may be 1 short on H/W
        add_output = add_node.output[0]

        tag = add_node.name.replace("/", "_")

        # --- shape_conv = Shape(conv_input) ---
        shape_conv_out = _make_unique(f"{tag}/shape_conv", all_names)
        n_shape_conv = helper.make_node(
            "Shape", [conv_input], [shape_conv_out],
            name=_make_unique(f"{tag}/Shape_conv", all_names),
        )

        # --- shape_fft = Shape(fft_input) ---
        shape_fft_out = _make_unique(f"{tag}/shape_fft", all_names)
        n_shape_fft = helper.make_node(
            "Shape", [fft_input], [shape_fft_out],
            name=_make_unique(f"{tag}/Shape_fft", all_names),
        )

        # --- delta = shape_conv - shape_fft  (element-wise int64) ---
        delta_out = _make_unique(f"{tag}/delta", all_names)
        n_delta = helper.make_node(
            "Sub", [shape_conv_out, shape_fft_out], [delta_out],
            name=_make_unique(f"{tag}/Sub_delta", all_names),
        )

        # --- delta_hw = delta[2:]  (only H,W diffs; skip N,C) ---
        # Slice(delta, starts=[2], ends=[4], axes=[0])
        slice_starts_name = _make_unique(f"{tag}/slice_starts", all_names)
        slice_starts_init = helper.make_tensor(
            slice_starts_name, TensorProto.INT64, [1], [2]
        )
        model.graph.initializer.append(slice_starts_init)

        slice_ends_name = _make_unique(f"{tag}/slice_ends", all_names)
        slice_ends_init = helper.make_tensor(
            slice_ends_name, TensorProto.INT64, [1], [4]
        )
        model.graph.initializer.append(slice_ends_init)

        slice_axes_name = _make_unique(f"{tag}/slice_axes", all_names)
        slice_axes_init = helper.make_tensor(
            slice_axes_name, TensorProto.INT64, [1], [0]
        )
        model.graph.initializer.append(slice_axes_init)

        delta_hw_out = _make_unique(f"{tag}/delta_hw", all_names)
        n_delta_hw = helper.make_node(
            "Slice",
            [delta_out, slice_starts_name, slice_ends_name, slice_axes_name],
            [delta_hw_out],
            name=_make_unique(f"{tag}/Slice_delta_hw", all_names),
        )

        # --- clamp negatives to 0: delta_hw_pos = Max(delta_hw, 0) ---
        delta_hw_pos_out = _make_unique(f"{tag}/delta_hw_pos", all_names)
        n_clamp = helper.make_node(
            "Max", [delta_hw_out, zero_scalar_name], [delta_hw_pos_out],
            name=_make_unique(f"{tag}/Max_clamp", all_names),
        )

        # --- pads = Concat(pad_prefix, delta_hw_pos)  →  [0,0,0,0,0,0,dH,dW]
        pads_out = _make_unique(f"{tag}/pads", all_names)
        n_pads = helper.make_node(
            "Concat", [pad_prefix_name, delta_hw_pos_out], [pads_out],
            name=_make_unique(f"{tag}/Concat_pads", all_names),
            axis=0,
        )

        # --- padded_fft = Pad(fft_input, pads, constant_value=0) ---
        padded_fft_out = _make_unique(f"{tag}/padded_fft", all_names)
        n_pad = helper.make_node(
            "Pad", [fft_input, pads_out, zero_const_name], [padded_fft_out],
            name=_make_unique(f"{tag}/Pad_fft", all_names),
            mode="constant",
        )

        # --- output = Add(conv_input, padded_fft) ---
        n_add = helper.make_node(
            "Add", [conv_input, padded_fft_out], [add_output],
            name=_make_unique(f"{tag}/Add_patched", all_names),
        )

        replacement = [
            n_shape_conv, n_shape_fft, n_delta, n_delta_hw,
            n_clamp, n_pads, n_pad, n_add,
        ]
        new_node_batches.append((orig_idx, replacement))

    # Apply splices (already in reverse order).
    nodes = list(model.graph.node)
    for orig_idx, replacement in new_node_batches:
        nodes[orig_idx: orig_idx + 1] = replacement
    del model.graph.node[:]
    model.graph.node.extend(nodes)

    return len(targets)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Patch LaMa ONNX model for WebGPU compatibility"
    )
    parser.add_argument(
        "--input",
        default="public/models/lama_fp32.onnx",
        help="Input ONNX model path (default: public/models/lama_fp32.onnx)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output ONNX model path (default: same as input, in-place)",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output) if args.output else input_path

    if not input_path.exists():
        raise FileNotFoundError(f"Model not found: {input_path}")

    print(f"Loading model: {input_path}")
    model = onnx.load(str(input_path))
    print(f"  opset: {model.opset_import[0].version}")
    print(f"  nodes: {len(model.graph.node)}")

    patched = patch_convg2g_adds(model)
    print(f"  patched convg2g/Add nodes: {patched}")

    if patched > 0:
        print(f"Saving patched model: {output_path}")
        onnx.save(model, str(output_path))
        print("Done.")
    else:
        print("No nodes to patch – model unchanged.")


if __name__ == "__main__":
    main()
