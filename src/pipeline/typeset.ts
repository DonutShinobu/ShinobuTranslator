import type { TextRegion } from "../types";

function splitLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const chars = [...text.replace(/\s+/g, "")];
  const lines: string[] = [];
  let line = "";

  for (const ch of chars) {
    const trial = line + ch;
    if (ctx.measureText(trial).width <= maxWidth) {
      line = trial;
      continue;
    }
    if (line) {
      lines.push(line);
    }
    line = ch;
  }

  if (line) {
    lines.push(line);
  }
  return lines;
}

export function drawTypeset(canvas: HTMLCanvasElement, regions: TextRegion[]): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;

  const ctx = out.getContext("2d");
  if (!ctx) {
    throw new Error("排版阶段无法获取画布上下文");
  }

  ctx.drawImage(canvas, 0, 0);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#111111";
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 3;

  for (const region of regions) {
    const text = region.translatedText || region.sourceText;
    if (!text.trim()) {
      continue;
    }

    const boxPadding = 10;
    const contentWidth = Math.max(20, region.box.width - boxPadding * 2);
    const contentHeight = Math.max(20, region.box.height - boxPadding * 2);
    let fontSize = Math.min(42, Math.max(16, Math.floor(region.box.height / 3)));
    let lines: string[] = [];

    while (fontSize >= 12) {
      ctx.font = `${fontSize}px "Noto Sans SC", "PingFang SC", sans-serif`;
      lines = splitLines(ctx, text, contentWidth);
      const lineHeight = Math.floor(fontSize * 1.25);
      if (lines.length * lineHeight <= contentHeight) {
        break;
      }
      fontSize -= 2;
    }

    const lineHeight = Math.floor(fontSize * 1.25);
    const startY = region.box.y + region.box.height / 2 - ((lines.length - 1) * lineHeight) / 2;
    for (let i = 0; i < lines.length; i += 1) {
      const x = region.box.x + region.box.width / 2;
      const y = startY + i * lineHeight;
      ctx.strokeText(lines[i], x, y);
      ctx.fillText(lines[i], x, y);
    }
  }

  return out;
}
