import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const folder = fileURLToPath(new URL('.', import.meta.url));
const expected = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('node_modules/.package-lock.json', import.meta.url), 'utf8'));
for (const name of ['morphicons', 'torph']) {
  const installed = lock.packages['node_modules/' + name];
  for (const key of ['version', 'resolved', 'integrity']) {
    assert.equal(installed?.[key], expected.runtime[name][key], `Pinned ${name} ${key} changed`);
  }
}
const notices = await Promise.all(
  ['LICENSE-morphicons.txt', 'LICENSE-torph.txt'].map(name =>
    readFile(new URL(name, import.meta.url), 'utf8'))
);
const patches = [
  ['preserve zero opacity during retarget', 'Number(getComputedStyle(e).opacity)||1', 'parseFloat(getComputedStyle(e).opacity)', 1],
  ['preserve zero opacity on departing characters', 'Number(getComputedStyle(i).opacity)||1', 'parseFloat(getComputedStyle(i).opacity)', 1],
  ['segment Han labels consistently, including spaces and Latin text',
    'function jt(e,t,n,i,r){if',
    'function jt(e,t,n,i,r){if(/\\p{Script=Han}/u.test(e))n=false;if', 1],
  ['reuse the existing LCS and ID allocator for Han labels',
    'function Lt(e,t,n,i={}){let',
    `function Lt(e,t,n,i={}){
      if(i.numbers===false&&/\\p{Script=Han}/u.test(t)){
        const segments=K(t,n,false);
        const [from,to]=G(e.map(s=>s.string),segments.map(s=>s.string));
        const matches=new Map(to.map((index,k)=>[index,e[from[k]]]));
        const ids=yt();
        for(const segment of e)ids.reserve(segment.id);
        return {segments:segments.map((segment,index)=>({...segment,id:matches.get(index)?.id??ids.take(segment.id)})),splits:new Map};
      }
      let`, 1],
  ['respect scale:false for departing groups',
    'let E=this.isInitialRender?[]:It(f,new Set(m))',
    'let E=this.isInitialRender||!this.options.scale?[]:It(f,new Set(m))', 1],
  ['respect scale:false for entering groups',
    'for(let l of It(a,u))', 'for(let l of this.options.scale?It(a,u):[])', 1],
];
const result = await build({
  absWorkingDir: folder,
  entryPoints: ['entry.mjs'],
  outfile: 'motion-kit.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  minify: false,
  legalComments: 'inline',
  metafile: true,
  plugins: [{
    name: 'torph-small-button-adaptations',
    setup(builder) {
      builder.onLoad({ filter: /node_modules[\\/]torph[\\/]dist[\\/]index\.mjs$/ }, async ({ path }) => {
        let contents = await readFile(path, 'utf8');
        for (const [name, before, after, count] of patches) {
          assert.equal(contents.split(before).length - 1, count, `Pinned Torph patch changed: ${name}`);
          contents = contents.replaceAll(before, after);
        }
        return { contents, loader: 'js' };
      });
    },
  }],
  banner: { js: '/*! Official morphicons@1.7.1 and torph@0.1.3.\n' +
    notices.map(text => text.replace(/\*\//g, '* /')).join('\n') + '*/' },
});
const bundle = await readFile(new URL('motion-kit.js', import.meta.url));
const manifest = {
  output: 'motion-kit.js',
  sha256: createHash('sha256').update(bundle).digest('hex'),
  bytes: bundle.length,
  runtime: Object.fromEntries(['morphicons', 'torph'].map(name => {
    const info = lock.packages['node_modules/' + name];
    return [name, { version: info.version, resolved: info.resolved, integrity: info.integrity }];
  })),
  reviewedSource: {
    morphicons: 'https://github.com/guillermolg00/morphicons/tree/38d2a7221633a453eeafebd872ee3649b9274b22',
    torph: 'https://github.com/lochie/torph/tree/d79a5aa63226acf97d49c3e34fafb2e85c07b026',
  },
  inputs: Object.keys(result.metafile.inputs),
  adaptations: patches.map(([name]) => name),
};
await writeFile(new URL('manifest.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
console.log('Built offline browser ESM: ' + bundle.length + ' bytes; sha256 ' + manifest.sha256);
