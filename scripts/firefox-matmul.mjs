// ponytail: match pinned ORT matrix kernels only; revalidate after ORT upgrades or Firefox's zeroing fix.
export function directReadTransform(original) {
  const fail = message => { throw new Error(message); };
  const norm = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s/g, '');
  const compact = norm(original);
  const require = (condition, message) => { if (!condition) fail(message); };
  const one = (text, pattern, message) => {
    const matches = [...text.matchAll(pattern)]; require(matches.length === 1, message); return matches[0];
  };
  const splitArguments = call => {
    const args = []; let depth = 0, start = call.indexOf('(') + 1;
    for (let i = start; i < call.length - 1; i++) {
      if ('(['.includes(call[i])) depth++;
      if (')]'.includes(call[i])) depth--;
      if (call[i] === ',' && depth === 0) { args.push(call.slice(start, i).trim()); start = i + 1; }
    }
    args.push(call.slice(start, -1).trim()); return args;
  };
  const indexEnd = (code, start) => {
    let depth = 1, end = start + 1;
    require(code[start] === '[', 'Expected two-dimensional tile access');
    for (; depth && end < code.length; end++) { if (code[end] === '[') depth++; if (code[end] === ']') depth--; }
    require(depth === 0, 'Unbalanced tile access'); return end;
  };
  const bounded = (expr, limit) => `i32(min(u32(${expr}), ${limit - 1}u))`;
  try {
    require((compact.match(/@compute/g) ?? []).length === 1, 'Expected one compute entry point');
    require(!/\b(?:atomic\w*|storageBarrier|textureBarrier)\s*\(/.test(original), 'Additional synchronization is unsupported');
    require(!/\bffDirect_/.test(original), 'Shader already transformed');
    const declarations = [...original.matchAll(/var\s*<\s*workgroup\s*>\s+(mm_Asub|mm_Bsub)\s*:\s*array\s*<\s*array\s*<\s*(f(?:32|16)|vec[34]\s*<\s*f(?:32|16)\s*>)\s*,\s*(\d+)\s*>\s*,\s*(\d+)\s*>\s*;/g)];
    require(declarations.length === 2 && new Set(declarations.map(d => d[1])).size === 2, 'Expected the two original ORT shared tiles');
    const tiles = Object.fromEntries(declarations.map(d => [d[1], { type: d[2].replace(/\s/g, ''),
      components: Number(/^vec([34])/.exec(d[2])?.[1] ?? 1), rows: Number(d[4]), cols: Number(d[3]) }]));
    const a = tiles.mm_Asub, b = tiles.mm_Bsub;
    const constant = name => Number(one(original, new RegExp(`\\bconst\\s+${name}\\s*=\\s*(\\d+)\\s*;`, 'g'), `Missing literal ${name}`)[1]);
    const rowPerThread = constant('rowPerThread'), colPerThread = constant('colPerThread'), tileInner = constant('tileInner');
    const wg = one(original, /@workgroup_size\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g, 'Unknown workgroup size');
    const wx = Number(wg[1]), wy = Number(wg[2]); require(Number(wg[3]) === 1, 'Unsupported workgroup z');
    const vector = a.components !== 1, sequential = compact.includes('letlocalCol=i32(localId.x);');
    require(a.rows === wy * rowPerThread && b.rows === tileInner && a.cols * a.components === tileInner,
      'Unknown/non-full/possibly transposed A tile geometry');
    require(vector ? b.components === 4 && b.cols === wx && colPerThread === 4 && a.cols === wx
      : b.components === 1 && b.cols === wx * colPerThread, 'Unknown B tile geometry');
    require(!vector || constant('innerElementSize') === a.components, 'Unknown vector packing');
    const loop = one(original, /for\s*\(\s*var\s+t\s*=\s*0\s*;\s*t\s*<\s*num_tiles\s*;\s*t\s*=\s*t\s*\+\s*1\s*\)\s*\{/g, 'Unknown tile loop');
    const increment = one(original, /\bkStart\s*=\s*kStart\s*\+\s*tileInner\s*;/g, 'Unknown tile advancement');
    const loadStart = loop.index + loop[0].length, loadEnd = increment.index;
    require(loadEnd > loadStart, 'Tile advancement precedes loads');
    const loads = original.slice(loadStart, loadEnd), loadCompact = norm(loads);
    const loadA = one(loads, /mm_Asub\s*\[\s*inputRow\s*\]\s*\[\s*inputCol\s*\]\s*=\s*(mm_readA\([^;]+\))\s*;/g, 'Unknown A load');
    const loadB = one(loads, /mm_Bsub\s*\[\s*inputRow\s*\]\s*\[\s*inputCol\s*\]\s*=\s*(mm_readB\([^;]+\))\s*;/g, 'Unknown B load');
    const aa = splitArguments(loadA[1]), ba = splitArguments(loadB[1]);
    require(aa.length === ba.length && [3, 4].includes(aa.length) && aa[0] === 'batch' && ba[0] === 'batch'
      && (aa.length === 3 || aa[3] === 'batchIndices' && ba[3] === 'batchIndices'), 'Unknown batch arguments');
    require(norm(aa[1]) === (vector ? 'globalRow+innerRow' : 'globalRowStart+inputRow')
      && norm(aa[2]) === (vector ? 'kStart/innerElementSize+inputCol' : 'kStart+inputCol'), 'Unknown or transposed A load coordinates');
    require(norm(ba[1]) === 'kStart+inputRow' && norm(ba[2]) === (vector ? 'globalCol'
      : sequential ? 'globalColStart+inputCol' : 'globalCol+innerCol'), 'Unknown B load coordinates');
    const storeA = norm(loadA[0]), storeB = norm(loadB[0]);
    let expectedLoads;
    if (vector) {
      require(!sequential && tileInner % wy === 0, 'Unknown vector loading topology');
      expectedLoads = `for(varinnerRow=0;innerRow<rowPerThread;innerRow=innerRow+1){letinputRow=tileRow+innerRow;letinputCol=tileCol;${storeA}}`
        + `for(varinnerRow=0;innerRow<${tileInner / wy};innerRow=innerRow+1){letinputRow=tileRowB+innerRow;letinputCol=tileCol;${storeB}}`;
    } else if (sequential) {
      expectedLoads = `for(varinputRow=localRow;inputRow<${a.rows};inputRow=inputRow+${wy}){for(varinputCol=localCol;inputCol<${a.cols};inputCol=inputCol+${wx}){${storeA}}}`
        + `for(varinputRow=localRow;inputRow<${b.rows};inputRow=inputRow+${wy}){for(varinputCol=localCol;inputCol<${b.cols};inputCol=inputCol+${wx}){${storeB}}}`;
    } else {
      require(a.cols % wx === 0 && tileInner % wy === 0, 'Unknown scalar loading topology');
      expectedLoads = `for(varinnerRow=0;innerRow<${a.rows / wy};innerRow=innerRow+1){for(varinnerCol=0;innerCol<${a.cols / wx};innerCol=innerCol+1){letinputRow=tileRowA+innerRow;letinputCol=tileColA+innerCol;${storeA}}}`
        + `for(varinnerRow=0;innerRow<${b.rows / wy};innerRow=innerRow+1){for(varinnerCol=0;innerCol<colPerThread;innerCol=innerCol+1){letinputRow=tileRowB+innerRow;letinputCol=tileCol+innerCol;${storeB}}}`;
    }
    require(loadCompact === expectedLoads, 'Load region contains an unknown operation');
    const mainAt = original.indexOf('fn main('), prologue = norm(original.slice(mainAt, loop.index));
    require(mainAt >= 0 && ['@builtin(local_invocation_id)localId:vec3<u32>', '@builtin(global_invocation_id)globalId:vec3<u32>',
      '@builtin(workgroup_id)workgroupId:vec3<u32>'].every(value => prologue.includes(value)), 'Unknown entry point builtins');
    const mainCompact = norm(original.slice(mainAt));
    require((mainCompact.match(/(?:let|var)batch=/g) ?? []).length === 1
      && (mainCompact.match(/(?:let|var)globalRowStart=/g) ?? []).length === 1
      && (mainCompact.match(/kStart(?:=|[+*/%-]=)/g) ?? []).length === 2
      && (aa.length === 3 || (mainCompact.match(/(?:let|var)batchIndices=/g) ?? []).length === 1)
      && !/(?:var|const)(?:batch|batchIndices|globalRowStart)=|kStart(?:\+\+|--)/.test(mainCompact)
      && !/(?:let|var|const)(?:workgroupId|tileInner|innerElementSize)=/.test(mainCompact), 'Unknown coordinate mutation/shadowing');
    // Direct reads must not multiply side effects or consult mutable GPU globals.
    const mutable = [...original.matchAll(/var\s*<\s*(?:storage\s*,\s*read_write|workgroup|private)\s*>\s+(\w+)/g)].map(m => m[1]);
    const functions = new Map();
    for (const fn of original.matchAll(/\bfn\s+(\w+)\s*\(/g)) {
      const start = original.indexOf('{', fn.index); let end = start + 1, depth = 1;
      for (; depth && end < original.length; end++) { if (original[end] === '{') depth++; if (original[end] === '}') depth--; }
      require(start >= 0 && depth === 0, 'Unknown helper function'); functions.set(fn[1], original.slice(start + 1, end - 1));
    }
    const pending = ['mm_readA', 'mm_readB'], checked = new Set();
    while (pending.length) {
      const name = pending.pop(); if (checked.has(name)) continue; checked.add(name);
      require(functions.has(name), `Missing ${name}`); const body = functions.get(name), bodyCompact = norm(body);
      require(!mutable.some(global => new RegExp(`\\b${global}\\b`).test(body))
        && !/\b(?:atomic\w*|textureStore|workgroupUniformLoad|workgroupBarrier|storageBarrier)\s*\(/.test(bodyCompact), 'Read helper has mutable GPU state or side effects');
      for (const call of body.matchAll(/\b(\w+)\s*\(/g)) if (functions.has(call[1])) pending.push(call[1]);
    }
    const definitions = [`letglobalRowStart=i32(workgroupId.y)*${a.rows};`];
    if (vector) definitions.push('letlocalRow=i32(localId.y);', 'lettileRow=localRow*rowPerThread;', 'lettileCol=i32(localId.x);',
      'letglobalRow=i32(globalId.y)*rowPerThread;', 'letglobalCol=i32(globalId.x);', `lettileRowB=localRow*${tileInner / wy};`);
    else if (sequential) definitions.push('letlocalRow=i32(localId.y);', 'letlocalCol=i32(localId.x);', `letglobalColStart=i32(workgroupId.x)*${b.cols};`);
    else definitions.push('lettileRow=i32(localId.y)*rowPerThread;', 'lettileCol=i32(localId.x)*colPerThread;',
      'letglobalRow=i32(globalId.y)*rowPerThread;', 'letglobalCol=i32(globalId.x)*colPerThread;',
      `lettileRowA=i32(localId.y)*${a.rows / wy};`, `lettileColA=i32(localId.x)*${a.cols / wx};`, `lettileRowB=i32(localId.y)*${b.rows / wy};`);
    require(definitions.every(value => prologue.includes(value)), 'Unknown global/local coordinate definitions');
    require((original.match(/\bworkgroupBarrier\s*\(\s*\)\s*;/g) ?? []).length === 2, 'Unknown barrier topology');
    let code = original.slice(0, loadStart) + '\n' + original.slice(loadEnd);
    code = code.replace(/var\s*<\s*workgroup\s*>\s+mm_[AB]sub\s*:\s*array\s*<\s*array\s*<\s*(?:f(?:32|16)|vec[34]\s*<\s*f(?:32|16)\s*>)\s*,\s*\d+\s*>\s*,\s*\d+\s*>\s*;/g, '');
    require(!/var\s*<\s*workgroup\s*>/.test(code), 'Another workgroup variable requires synchronization');
    const edits = [], refs = /\bmm_([AB])sub\b/g; let match;
    while ((match = refs.exec(code))) {
      let at = match.index + match[0].length; while (/\s/.test(code[at] ?? '') && at < code.length) at++;
      const rowEnd = indexEnd(code, at), row = code.slice(at + 1, rowEnd - 1).trim(); at = rowEnd;
      while (/\s/.test(code[at] ?? '') && at < code.length) at++;
      const colEnd = indexEnd(code, at), col = code.slice(at + 1, colEnd - 1).trim();
      require([row, col].every(expr => /^[\w\s.+*/%()-]+$/.test(expr) && !/\b[A-Za-z_]\w*\s*\(/.test(expr)), 'Unknown read index expression');
      require(!/^\s*(?:=|[+*/%-]=|\+\+|--)/.test(code.slice(colEnd)), 'Unexpected remaining tile write');
      const tile = match[1] === 'A' ? a : b, r = bounded(row, tile.rows), c = bounded(col, tile.cols);
      const extra = aa.length === 4 ? ', batchIndices' : '';
      const replacement = match[1] === 'A'
        ? `mm_readA(batch, globalRowStart + (${r}), (kStart - tileInner)${vector ? ' / innerElementSize' : ''} + (${c})${extra})`
        : `mm_readB(batch, kStart - tileInner + (${r}), i32(workgroupId.x) * ${b.cols} + (${c})${extra})`;
      edits.push({ start: match.index, end: colEnd, replacement, tile: match[1], row, col });
      refs.lastIndex = colEnd;
    }
    require(edits.some(edit => edit.tile === 'A') && edits.some(edit => edit.tile === 'B'), 'Missing tile reads');
    for (const edit of [...edits].reverse()) code = code.slice(0, edit.start) + edit.replacement + code.slice(edit.end);
    code = code.replace(/\bworkgroupBarrier\s*\(\s*\)\s*;/g, '');
    require(!/\bmm_[AB]sub\b/.test(norm(code)), 'Unconverted tile reference');
    return { code, changed: true, kind: vector ? `packed-vec${a.components}` : sequential ? 'sequential-scalar' : 'packed-scalar',
      geometry: { a, b, wx, wy, rowPerThread, colPerThread, tileInner },
      loads: { a: aa, b: ba }, reads: edits.map(({ tile, row, col }) => ({ tile, row, col })) };
  } catch (error) { return { code: original, changed: false, reason: error.message }; }
}
