import argparse
import sys
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

    sys.path.insert(0, str(repo_root))
    from manga_translator.ocr.model_48px import OCR, generate_square_subsequent_mask  # type: ignore[reportMissingImports]  # noqa: E402

    dictionary = load_dictionary(dict_path)
    model = OCR(dictionary, 768)
    state_dict = normalize_state_dict(torch.load(str(ckpt_path), map_location="cpu"))
    model.load_state_dict(state_dict, strict=True)
    model.eval()

    wrapper = OCRArExportWrapper(model, generate_square_subsequent_mask)
    wrapper.eval()

    image = torch.randn(1, 3, args.height, args.width, dtype=torch.float32)
    with torch.no_grad():
        memory = model.backbone(image)
        encoder_len = int(memory.shape[-1])

    char_idx = torch.zeros((1, args.seq_len), dtype=torch.int64)
    char_idx[0, 0] = 1
    decoder_mask = torch.ones((1, args.seq_len), dtype=torch.bool)
    decoder_mask[0, 0] = False
    encoder_mask = torch.zeros((1, encoder_len), dtype=torch.bool)

    out_path.parent.mkdir(parents=True, exist_ok=True)

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
    )

    print(f"Exported ONNX: {out_path}")
    print(f"Encoder length: {encoder_len}")
    print(f"Sequence length template: {args.seq_len}")


if __name__ == "__main__":
    main()
