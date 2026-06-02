# OCR AR 结构复用优化实验 — 技术设计

## Scope

本实验只改内置 AR OCR 的 decode/color 数据流，不改模型文件，不改 provider 默认选择。

## Current Flow

```
runOcrByOnnxWithSession
  -> buildOcrInput per region
  -> runOcrBatchDecode
       -> decodeBatchAutoregressive
            -> session.run per generated step
            -> use logits only
  -> runOcrColorBatch
       -> session.run once more with final tokenIds
       -> use fg/bg outputs
```

## Proposed Flow

```
decodeBatchAutoregressive
  -> session.run per generated step
  -> use logits for next token
  -> also inspect fg/bg outputs from the same run
  -> when a sample finishes, cache colors from the latest run that includes its token prefix

runOcrByOnnxWithSession
  -> if all accepted decoded items include cached colors:
       use cached colors and skip runOcrColorBatch
     else:
       keep existing runOcrColorBatch fallback
```

## Contracts

- Add optional `colors` to AR decode output items.
- Reuse existing `OcrColorResult` shape: `{ fgColor, bgColor }`.
- Move color tensor extraction to an ORT-independent helper so both `color.ts` and `decodeAutoregressive.ts` can share it without circular imports.
- Keep `Comlink.transfer()` rules unchanged: input arrays are structured-cloned, output arrays may be transferred.

## Rollback

- Remove optional `colors` propagation and restore unconditional `runOcrColorBatch()`.
- The new shared helper is isolated and can remain if used by `color.ts`.
