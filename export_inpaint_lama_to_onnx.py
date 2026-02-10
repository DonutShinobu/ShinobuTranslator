import argparse
import sys
from pathlib import Path

import onnx
from onnx import helper
import torch
from torch import nn


class LamaLargeInpaintExportWrapper(nn.Module):
    def __init__(self, generator: nn.Module):
        super().__init__()
        self.generator = generator

    def forward(self, image: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        mask_binary = (mask >= 0.5).to(dtype=image.dtype)
        masked_image = image * (1.0 - mask_binary)
        predicted = self.generator(masked_image, mask_binary)
        composited = predicted * mask_binary + masked_image * (1.0 - mask_binary)
        return torch.clamp(composited, 0.0, 1.0)


def patch_invalid_dft_attributes(model_path: Path) -> int:
    model = onnx.load(str(model_path))
    patched_count = 0

    for node in model.graph.node:
        if node.op_type != "DFT":
            continue

        inverse_attr = None
        onesided_attr = None
        for attr in node.attribute:
            if attr.name == "inverse":
                inverse_attr = attr
            elif attr.name == "onesided":
                onesided_attr = attr

        inverse_value = (
            int(helper.get_attribute_value(inverse_attr)) if inverse_attr else 0
        )
        onesided_value = (
            int(helper.get_attribute_value(onesided_attr)) if onesided_attr else 0
        )
        if inverse_value == 1 and onesided_value == 1:
            if onesided_attr is not None:
                node.attribute.remove(onesided_attr)
            node.attribute.extend([helper.make_attribute("onesided", 0)])
            patched_count += 1

    if patched_count > 0:
        onnx.save(model, str(model_path))

    return patched_count


def main() -> None:
    parser = argparse.ArgumentParser(description="Export lama_large_512px.ckpt to ONNX")
    parser.add_argument(
        "--repo-root",
        default=r"D:\Downloads\manga_translate\tmp_manga_image_translator",
        help="Path to manga-image-translator repository root",
    )
    parser.add_argument(
        "--ckpt",
        default=r"D:\Downloads\manga_translate\tmp_manga_image_translator\models\inpainting\lama_large_512px.ckpt",
        help="Checkpoint path",
    )
    parser.add_argument(
        "--out",
        default=r"D:\Downloads\manga_translate\public\models\inpaint.onnx",
        help="Output ONNX path",
    )
    parser.add_argument(
        "--size", type=int, default=512, help="Square export resolution"
    )
    parser.add_argument("--opset", type=int, default=18)
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    ckpt_path = Path(args.ckpt).resolve()
    out_path = Path(args.out).resolve()

    if not repo_root.exists():
        raise FileNotFoundError(f"repo root not found: {repo_root}")
    if not ckpt_path.exists():
        raise FileNotFoundError(f"checkpoint not found: {ckpt_path}")

    sys.path.insert(0, str(repo_root))
    from manga_translator.inpainting.inpainting_lama_mpe import (  # type: ignore[reportMissingImports]  # noqa: E402
        load_lama_mpe,
    )

    model = load_lama_mpe(str(ckpt_path), device="cpu", use_mpe=False, large_arch=True)
    wrapper = LamaLargeInpaintExportWrapper(model.generator)
    wrapper.eval()

    image = torch.rand((1, 3, args.size, args.size), dtype=torch.float32)
    mask = torch.zeros((1, 1, args.size, args.size), dtype=torch.float32)
    center_h0 = args.size // 4
    center_h1 = args.size - center_h0
    center_w0 = args.size // 4
    center_w1 = args.size - center_w0
    mask[:, :, center_h0:center_h1, center_w0:center_w1] = 1.0

    out_path.parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        wrapper,
        (image, mask),
        str(out_path),
        input_names=["image", "mask"],
        output_names=["inpainted"],
        export_params=True,
        external_data=False,
        do_constant_folding=True,
        opset_version=args.opset,
    )

    patched_count = patch_invalid_dft_attributes(out_path)

    print(f"Exported ONNX: {out_path}")
    print(f"Patched DFT nodes (inverse=1, onesided=1 -> onesided=0): {patched_count}")
    print(f"Input shape: [1,3,{args.size},{args.size}] + [1,1,{args.size},{args.size}]")
    print("Normalization contract: image input/output in [0,1], mask in {0,1}")


if __name__ == "__main__":
    main()
