// Bundles the PWA (web/dist/app.js). With --demo, also builds the single-file
// interactive preview (demo/dist/preview.html) that runs the real server code in the browser.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const common = { bundle: true, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact', target: ['safari16'], minify: true, legalComments: 'none', logLevel: 'warning' };

await build({ ...common, entryPoints: [path.join(root, 'web/src/main.jsx')], outfile: path.join(root, 'web/dist/app.js') });
console.log('built web/dist/app.js');

// sql.js only touches these Node modules when it runs under Node; stub them for the browser.
const nodeStub = {
  name: 'node-stub',
  setup(b) {
    b.onResolve({ filter: /^(fs|path|crypto)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  },
};

if (process.argv.includes('--demo')) {
  const out = path.join(root, 'demo/dist');
  fs.mkdirSync(out, { recursive: true });
  const r = await build({ ...common, entryPoints: [path.join(root, 'demo/demo.jsx')], write: false, loader: { '.wasm': 'binary' }, platform: 'browser', plugins: [nodeStub], define: { 'process.env.NODE_ENV': '"production"' } });
  const js = r.outputFiles[0].text;
  const css = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8');
  const icon = fs.readFileSync(path.join(root, 'web/icons/icon-192.png')).toString('base64');
  const shell = fs.readFileSync(path.join(root, 'demo/shell.html'), 'utf8');
  const html = shell
    .replace('/*__CSS__*/', () => css.replace(/url\(\/icons\/icon-192\.png\)/g, `url(data:image/png;base64,${icon})`))
    .replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'))
    .replace(/__ICON__/g, `data:image/png;base64,${icon}`);
  fs.writeFileSync(path.join(out, 'preview.html'), html);
  console.log(`built demo/dist/preview.html (${(html.length / 1024).toFixed(0)} KB)`);
}
