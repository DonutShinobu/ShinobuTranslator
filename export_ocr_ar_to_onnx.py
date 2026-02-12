import argparse
import importlib
import importlib.util
import sys
import types
from pathlib import Path
from typing import Any, Callable

import einops
import torch
from torch import nn


def load_dictionary(dict_path: Path) -> list[str]:
    with dict_path.open("r", encoding="utf-8") as handle:
        return [line.rstrip("\r\n") for line in handle if line.strip()]


def normalize_state_dict(raw: object) -> dict[str, torch.Tensor]:
    if isinstance(raw, dict):
        if "state_dict" in raw and isinstance(raw["state_dict"], dict):
            state = raw["state_dict"]
            if all(isinstance(k, str) and k.startswith("model.") for k in state):
                return {k.removeprefix("model."): v for k, v in state.items()}
            return state
        if "model" in raw and isinstance(raw["model"], dict):
            return raw["model"]
        if all(isinstance(k, str) for k in raw):
            return raw  # plain state dict
    raise RuntimeError("Unsupported checkpoint format for OCR model")


def load_ocr_module(repo_root: Path):
    """Load only OCR and xpos modules without importing the full manga_translator package."""
    ocr_dir = repo_root / "manga_translator" / "ocr"

    # Stub cv2 and numpy since model_48px.py imports them at top level
    # but they are only used by test/inference functions, not the model definition.
    if "cv2" not in sys.modules:
        sys.modules["cv2"] = types.ModuleType("cv2")

    # Create minimal stub packages so that absolute imports inside model_48px.py resolve.
    manga_translator_pkg = types.ModuleType("manga_translator")
    manga_translator_pkg.__path__ = [str(repo_root / "manga_translator")]
    manga_translator_pkg.__package__ = "manga_translator"
    sys.modules["manga_translator"] = manga_translator_pkg

    # Stub manga_translator.config with a dummy OcrConfig
    config_mod = types.ModuleType("manga_translator.config")
    config_mod.OcrConfig = type("OcrConfig", (), {})  # type: ignore[reportGeneralTypeIssues]
    sys.modules["manga_translator.config"] = config_mod

    # Stub manga_translator.utils (referenced by common.py and model_48px.py)
    utils_mod = types.ModuleType("manga_translator.utils")
    utils_mod.TextBlock = type("TextBlock", (), {})  # type: ignore
    utils_mod.Quadrilateral = type("Quadrilateral", (), {})  # type: ignore
    utils_mod.chunks = lambda lst, n: [lst[i:i+n] for i in range(0, len(lst), n)]
    sys.modules["manga_translator.utils"] = utils_mod

    utils_generic_mod = types.ModuleType("manga_translator.utils.generic")
    utils_generic_mod.AvgMeter = type("AvgMeter", (), {})  # type: ignore
    sys.modules["manga_translator.utils.generic"] = utils_generic_mod

    utils_bubble_mod = types.ModuleType("manga_translator.utils.bubble")
    utils_bubble_mod.is_ignore = lambda *a, **kw: False  # type: ignore
    sys.modules["manga_translator.utils.bubble"] = utils_bubble_mod

    # Stub manga_translator.ocr package
    ocr_pkg = types.ModuleType("manga_translator.ocr")
    ocr_pkg.__path__ = [str(ocr_dir)]
    ocr_pkg.__package__ = "manga_translator.ocr"
    sys.modules["manga_translator.ocr"] = ocr_pkg

    # Stub manga_translator.ocr.common (OfflineOCR base class)
    common_mod = types.ModuleType("manga_translator.ocr.common")
    common_mod.OfflineOCR = type("OfflineOCR", (), {"model_dir": "/tmp"})  # type: ignore
    sys.modules["manga_translator.ocr.common"] = common_mod

    # Load xpos_relative_position
    xpos_path = ocr_dir / "xpos_relative_position.py"
    xpos_spec = importlib.util.spec_from_file_location("manga_translator.ocr.xpos_relative_position", xpos_path)
    assert xpos_spec and xpos_spec.loader
    xpos_mod = importlib.util.module_from_spec(xpos_spec)
    sys.modules["manga_translator.ocr.xpos_relative_position"] = xpos_mod
    xpos_spec.loader.exec_module(xpos_mod)

    # Load model_48px
    model_path = ocr_dir / "model_48px.py"
    spec = importlib.util.spec_from_file_location("manga_translator.ocr.model_48px", model_path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["manga_translator.ocr.model_48px"] = mod
    spec.loader.exec_module(mod)

    return mod


class OCRArExportWrapper(nn.Module):
    def __init__(self, model: Any, make_causal_mask: Callable[[int], torch.Tensor]):
        super().__init__()
        self.model = model
        self.make_causal_mask = make_causal_mask

    def forward(
        self,
        image: torch.Tensor,
        char_idx: torch.Tensor,
        decoder_mask: torch.Tensor,
        encoder_mask: torch.Tensor,
    ):
        memory = self.model.backbone(image)
        memory = einops.rearrange(memory, "N C 1 W -> N W C")

        for layer in self.model.encoders:
            memory = layer(layer, src=memory, src_key_padding_mask=encoder_mask)

        char_embd = self.model.embd(char_idx)
        seq_len = char_idx.shape[1]
        causal_mask = self.make_causal_mask(seq_len).to(image.device)
        decoded = char_embd
        for layer in self.model.decoders:
            decoded = layer(
                decoded,
                memory,
                tgt_mask=causal_mask,
                tgt_key_padding_mask=decoder_mask,
                memory_key_padding_mask=encoder_mask,
            )

        pred_char_logits = self.model.pred(self.model.pred1(decoded))
        color_feats = self.model.color_pred1(decoded)

        return (
            pred_char_logits,
            self.model.color_pred_fg(color_feats),
            self.model.color_pred_bg(color_feats),
            self.model.color_pred_fg_ind(color_feats),
            self.model.color_pred_bg_ind(color_feats),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Export ocr_ar_48px.ckpt to ONNX")
    parser.add_argument(
        "--repo-root",
        default=r"D:\Downloads\manga_translate\tmp_manga_image_translator",
        help="Path to manga-image-translator repository root",
    )
    parser.add_argument(
        "--ckpt",
        default=r"D:\Downloads\manga_translate\tmp_manga_image_translator\models\ocr\ocr_ar_48px.ckpt",
        help="Checkpoint path",
    )
    parser.add_argument(
        "--dict",
        default=r"D:\Downloads\manga_translate\tmp_manga_image_translator\models\ocr\alphabet-all-v7.txt",
        help="Dictionary path",
    )
    parser.add_argument(
        "--out",
        default=r"D:\Downloads\manga_translate\public\models\ocr.onnx",
        help="Output ONNX path",
    )
    parser.add_argument("--height", type=int, default=48)
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--seq-len", type=int, default=64)
    parser.add_argument("--opset", type=int, default=18)
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    ckpt_path = Path(args.ckpt).resolve()
    dict_path = Path(args.dict).resolve()
    out_path = Path(args.out).resolve()

    if not repo_root.exists():
        raise FileNotFoundError(f"repo root not found: {repo_root}")
    if not ckpt_path.exists():
        raise FileNotFoundError(f"checkpoint not found: {ckpt_path}")
    if not dict_path.exists():
        raise FileNotFoundError(f"dictionary not found: {dict_path}")

    ocr_mod = load_ocr_module(repo_root)
    OCR = ocr_mod.OCR
    generate_square_subsequent_mask = ocr_mod.generate_square_subsequent_mask

    dictionary = load_dictionary(dict_path)
    model = OCR(dictionary, 768)
    state_dict = normalize_state_dict(torch.load(str(ckpt_path), map_location="cpu"))
    model.load_state_dict(state_dict, strict=True)
    model.eval()

    wrapper = OCRArExportWrapper(model, generate_square_subsequent_mask)
    wrapper.eval()

    # Use batch=2 for tracing so the exporter can distinguish batch from
    # other dimensions when dynamic_axes is specified.
    trace_batch = 2
    image = torch.randn(trace_batch, 3, args.height, args.width, dtype=torch.float32)
    with torch.no_grad():
        memory = model.backbone(image)
        encoder_len = int(memory.shape[-1])

    char_idx = torch.zeros((trace_batch, args.seq_len), dtype=torch.int64)
    char_idx[:, 0] = 1
    decoder_mask = torch.ones((trace_batch, args.seq_len), dtype=torch.bool)
    decoder_mask[:, 0] = False
    encoder_mask = torch.zeros((trace_batch, encoder_len), dtype=torch.bool)

    out_path.parent.mkdir(parents=True, exist_ok=True)

    dynamic_axes = {
        "image": {0: "batch"},
        "char_idx": {0: "batch"},
        "decoder_mask": {0: "batch"},
        "encoder_mask": {0: "batch"},
        "logits": {0: "batch"},
        "fg": {0: "batch"},
        "bg": {0: "batch"},
        "fg_ind": {0: "batch"},
        "bg_ind": {0: "batch"},
    }

    torch.onnx.export(
        wrapper,
        (image, char_idx, decoder_mask, encoder_mask),
        str(out_path),
        input_names=["image", "char_idx", "decoder_mask", "encoder_mask"],
        output_names=["logits", "fg", "bg", "fg_ind", "bg_ind"],
        export_params=True,
        external_data=False,
        do_constant_folding=True,
        opset_version=args.opset,
        dynamic_axes=dynamic_axes,
        dynamo=False,
    )

    print(f"Exported ONNX: {out_path}")
    print(f"Encoder length: {encoder_len}")
    print(f"Sequence length template: {args.seq_len}")
    print(f"Dynamic axes: batch dimension is dynamic for all inputs/outputs")


if __name__ == "__main__":
    main()
