function decodeCtcGreedy(logits: Float32Array, steps: number, classes: number): number[] {
  const indices: number[] = [];
  let prev = -1;
  for (let t = 0; t < steps; t += 1) {
    let best = 0;
    let bestVal = Number.NEGATIVE_INFINITY;
    const offset = t * classes;
    for (let c = 0; c < classes; c += 1) {
      const v = logits[offset + c];
      if (v > bestVal) {
        bestVal = v;
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      indices.push(best);
    }
    prev = best;
  }
  return indices;
}

function tokenToText(token: number, charset: string[] | null): string {
  if (!charset) {
    return "";
  }
  const idx = token - 1;
  if (idx < 0 || idx >= charset.length) {
    return "";
  }
  return charset[idx];
}

export { decodeCtcGreedy, tokenToText };