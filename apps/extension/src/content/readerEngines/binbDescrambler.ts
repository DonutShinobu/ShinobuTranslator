import type { BinbPageDescriptor } from './binbContent';
import { BinbInvalidResponseError, BinbUnsupportedError } from './binbErrors';

const currentKeyAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const legacyKeyAlphabet = 'aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ';

export type BinbTileMove = {
  sourceX: number;
  sourceY: number;
  width: number;
  height: number;
  destinationX: number;
  destinationY: number;
};

export type BinbDescramblePlan = {
  variant: 'A' | 'F';
  outputWidth: number;
  outputHeight: number;
  moves: readonly BinbTileMove[];
};

type FPieceData = {
  horizontalRemainderPositions: readonly number[];
  verticalRemainderPositions: readonly number[];
  pieces: readonly number[];
};

function isPermutation(values: readonly number[], length: number): boolean {
  return values.length === length
    && values.every((value) => Number.isInteger(value) && value >= 0 && value < length)
    && new Set(values).size === length;
}

function decodeFPieceData(
  encoded: string,
  columns: number,
  rows: number,
): FPieceData | null {
  const indexes = [...encoded].map((character) => currentKeyAlphabet.indexOf(character));
  if (indexes.some((index) => index < 0)) return null;
  const horizontalRemainderPositions = indexes.slice(0, columns);
  const verticalRemainderPositions = indexes.slice(columns, columns + rows);
  const pieces = indexes.slice(columns + rows);
  if (
    horizontalRemainderPositions.some((value) => value >= rows)
    || verticalRemainderPositions.some((value) => value >= columns)
    || !isPermutation(pieces, columns * rows)
  ) {
    return null;
  }
  return { horizontalRemainderPositions, verticalRemainderPositions, pieces };
}

function createFDescramblePlan(
  primaryKey: string,
  secondaryKey: string,
  width: number,
  height: number,
): BinbDescramblePlan | null {
  const pattern = /^=(\d+)-(\d+)([-+])(\d+)-([-_\dA-Za-z]+)$/u;
  const sourceMatch = pattern.exec(primaryKey);
  const destinationMatch = pattern.exec(secondaryKey);
  if (!sourceMatch && !destinationMatch) return null;
  if (
    !sourceMatch
    || !destinationMatch
    || sourceMatch[1] !== destinationMatch[1]
    || sourceMatch[2] !== destinationMatch[2]
    || sourceMatch[4] !== destinationMatch[4]
    || sourceMatch[3] !== '-'
    || destinationMatch[3] !== '+'
  ) {
    throw new BinbUnsupportedError('未知 BinB F 拼图表结构');
  }
  const columns = Number(sourceMatch[1]);
  const rows = Number(sourceMatch[2]);
  const padding = Number(sourceMatch[4]);
  const encodedLength = columns + rows + columns * rows;
  if (
    !Number.isSafeInteger(columns)
    || !Number.isSafeInteger(rows)
    || !Number.isSafeInteger(padding)
    || columns < 8
    || rows < 8
    || columns * rows !== 64
    || padding < 0
    || padding > 64
    || sourceMatch[5].length !== encodedLength
    || destinationMatch[5].length !== encodedLength
  ) {
    throw new BinbUnsupportedError('未知 BinB F 拼图表参数');
  }
  const source = decodeFPieceData(sourceMatch[5], columns, rows);
  const destination = decodeFPieceData(destinationMatch[5], columns, rows);
  if (!source || !destination) throw new BinbUnsupportedError('未知 BinB F 拼图坐标');
  const horizontalPadding = 2 * columns * padding;
  const verticalPadding = 2 * rows * padding;
  const outputWidth = width - horizontalPadding;
  const outputHeight = height - verticalPadding;
  if (
    width < 64 + horizontalPadding
    || height < 64 + verticalPadding
    || width * height < (320 + horizontalPadding) * (320 + verticalPadding)
    || outputWidth <= 0
    || outputHeight <= 0
  ) {
    throw new BinbInvalidResponseError('BinB F 拼图图片尺寸无效');
  }
  const pieceWidth = Math.ceil(outputWidth / columns);
  const remainderWidth = outputWidth - (columns - 1) * pieceWidth;
  const pieceHeight = Math.ceil(outputHeight / rows);
  const remainderHeight = outputHeight - (rows - 1) * pieceHeight;
  const pieceDestinations = source.pieces.map((piece) => destination.pieces[piece]);
  const moves: BinbTileMove[] = [];
  for (let sourceIndex = 0; sourceIndex < columns * rows; sourceIndex += 1) {
    const sourceColumn = sourceIndex % columns;
    const sourceRow = Math.floor(sourceIndex / columns);
    const destinationIndex = pieceDestinations[sourceIndex];
    const destinationColumn = destinationIndex % columns;
    const destinationRow = Math.floor(destinationIndex / columns);
    moves.push({
      sourceX: padding
        + sourceColumn * (pieceWidth + 2 * padding)
        + (source.verticalRemainderPositions[sourceRow] < sourceColumn
          ? remainderWidth - pieceWidth
          : 0),
      sourceY: padding
        + sourceRow * (pieceHeight + 2 * padding)
        + (source.horizontalRemainderPositions[sourceColumn] < sourceRow
          ? remainderHeight - pieceHeight
          : 0),
      width: source.verticalRemainderPositions[sourceRow] === sourceColumn
        ? remainderWidth
        : pieceWidth,
      height: source.horizontalRemainderPositions[sourceColumn] === sourceRow
        ? remainderHeight
        : pieceHeight,
      destinationX: destinationColumn * pieceWidth
        + (destination.verticalRemainderPositions[destinationRow] < destinationColumn
          ? remainderWidth - pieceWidth
          : 0),
      destinationY: destinationRow * pieceHeight
        + (destination.horizontalRemainderPositions[destinationColumn] < destinationRow
          ? remainderHeight - pieceHeight
          : 0),
    });
  }
  return { variant: 'F', outputWidth, outputHeight, moves };
}

type APiece = { x: number; y: number; widthUnits: number; heightUnits: number };
type APieceData = { columns: number; rows: number; pieces: readonly APiece[] };

function decodeAPieceData(key: string): APieceData | null {
  const match = /^(\d+)-(\d+)-([-_\dA-Za-z]+)$/u.exec(key);
  if (!match) return null;
  const columns = Number(match[1]);
  const rows = Number(match[2]);
  const encoded = match[3];
  if (
    !Number.isSafeInteger(columns)
    || !Number.isSafeInteger(rows)
    || columns < 2
    || rows < 2
    || columns * rows > 1_024
    || encoded.length !== columns * rows * 2
  ) {
    return null;
  }
  const mainEnd = (columns - 1) * (rows - 1) - 1;
  const bottomEnd = columns - 1 + mainEnd;
  const sideEnd = rows - 1 + bottomEnd;
  const cornerEnd = 1 + sideEnd;
  const pieces: APiece[] = [];
  for (let index = 0; index < columns * rows; index += 1) {
    const x = legacyKeyAlphabet.indexOf(encoded[index * 2]);
    const y = legacyKeyAlphabet.indexOf(encoded[index * 2 + 1]);
    if (x < 0 || y < 0 || x > (columns - 1) * 2 || y > (rows - 1) * 2) return null;
    let widthUnits = 0;
    let heightUnits = 0;
    if (index <= mainEnd) {
      widthUnits = 2;
      heightUnits = 2;
    } else if (index <= bottomEnd) {
      widthUnits = 2;
      heightUnits = 1;
    } else if (index <= sideEnd) {
      widthUnits = 1;
      heightUnits = 2;
    } else if (index <= cornerEnd) {
      widthUnits = 1;
      heightUnits = 1;
    }
    pieces.push({ x, y, widthUnits, heightUnits });
  }
  return { columns, rows, pieces };
}

function createADescramblePlan(
  primaryKey: string,
  secondaryKey: string,
  width: number,
  height: number,
): BinbDescramblePlan | null {
  const destination = decodeAPieceData(primaryKey);
  const source = decodeAPieceData(secondaryKey);
  if (!destination && !source) return null;
  if (!destination || !source || destination.columns !== source.columns || destination.rows !== source.rows) {
    throw new BinbUnsupportedError('未知 BinB A 拼图表结构');
  }
  if (width < 64 || height < 64 || width * height < 102_400) {
    throw new BinbInvalidResponseError('BinB A 拼图图片尺寸无效');
  }
  const coreWidth = width - (width % 8);
  const pieceWidth = Math.floor((coreWidth - 1) / 7 / 8) * 8;
  const remainderWidth = coreWidth - 7 * pieceWidth;
  const coreHeight = height - (height % 8);
  const pieceHeight = Math.floor((coreHeight - 1) / 7 / 8) * 8;
  const remainderHeight = coreHeight - 7 * pieceHeight;
  if (pieceWidth <= 0 || pieceHeight <= 0) {
    throw new BinbInvalidResponseError('BinB A 拼图分块尺寸无效');
  }
  const moves = source.pieces.map((sourcePiece, index): BinbTileMove => {
    const destinationPiece = destination.pieces[index];
    return {
      sourceX: Math.floor(sourcePiece.x / 2) * pieceWidth + (sourcePiece.x % 2) * remainderWidth,
      sourceY: Math.floor(sourcePiece.y / 2) * pieceHeight + (sourcePiece.y % 2) * remainderHeight,
      width: Math.floor(sourcePiece.widthUnits / 2) * pieceWidth
        + (sourcePiece.widthUnits % 2) * remainderWidth,
      height: Math.floor(sourcePiece.heightUnits / 2) * pieceHeight
        + (sourcePiece.heightUnits % 2) * remainderHeight,
      destinationX: Math.floor(destinationPiece.x / 2) * pieceWidth
        + (destinationPiece.x % 2) * remainderWidth,
      destinationY: Math.floor(destinationPiece.y / 2) * pieceHeight
        + (destinationPiece.y % 2) * remainderHeight,
    };
  });
  const tiledWidth = pieceWidth * (source.columns - 1) + remainderWidth;
  const tiledHeight = pieceHeight * (source.rows - 1) + remainderHeight;
  if (tiledWidth < width) {
    moves.push({
      sourceX: tiledWidth,
      sourceY: 0,
      width: width - tiledWidth,
      height: tiledHeight,
      destinationX: tiledWidth,
      destinationY: 0,
    });
  }
  if (tiledHeight < height) {
    moves.push({
      sourceX: 0,
      sourceY: tiledHeight,
      width,
      height: height - tiledHeight,
      destinationX: 0,
      destinationY: tiledHeight,
    });
  }
  return { variant: 'A', outputWidth: width, outputHeight: height, moves };
}

export function createBinbDescramblePlan(
  primaryKey: string,
  secondaryKey: string,
  width: number,
  height: number,
): BinbDescramblePlan {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new BinbInvalidResponseError('BinB 拼图图片尺寸无效');
  }
  const current = createFDescramblePlan(primaryKey, secondaryKey, width, height);
  if (current) return current;
  const legacy = createADescramblePlan(primaryKey, secondaryKey, width, height);
  if (legacy) return legacy;
  throw new BinbUnsupportedError('未知 BinB 图片拼图表型');
}

function canvasToPngBlob(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (signal.aborted) reject(signal.reason);
      else if (blob) resolve(blob);
      else reject(new Error('BinB 恢复图片导出失败'));
    }, 'image/png');
  });
}

export async function restoreBinbPageImage(
  rawImage: Blob,
  page: BinbPageDescriptor,
  signal: AbortSignal,
  document: Document = globalThis.document,
): Promise<File> {
  if (signal.aborted) throw signal.reason;
  const bitmap = await createImageBitmap(rawImage);
  try {
    if (signal.aborted) throw signal.reason;
    const plan = createBinbDescramblePlan(
      page.scrambleSourceKey,
      page.scrambleDestinationKey,
      bitmap.width,
      bitmap.height,
    );
    if (plan.outputWidth !== page.width || plan.outputHeight !== page.height) {
      throw new BinbInvalidResponseError('BinB 恢复图片尺寸与 TTX 不一致');
    }
    const canvas = document.createElement('canvas');
    canvas.width = plan.outputWidth;
    canvas.height = plan.outputHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    context.imageSmoothingEnabled = false;
    for (const move of plan.moves) {
      context.drawImage(
        bitmap,
        move.sourceX,
        move.sourceY,
        move.width,
        move.height,
        move.destinationX,
        move.destinationY,
        move.width,
        move.height,
      );
    }
    const restored = await canvasToPngBlob(canvas, signal);
    return new File([restored], `binb-page-${page.pageIndex + 1}.png`, { type: 'image/png' });
  } finally {
    bitmap.close();
  }
}
