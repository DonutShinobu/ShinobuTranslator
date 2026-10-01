import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { Script } from 'node:vm';
import ts from 'typescript';
import { chromium } from '@playwright/test';

// Root runs this gate serially. Compile actual helper/scale code, without models
// or an extension build. These are quality checks, not full-flow speed samples.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const imageSource = source('../../../packages/image-pipeline/src/pipeline/image.ts');
const detectSource = source('../../../packages/image-pipeline/src/pipeline/detect/onnxDetect.ts');
const ast = ts.createSourceFile('onnxDetect.ts', detectSource, ts.ScriptTarget.ES2022, true);
const functions = ['scaleMaskToOriginal', 'markDetectorPostprocess'];
const found = new Map<string, string>();
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name && functions.includes(node.name.text)) {
    found.set(node.name.text, node.getText(ast));
  }
  ts.forEachChild(node, collect);
}
collect(ast);
if (found.size !== functions.length) throw new Error('Actual detector scale functions changed');
const code = ts.transpileModule(`${imageSource}\n${functions.map(name => found.get(name)).join('\n')}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^export\s+/gm, '')
  + '\nglobalThis.nativeMaskGate={tryNativeOpaqueMaskThreshold,scaleMaskToOriginal};';
const gateSource = `(async () => {
  const {tryNativeOpaqueMaskThreshold,scaleMaskToOriginal}=globalThis.nativeMaskGate;
  const marks=[];globalThis.__shinobuColdStartInitMark=record=>marks.push(record);
  const platform={createCanvas:(width,height)=>{const c=document.createElement('canvas');c.width=width;c.height=height;return c;}};
  const checks=[];
  function release(canvas){canvas.width=0;canvas.height=0;}
  function rgba(canvas){return canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;}
  function equal(a,b,label){if(a.length!==b.length)throw Error(label+': length');for(let i=0;i<a.length;i++)if(a[i]!==b[i])throw Error(label+': byte '+i+' '+a[i]+' != '+b[i]);}
  async function sha(data){const digest=await crypto.subtle.digest('SHA-256',data);return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');}
  function cpuThreshold(bytes){const data=new Uint8ClampedArray(bytes);for(let p=0;p<data.length;p+=4){const v=data[p]>127?255:0;data[p]=v;data[p+1]=v;data[p+2]=v;data[p+3]=255;}return data;}
  function binaryRgba(data){for(let p=0;p<data.length;p+=4){if(data[p]!==data[p+1]||data[p]!==data[p+2]||(data[p]!==0&&data[p]!==255)||data[p+3]!==255)throw Error('Output is not opaque binary gray at '+p);}}
  function grayCanvas(width,height,cpu,pixel){
    const canvas=platform.createCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:cpu,colorSpace:'srgb',colorType:'unorm8'});
    const image=ctx.createImageData(width,height);
    for(let i=0,p=0;i<width*height;i++,p+=4){const v=pixel(i);image.data[p]=v;image.data[p+1]=v;image.data[p+2]=v;image.data[p+3]=255;}
    ctx.putImageData(image,0,0);return {canvas,expectedSource:image.data};
  }
  function targetAttrs(canvas,gpu){
    const attrs=canvas.getContext('2d').getContextAttributes();
    if(attrs.willReadFrequently!==!gpu||attrs.colorSpace!=='srgb'||attrs.colorType!=='unorm8')throw Error('Requested target strategy did not execute: '+JSON.stringify(attrs));
    return attrs;
  }
  // Do not read the native source context until after native draw. The byte oracle
  // is the ImageData uploaded to it; direct gray and resized cases cover alpha255.
  for(const gpuTarget of [false,true])for(const cpuSource of [false,true]){
    const {canvas,expectedSource}=grayCanvas(256,4,cpuSource,i=>i%256),expected=cpuThreshold(expectedSource);
    globalThis.__shinobuColdStartMaskNativeThreshold=true;
    globalThis.__shinobuColdStartMaskNativeThresholdGpu=gpuTarget;
    const native=tryNativeOpaqueMaskThreshold(canvas,platform);if(!native)throw Error('Native helper did not run on srgb/unorm8');
    const attrs=targetAttrs(native,gpuTarget),actual=rgba(native);
    equal(expected,actual,'all 256 integer levels');equal(expectedSource,rgba(canvas),'source unchanged');binaryRgba(actual);
    checks.push({kind:'all-gray-levels',cpuSource,gpuTarget,width:256,height:4,sha256:await sha(actual),targetAttrs:attrs,sourceAttrs:canvas.getContext('2d').getContextAttributes()});
    release(native);release(canvas);
  }
  const sizes=[[1,1,1,1],[2,2,17,23],[5,7,47,61],[73,41,299,179],[129,181,773,1107],[730,1024,2921,4096]];
  for(const gpuTarget of [false,true])for(const cpuSource of [false,true])for(const [width,height,destWidth,destHeight]of sizes){
    let seed=(0x2fe813a9^width^(height<<16))>>>0;
    const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
    const {canvas:baselineSource,expectedSource}=grayCanvas(width,height,cpuSource,i=>((random()%13<3)||(i%width===Math.floor(width/2)))?255:0);
    const {canvas:nativeSource}=grayCanvas(width,height,cpuSource,i=>expectedSource[i*4]);
    const image={naturalWidth:destWidth,naturalHeight:destHeight};
    globalThis.__shinobuColdStartMaskPacked=true;globalThis.__shinobuColdStartMaskNativeThreshold=false;
    globalThis.__shinobuColdStartMaskNativeThresholdGpu=gpuTarget;
    const baseline=scaleMaskToOriginal(baselineSource,image,platform),expected=rgba(baseline);
    const markStart=marks.length;globalThis.__shinobuColdStartMaskNativeThreshold=true;
    const native=scaleMaskToOriginal(nativeSource,image,platform);
    if(!marks.slice(markStart).some(x=>x.phase==='mask.native-threshold'&&x.status==='success'))throw Error('Scale path silently fell back');
    const attrs=targetAttrs(native,gpuTarget),actual=rgba(native);
    equal(expected,actual,'actual detector scale '+width+'x'+height+'->'+destWidth+'x'+destHeight);binaryRgba(actual);
    equal(expectedSource,rgba(baselineSource),'baseline binary source unchanged');equal(expectedSource,rgba(nativeSource),'native binary source unchanged');
    checks.push({kind:'actual-detector-scale',cpuSource,gpuTarget,width,height,destWidth,destHeight,sha256:await sha(actual),targetAttrs:attrs});
    release(baseline);release(native);release(baselineSource);release(nativeSource);
  }
  const fallbackChecks=[];
  for(const gpuTarget of [false,true]){
    globalThis.__shinobuColdStartMaskNativeThreshold=true;globalThis.__shinobuColdStartMaskNativeThresholdGpu=gpuTarget;
    const p3=platform.createCanvas(1,1);p3.getContext('2d',{colorSpace:'display-p3',willReadFrequently:true});
    const attrs=p3.getContext('2d').getContextAttributes();
    if(attrs.colorSpace!=='display-p3')throw Error('P3 guard case unsupported in test browser');
    if(tryNativeOpaqueMaskThreshold(p3,platform)!==null)throw Error('P3 did not retain CPU fallback');
    fallbackChecks.push({kind:'p3-fallback',gpuTarget,attrs});release(p3);
  }
  delete globalThis.__shinobuColdStartInitMark;delete globalThis.__shinobuColdStartMaskNativeThreshold;delete globalThis.__shinobuColdStartMaskNativeThresholdGpu;delete globalThis.__shinobuColdStartMaskPacked;
  return {browser:navigator.userAgent,checks,fallbackChecks,allRgbaBytesIdentical:true,alpha:'source and output all 255, checked each pixel',nativeSuccesses:marks.filter(x=>x.phase==='mask.native-threshold'&&x.status==='success').length,
    caveat:'Native quality gate with no models; willReadFrequently is a backend hint, not a guarantee of GPU acceleration. Normal complete extension timing must be measured separately'};
})()`;
if (process.argv.includes('--syntax-only')) {
  new Script(code, { filename: 'actual-native-threshold.js' });
  new Script(gateSource, { filename: 'native-threshold-gate.js' });
  console.log(JSON.stringify({ syntax: 'passed', nativeChecks: 28, fallbackChecks: 2, noBrowser: true }));
  process.exit(0);
}
const executablePath = process.argv.find(arg => arg.startsWith('--browser-executable='))?.slice('--browser-executable='.length)
  || process.env.COLD_BUDGET_BROWSER || chromium.executablePath();
const server = createServer((request, response) => {
  if (request.url === '/threshold.js') {
    response.setHeader('Content-Type', 'application/javascript'); response.end(code);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Native mask threshold quality gate</title><script src="/threshold.js"></script>');
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Native gate server unavailable');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath, headless: false });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(gateSource);
  const out = process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length);
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2)); }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
