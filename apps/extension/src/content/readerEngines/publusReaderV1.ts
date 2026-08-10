export type PublusV1Keys = readonly [Uint8Array, Uint8Array, Uint8Array];

export type PublusV1PageParameters = {
  file: string;
  fileName: string;
  width: number;
  height: number;
  blockWidth: number;
  blockHeight: number;
  dummyWidth: number;
  dummyHeight: number;
  ns: number;
  ps: number;
  rs: number;
};

export type PublusV1TileMove = {
  sourceX: number;
  sourceY: number;
  destinationX: number;
  destinationY: number;
  width: number;
  height: number;
};

export type PublusV1DecodedPack = {
  configuration: unknown;
  keys: PublusV1Keys;
};

function strictBase64(value: string, label: string): Uint8Array {
  if (
    value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
    || value.slice(0, -2).includes('=')
  ) {
    throw new Error(`${label}不是有效 Base64`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`${label}不是有效 Base64`);
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function concatenateBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function createRc4State(key: Uint8Array): Uint8Array {
  if (key.length === 0) throw new Error('PUBLUS 1.x RC4 密钥为空');
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let swapIndex = 0;
  for (let index = 0; index < state.length; index += 1) {
    swapIndex = (swapIndex + state[index]! + key[index % key.length]!) & 0xff;
    const value = state[index]!;
    state[index] = state[swapIndex]!;
    state[swapIndex] = value;
  }
  return state;
}

function rc4Step(
  state: Uint8Array,
  payload: Uint8Array,
  payloadIndex: number,
  firstIndex: number,
  secondIndex: number,
): readonly [number, number] {
  const nextFirst = (firstIndex + 1) & 0xff;
  const nextSecond = (secondIndex + state[nextFirst]!) & 0xff;
  const value = state[nextFirst]!;
  state[nextFirst] = state[nextSecond]!;
  state[nextSecond] = value;
  payload[payloadIndex] ^= state[(state[nextFirst]! + state[nextSecond]!) & 0xff]!;
  return [nextFirst, nextSecond];
}

function applyReverseRc4(payload: Uint8Array, key: Uint8Array, startIndex: number): void {
  const state = createRc4State(key);
  let firstIndex = 0;
  let secondIndex = 0;
  for (let payloadIndex = startIndex; payloadIndex >= 0; payloadIndex -= 2) {
    [firstIndex, secondIndex] = rc4Step(
      state,
      payload,
      payloadIndex,
      firstIndex,
      secondIndex,
    );
  }
}

function applyForwardRc4(payload: Uint8Array, key: Uint8Array): void {
  const state = createRc4State(key);
  let firstIndex = 0;
  let secondIndex = 0;
  for (let payloadIndex = 0; payloadIndex < payload.length; payloadIndex += 1) {
    [firstIndex, secondIndex] = rc4Step(
      state,
      payload,
      payloadIndex,
      firstIndex,
      secondIndex,
    );
  }
}

function rc4Crypt(payload: Uint8Array, key: Uint8Array): Uint8Array {
  const result = payload.slice();
  applyForwardRc4(result, key);
  return result;
}

function transformPublusV1Chunk(
  mode: 0 | 1 | 2 | 3,
  payload: Uint8Array,
  keys: [Uint8Array, Uint8Array, Uint8Array],
): void {
  const target = mode === 0 ? payload : keys[3 - mode]!;
  const helpers = mode === 0
    ? keys
    : keys.filter((_, index) => index !== 3 - mode);
  let helperSum = 0;
  let helperXor = 0;
  for (const helper of helpers) {
    for (let index = 0; index < 32; index += 1) {
      helperSum = (helperSum + helper[index]!) & 0xff;
      helperXor ^= helper[index]!;
    }
  }
  const swapAdjacentBits = (helperSum & 2) !== 2;
  const swapTwoBitGroups = (helperSum & 4) !== 4;
  const swapNibbles = (helperSum & 8) !== 8;
  const bitShift = helperXor >>> 5;
  const inverseShift = 8 - bitShift;
  for (let chunkStart = 0; chunkStart < target.length; chunkStart += 32) {
    const chunkLength = Math.min(32, target.length - chunkStart);
    const transformed: number[] = [];
    let sum = helperSum;
    let xor = helperXor;
    for (let index = 0; index < chunkLength; index += 1) {
      let value = target[chunkStart + index]!;
      if (swapAdjacentBits) value = ((value & 0x55) << 1) | ((value >>> 1) & 0x55);
      if (swapTwoBitGroups) value = ((value & 0x33) << 2) | ((value >>> 2) & 0x33);
      if (swapNibbles) value = ((value & 0x0f) << 4) | ((value >>> 4) & 0x0f);
      transformed[index] = value;
      sum = (sum + value) & 0xff;
      xor ^= value;
    }
    for (let index = 0; index < chunkLength; index += 1) {
      for (let power = 1; power <= 6; power += 1) {
        const bit = 2 ** power;
        if ((index & (bit - 1)) !== bit - 1) break;
        if ((sum & bit) === bit) continue;
        const boundary = index - 2 ** (power - 1);
        for (let end = index, other = boundary; end > boundary; end -= 1, other -= 1) {
          const value = transformed[end]!;
          transformed[end] = transformed[other]!;
          transformed[other] = value;
        }
      }
    }
    let rotation = xor >>> 3;
    rotation = chunkLength < 32 ? rotation % chunkLength : rotation & 31;
    if (bitShift === 0) {
      let source = chunkLength - rotation;
      for (let index = 0; index < chunkLength; index += 1) {
        if (source === chunkLength) source = 0;
        target[chunkStart + index] = transformed[source++]!;
      }
    } else {
      let source = chunkLength - rotation - 1;
      for (let index = 0; index < chunkLength; index += 1) {
        let value = transformed[source]! << inverseShift;
        source += 1;
        if (source === chunkLength) source = 0;
        value |= transformed[source]! >>> bitShift;
        target[chunkStart + index] = value & 0xff;
      }
    }
  }
}

function mixPublusV1Columns(
  payload: Uint8Array,
  keys: [Uint8Array, Uint8Array, Uint8Array],
): void {
  const arrays = [keys[0], keys[1], keys[2], payload];
  for (let index = 0; index < Math.min(32, payload.length); index += 1) {
    const selector = payload[index]! ^ keys[0][index]! ^ keys[1][index]! ^ keys[2][index]!;
    const swap = (source: number, destination: number): void => {
      const value = arrays[source]![index]!;
      arrays[source]![index] = arrays[destination]![index]!;
      arrays[destination]![index] = value;
    };
    swap((selector & 12) >>> 2, selector & 3);
    swap((selector & 192) >>> 6, (selector & 48) >>> 4);
  }
}

export function decodePublusV1Pack(rawPack: string): PublusV1DecodedPack {
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(rawPack) as unknown;
  } catch {
    throw new Error('PUBLUS 1.x 配置包不是有效 JSON');
  }
  if (
    !wrapper
    || typeof wrapper !== 'object'
    || Array.isArray(wrapper)
    || (wrapper as Record<string, unknown>).version !== '1.0'
    || typeof (wrapper as Record<string, unknown>).data !== 'string'
  ) {
    throw new Error('PUBLUS 1.x 配置包结构无效');
  }
  const data = (wrapper as Record<string, unknown>).data as string;
  if (data.length < 128 || (data.length - 128) % 4 !== 0) {
    throw new Error('PUBLUS 1.x 配置包长度无效');
  }
  const keyBytes = strictBase64(data.slice(0, 128), 'PUBLUS 1.x 配置密钥');
  if (keyBytes.length !== 96) throw new Error('PUBLUS 1.x 配置密钥长度无效');
  const keys: [Uint8Array, Uint8Array, Uint8Array] = [
    keyBytes.slice(0, 32),
    keyBytes.slice(32, 64),
    keyBytes.slice(64, 96),
  ];
  const payload = strictBase64(data.slice(128), 'PUBLUS 1.x 配置正文');
  const filenameKey = new TextEncoder().encode('configuration_pack.json');

  transformPublusV1Chunk(0, payload, keys);
  const ksaBytes = createRc4State(concatenateBytes(keys[1], filenameKey, keys[2]));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= ksaBytes[index & 0xff]!;
  applyReverseRc4(
    payload,
    concatenateBytes(filenameKey, keys[0], keys[1]),
    (payload.length | 1) - 2,
  );
  applyReverseRc4(
    payload,
    concatenateBytes(keys[2], filenameKey, keys[0]),
    (payload.length - 1) & -2,
  );
  mixPublusV1Columns(payload, keys);
  keys[2] = rc4Crypt(keys[2], concatenateBytes(keys[1], keys[0], filenameKey));
  keys[1] = rc4Crypt(keys[1], concatenateBytes(keys[0], filenameKey, keys[2]));
  keys[0] = rc4Crypt(keys[0], concatenateBytes(filenameKey, keys[2], keys[1]));
  transformPublusV1Chunk(1, payload, keys);
  transformPublusV1Chunk(2, payload, keys);
  transformPublusV1Chunk(3, payload, keys);
  applyForwardRc4(payload, concatenateBytes(keys[2], keys[1], filenameKey));

  const decodedText = new TextDecoder().decode(payload);
  let configuration: unknown;
  try {
    configuration = JSON.parse(decodedText) as unknown;
  } catch {
    throw new Error('PUBLUS 1.x 解包内容不是有效 JSON');
  }
  return { configuration, keys };
}

const xorShiftTriples = [
  [1, 3, 10], [1, 5, 16], [1, 5, 19], [1, 9, 29], [1, 11, 6], [1, 11, 16],
  [1, 19, 3], [1, 21, 20], [1, 27, 27], [2, 5, 15], [2, 5, 21], [2, 7, 7],
  [2, 7, 9], [2, 7, 25], [2, 9, 15], [2, 15, 17], [2, 15, 25], [2, 21, 9],
  [3, 1, 14], [3, 3, 26], [3, 3, 28], [3, 3, 29], [3, 5, 20], [3, 5, 22],
  [3, 5, 25], [3, 7, 29], [3, 13, 7], [3, 23, 25], [3, 25, 24], [3, 27, 11],
  [4, 3, 17], [4, 3, 27], [4, 5, 15], [5, 3, 21], [5, 7, 22], [5, 9, 7],
  [5, 9, 28], [5, 9, 31], [5, 13, 6], [5, 15, 17], [5, 17, 13], [5, 21, 12],
  [5, 27, 8], [5, 27, 21], [5, 27, 25], [5, 27, 28], [6, 1, 11], [6, 3, 17],
  [6, 17, 9], [6, 21, 7], [6, 21, 13], [7, 1, 9], [7, 1, 18], [7, 1, 25],
  [7, 13, 25], [7, 17, 21], [7, 25, 12], [7, 25, 20], [8, 7, 23], [8, 9, 23],
  [9, 5, 14], [9, 5, 25], [9, 11, 19], [9, 21, 16], [10, 9, 21], [10, 9, 25],
  [11, 7, 12], [11, 7, 16], [11, 17, 13], [11, 21, 13], [12, 9, 23], [13, 3, 17],
  [13, 3, 27], [13, 5, 19], [13, 17, 15], [14, 1, 15], [14, 13, 15], [15, 1, 29],
  [17, 15, 20], [17, 15, 23], [17, 15, 26],
] as const;

const xorShiftFunctions = [
  (value: number, a: number, b: number, c: number) => {
    value ^= value << a;
    value ^= value >>> b;
    return value ^ (value << c);
  },
  (value: number, a: number, b: number, c: number) => {
    value ^= value << c;
    value ^= value >>> b;
    return value ^ (value << a);
  },
  (value: number, a: number, b: number, c: number) => {
    value ^= value >>> a;
    value ^= value << b;
    return value ^ (value >>> c);
  },
  (value: number, a: number, b: number, c: number) => {
    value ^= value >>> c;
    value ^= value << b;
    return value ^ (value >>> a);
  },
  (value: number, a: number, b: number, c: number) => {
    value ^= value << a;
    value ^= value << c;
    return value ^ (value >>> b);
  },
  (value: number, a: number, b: number, c: number) => {
    value ^= value >>> a;
    value ^= value >>> c;
    return value ^ (value << b);
  },
] as const;

class PublusV1Random {
  private state = 2_463_534_242;
  private triple: readonly [number, number, number] = xorShiftTriples[74]!;
  private transform = xorShiftFunctions[0];

  configure(tripleIndex: number, transformIndex: number): void {
    const triple = xorShiftTriples[tripleIndex];
    const transform = xorShiftFunctions[transformIndex];
    if (!triple || !transform) throw new Error('PUBLUS 1.x PRNG profile 无效');
    this.triple = triple;
    this.transform = transform;
    this.state = 2_463_534_242;
  }

  seed(value: number): void {
    this.state = value >>> 0 || 2_463_534_242;
  }

  next(limit: number): number {
    if (limit <= 1) return 0;
    const rejectionLimit = 0xffff_ffff - limit;
    let value: number;
    let result: number;
    do {
      this.state = this.transform(this.state, ...this.triple) >>> 0;
      value = this.state - 1;
      result = value % limit;
    } while (rejectionLimit < value - result);
    return result;
  }
}

function xorKeys(keys: PublusV1Keys): Uint8Array {
  const combined = new Uint8Array(32);
  for (const key of keys) {
    for (let index = 0; index < Math.min(32, key.length); index += 1) {
      combined[index] ^= key[index]!;
    }
  }
  return combined;
}

function encodeNumericFileName(fileName: string): string {
  const value = Number.parseInt(fileName, 10);
  if (Number.isSafeInteger(value) && value >= 0 && value <= 0x10_0000_0000_0000) {
    const hexadecimal = value.toString(16);
    return `${hexadecimal.length.toString(16)}${hexadecimal}`;
  }
  return `0${fileName}`;
}

export function createPublusV1ImagePath(
  file: string,
  fileName: string,
  imageType: string,
  keys: PublusV1Keys,
): string {
  const combinedKey = xorKeys(keys);
  const message = `${file}/${fileName}`;
  const messageBytes = new Uint8Array((1 + message.length) * 2);
  messageBytes[0] = 0;
  messageBytes[1] = 59;
  for (let index = 0; index < message.length; index += 1) {
    const code = message.charCodeAt(index);
    messageBytes[2 + index * 2] = code >>> 8;
    messageBytes[3 + index * 2] = code & 0xff;
  }

  let rounds = 3;
  for (
    let covered = fileName.length * 2 + messageBytes.length * 2;
    covered < 256;
    covered += messageBytes.length
  ) {
    rounds += 1;
  }
  let high = 1_670_739;
  let middle = 1_282_576;
  let low = 2_237_221;
  let keyIndex = 0;
  let offset = (1 + `${file}/`.length) * 2;
  for (let round = 0; round < rounds; round += 1, offset = 0) {
    for (; offset < messageBytes.length; offset += 1) {
      low ^= messageBytes[offset]! ^ combinedKey[keyIndex]!;
      const lowProduct = 435 * low;
      const middleProduct = 435 * middle + ((low & 7) << 18) + (lowProduct >>> 22);
      const highProduct = 435 * high
        + ((middle & 3) << 19)
        + ((low & 4_194_296) >>> 3)
        + (middleProduct >>> 21);
      low = lowProduct & 4_194_303;
      middle = middleProduct & 2_097_151;
      high = highProduct & 2_097_151;
      keyIndex = (keyIndex + 1) % combinedKey.length;
    }
  }
  const digest = Uint8Array.of(
    high >>> 13,
    (high >>> 5) & 0xff,
    ((high & 31) << 3) | (middle >>> 18),
    (middle >>> 10) & 0xff,
    (middle >>> 2) & 0xff,
    ((middle & 3) << 6) | (low >>> 16),
    (low >>> 8) & 0xff,
    low & 0xff,
  );
  const hash = [...digest]
    .map((value, index) => (value ^ combinedKey[index]!).toString(16).padStart(2, '0'))
    .join('');
  return `${file}/${encodeNumericFileName(fileName)}${hash}.${imageType}`;
}

function keyByteSum(keys: PublusV1Keys): number {
  let sum = 0;
  for (const key of keys) {
    for (const value of key) sum += value;
  }
  return sum;
}

function foldKey(key: Uint8Array): number {
  let folded = 0;
  const length = Math.min(key.length & ~3, 32);
  for (let index = 0; index < length;) {
    folded ^= key[index++]! << 24;
    folded ^= key[index++]! << 16;
    folded ^= key[index++]! << 8;
    folded ^= key[index++]!;
  }
  return folded >>> 0;
}

function characterCodeSum(value: string): number {
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) sum += value.charCodeAt(index);
  return sum;
}

function createPermutation(random: (limit: number) => number, length: number): number[] {
  const result: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const replacement = random(index + 1);
    result[index] = result[replacement]!;
    result[replacement] = index;
  }
  return result;
}

function chooseBoundary(random: (limit: number) => number, size: number): number {
  return size < 4 ? random(size + 1) : random(size - 1) + 1;
}

function chooseExcept(random: (limit: number) => number, excluded: number, size: number): number {
  if (size <= 0) return 0;
  const value = random(size);
  return value < excluded ? value : value + 1;
}

function interleaveBoundaries(
  random: (limit: number) => number,
  firstSlots: number[],
  secondSlots: number[],
  firstBoundary: number,
  secondBoundary: number,
  firstLength: number,
  secondLength: number,
): void {
  let firstRemaining = firstLength;
  let secondRemaining = secondLength;
  let firstOpen = firstBoundary;
  let secondOpen = secondBoundary;
  let firstIndex = 0;
  let secondIndex = 0;
  while (firstRemaining + secondRemaining > 0) {
    const selection = random(firstRemaining + secondRemaining);
    if (selection < firstRemaining) {
      if (selection < firstOpen) {
        let start = secondIndex;
        while (start > 0 && !(firstIndex >= firstSlots[start - 1]!)) start -= 1;
        let end = secondIndex + secondRemaining;
        while (end < secondLength && !(firstIndex >= firstSlots[end]!)) end += 1;
        secondSlots[firstIndex] = random(end - start) + start;
        firstIndex += 1;
        firstOpen -= 1;
      } else {
        let start = secondIndex;
        while (start > 0 && !(firstIndex + firstRemaining <= firstSlots[start - 1]!)) start -= 1;
        let end = secondIndex + secondRemaining;
        while (end < secondLength && !(firstIndex + firstRemaining <= firstSlots[end]!)) end += 1;
        secondSlots[firstIndex + firstRemaining - 1] = random(end - start) + start;
      }
      firstRemaining -= 1;
    } else {
      if (selection - firstRemaining < secondOpen) {
        let start = firstIndex;
        while (start > 0 && !(secondIndex >= secondSlots[start - 1]!)) start -= 1;
        let end = firstIndex + firstRemaining;
        while (end < firstLength && !(secondIndex >= secondSlots[end]!)) end += 1;
        firstSlots[secondIndex] = random(end - start) + start;
        secondIndex += 1;
        secondOpen -= 1;
      } else {
        let start = firstIndex;
        while (start > 0 && !(secondIndex + secondRemaining <= secondSlots[start - 1]!)) start -= 1;
        let end = firstIndex + firstRemaining;
        while (end < firstLength && !(secondIndex + secondRemaining <= secondSlots[end]!)) end += 1;
        firstSlots[secondIndex + secondRemaining - 1] = random(end - start) + start;
      }
      secondRemaining -= 1;
    }
  }
}

function createPublusPermutation(
  initial: number,
  firstSeed: number,
  secondSeed: number,
  thirdSeed: number,
): number[] {
  const random = new PublusV1Random();
  const combinedSeed = firstSeed ^ secondSeed ^ thirdSeed;
  const initialHigh = Math.floor(initial / 65_536);
  const firstHigh = Math.floor(firstSeed / 65_536);
  const secondHigh = Math.floor(secondSeed / 65_536);
  const thirdHigh = Math.floor(thirdSeed / 65_536);
  const profileValue = (firstHigh ^ secondHigh ^ thirdHigh) >>> 16;
  const transformIndex = profileValue % xorShiftFunctions.length;
  const tripleIndex = ((profileValue - transformIndex) / xorShiftFunctions.length)
    % xorShiftTriples.length;
  random.configure(tripleIndex, transformIndex);
  random.seed(combinedSeed);
  const next = random.next.bind(random);
  const mask = next(65_536) | (next(65_536) << 16);
  let firstState = (initial ^ firstSeed ^ mask) >>> 0;
  let secondState = (initial ^ secondSeed ^ mask) >>> 0;
  let thirdState = (initial ^ thirdSeed ^ mask) >>> 0;
  const secondaryProfile = ((initialHigh ^ thirdHigh) >>> 16) ^ next(512);
  const secondaryTransform = secondaryProfile % xorShiftFunctions.length;
  const secondaryTriple = ((secondaryProfile - secondaryTransform) / xorShiftFunctions.length)
    % xorShiftTriples.length;
  random.configure(secondaryTriple, secondaryTransform);
  random.seed(firstState);
  const core = createPermutation(next, (firstHigh >>> 16) * (secondHigh >>> 16));
  random.seed(secondState);
  const firstBoundary = chooseBoundary(next, firstHigh >>> 16);
  const secondBoundary = chooseBoundary(next, secondHigh >>> 16);
  const firstAlternate = chooseExcept(next, firstBoundary, firstHigh >>> 16);
  const secondAlternate = chooseExcept(next, secondBoundary, secondHigh >>> 16);
  random.seed(thirdState);
  const firstSlots: number[] = [];
  const secondSlots: number[] = [];
  interleaveBoundaries(
    next,
    firstSlots,
    secondSlots,
    firstBoundary,
    secondBoundary,
    firstHigh >>> 16,
    secondHigh >>> 16,
  );
  const firstPermutation = createPermutation(next, firstHigh >>> 16);
  const secondPermutation = createPermutation(next, secondHigh >>> 16);
  const alternateFirstSlots: number[] = [];
  const alternateSecondSlots: number[] = [];
  interleaveBoundaries(
    next,
    alternateFirstSlots,
    alternateSecondSlots,
    firstAlternate,
    secondAlternate,
    firstHigh >>> 16,
    secondHigh >>> 16,
  );

  const firstCount = firstHigh >>> 16;
  const secondCount = secondHigh >>> 16;
  const firstStride = (firstCount + 1) * 2;
  const secondStride = (secondCount + 1) * 2;
  const result: number[] = [];
  for (let first = 0; first < firstCount; first += 1) {
    for (let second = 0; second < secondCount; second += 1) {
      const encoded = core[first + second * firstCount]!;
      const encodedColumn = encoded % firstCount;
      const encodedRow = (encoded - encodedColumn) / firstCount;
      const targetColumn = first < firstSlots[second]! ? first : first + firstCount + 1;
      const targetRow = second < secondSlots[first]! ? second : second + secondCount + 1;
      const sourceColumn = encodedColumn < alternateFirstSlots[encodedRow]!
        ? encodedColumn
        : encodedColumn + firstCount + 1;
      const sourceRow = encodedRow < alternateSecondSlots[encodedColumn]!
        ? encodedRow
        : encodedRow + secondCount + 1;
      result.push(sourceRow * firstStride + targetColumn, sourceColumn * secondStride + targetRow);
    }
  }
  result.push(secondAlternate * firstStride + firstBoundary);
  result.push(firstAlternate * secondStride + secondBoundary);
  for (let first = 0; first < firstCount; first += 1) {
    const targetColumn = first < firstBoundary ? first : first + firstCount + 1;
    const sourceColumn = firstPermutation[first]!;
    const encodedColumn = sourceColumn < firstBoundary ? sourceColumn : sourceColumn + firstCount + 1;
    result.push(alternateSecondSlots[sourceColumn]! * firstStride + targetColumn);
    result.push(encodedColumn * secondStride + secondSlots[first]!);
  }
  for (let second = 0; second < secondCount; second += 1) {
    const targetRow = second < secondBoundary ? second : second + secondCount + 1;
    const sourceRow = secondPermutation[second]!;
    const encodedRow = sourceRow < secondBoundary ? sourceRow : sourceRow + secondCount + 1;
    result.push(encodedRow * firstStride + firstSlots[second]!);
    result.push(alternateFirstSlots[sourceRow]! * secondStride + targetRow);
  }
  return result;
}

export function createPublusV1TileMoves(
  page: PublusV1PageParameters,
  keys: PublusV1Keys,
): readonly PublusV1TileMove[] {
  const sourceWidth = page.width + page.dummyWidth;
  const sourceHeight = page.height + page.dummyHeight;
  const columns = Math.floor(sourceWidth / page.blockWidth);
  const rows = Math.floor(sourceHeight / page.blockHeight);
  const remainderWidth = sourceWidth % page.blockWidth;
  const remainderHeight = sourceHeight % page.blockHeight;
  const horizontalStride = (columns + 1) * 2;
  const verticalStride = (rows + 1) * 2;
  const horizontalGap = (columns + 1) * page.blockWidth - remainderWidth;
  const verticalGap = (rows + 1) * page.blockHeight - remainderHeight;

  let seedSum = 47 + characterCodeSum(page.file) + characterCodeSum(page.fileName);
  seedSum += keyByteSum(keys);
  const repeatedByte = (seedSum & 0xff) * 0x0101_0101;
  const profile = seedSum % (xorShiftTriples.length * xorShiftFunctions.length);
  const firstSeed = (repeatedByte ^ foldKey(keys[0]) ^ page.ns) >>> 0;
  const secondSeed = (repeatedByte ^ foldKey(keys[1]) ^ page.ps) >>> 0;
  const thirdSeed = (repeatedByte ^ foldKey(keys[2]) ^ page.rs) >>> 0;

  const random = new PublusV1Random();
  const gridProfile = profile ^ columns ^ rows;
  const transformIndex = gridProfile % xorShiftFunctions.length;
  const tripleIndex = ((gridProfile - transformIndex) / xorShiftFunctions.length)
    % xorShiftTriples.length;
  random.configure(tripleIndex, transformIndex);
  random.seed(firstSeed ^ secondSeed ^ thirdSeed);
  const initial = random.next(65_536)
    + 65_536 * random.next(65_536)
    + 4_294_967_296 * random.next(512);
  const encoded = createPublusPermutation(
    initial,
    4_294_967_296 * columns + firstSeed,
    4_294_967_296 * rows + secondSeed,
    4_294_967_296 * profile + thirdSeed,
  );
  const moves: PublusV1TileMove[] = [];
  const appendMoves = (
    start: number,
    end: number,
    width: number,
    height: number,
  ): void => {
    if (width === 0 || height === 0) return;
    for (let offset = start; offset < end;) {
      const first = encoded[offset++]!;
      const second = encoded[offset++]!;
      const destinationColumn = first % horizontalStride;
      const destinationRow = second % verticalStride;
      const sourceColumn = (second - destinationRow) / verticalStride;
      const sourceRow = (first - destinationColumn) / horizontalStride;
      moves.push({
        sourceX: sourceColumn * page.blockWidth
          - (sourceColumn > columns ? horizontalGap : 0),
        sourceY: sourceRow * page.blockHeight - (sourceRow > rows ? verticalGap : 0),
        destinationX: destinationColumn * page.blockWidth
          - (destinationColumn > columns ? horizontalGap : 0),
        destinationY: destinationRow * page.blockHeight
          - (destinationRow > rows ? verticalGap : 0),
        width,
        height,
      });
    }
  };
  let start = 0;
  let end = columns * rows * 2;
  appendMoves(start, end, page.blockWidth, page.blockHeight);
  start = end;
  end += 2;
  appendMoves(start, end, remainderWidth, remainderHeight);
  start = end;
  end += columns * 2;
  appendMoves(start, end, page.blockWidth, remainderHeight);
  start = end;
  end += rows * 2;
  appendMoves(start, end, remainderWidth, page.blockHeight);
  return moves;
}
