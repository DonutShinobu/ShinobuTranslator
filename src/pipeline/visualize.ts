import type { TextRegion } from "../types";
import { cloneCanvas } from "./image";

export function drawRegions(
  base: HTMLCanvasElement,
  regions: TextRegion[],
  title: string,
  textSelector: (region: TextRegion) => string
): HTMLCanvasElement {
  const canvas = cloneCanvas(base);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error(`${title} 阶段无法创建预览画布`);
  }

  ctx.strokeStyle = "#ff3b30";
  ctx.fillStyle = "rgba(255,59,48,0.14)";
  ctx.lineWidth = 2;
  ctx.font = '14px "Source Han Sans SC", "Noto Sans SC", sans-serif';
  ctx.textBaseline = "top";

  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i];
    const { x, y, width, height } = region.box;
    if (region.quad && region.quad.length === 4) {
      ctx.beginPath();
      ctx.moveTo(region.quad[0].x, region.quad[0].y);
      ctx.lineTo(region.quad[1].x, region.quad[1].y);
      ctx.lineTo(region.quad[2].x, region.quad[2].y);
      ctx.lineTo(region.quad[3].x, region.quad[3].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);
    }

    const text = textSelector(region).trim() || "-";
    const label = `${i + 1}. ${text}`;
    const metrics = ctx.measureText(label);
    const labelWidth = Math.min(metrics.width + 10, Math.max(80, width));
    const labelX = region.quad ? Math.min(region.quad[0].x, region.quad[1].x, region.quad[2].x, region.quad[3].x) : x;
    const labelY = Math.max(
      0,
      (region.quad ? Math.min(region.quad[0].y, region.quad[1].y, region.quad[2].y, region.quad[3].y) : y) - 20
    );

    ctx.fillStyle = "rgba(14,20,28,0.85)";
    ctx.fillRect(labelX, labelY, labelWidth, 18);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, labelX + 5, labelY + 2);
    ctx.fillStyle = "rgba(255,59,48,0.14)";
  }

  return canvas;
}
