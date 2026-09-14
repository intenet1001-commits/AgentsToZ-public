import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const root = import.meta.dir;
const argument = process.argv.slice(2).filter(value => value !== '--')[0];
if (!argument || !isAbsolute(argument)) throw new Error('Usage: bun run sdk:export -- /absolute/output/folder');
const destination = resolve(argument);
if (destination === root || destination.startsWith(root + '/')) throw new Error('Export outside the app checkout.');
// Refuse to overwrite an existing SDK release. Export a new version to a fresh directory.
if (existsSync(destination)) throw new Error('Output already exists. Use a fresh release folder; never overwrite a version.');
const entries = ['packages/runtime-sdk/index.ts', 'packages/runtime-sdk/client.ts'];
const sourceFiles = new Set<string>();
function collect(file: string): void {
  if (sourceFiles.has(file)) return;
  if (!file.startsWith('src/') && !file.startsWith('packages/runtime-sdk/')) throw new Error(`Unexpected dependency: ${file}`);
  const text = readFileSync(join(root, file), 'utf8');
  sourceFiles.add(file);
  const node = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(child: ts.Node): void {
    let specifier: string | undefined;
    if ((ts.isImportDeclaration(child) || ts.isExportDeclaration(child)) && child.moduleSpecifier && ts.isStringLiteral(child.moduleSpecifier)) specifier = child.moduleSpecifier.text;
    if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword && child.arguments[0] && ts.isStringLiteral(child.arguments[0])) specifier = child.arguments[0].text;
    if (specifier?.startsWith('.')) {
      const base = resolve(root, dirname(file), specifier);
      const path = [base, base + '.ts', base + '.tsx', join(base, 'index.ts')].find(path => existsSync(path));
      if (!path) throw new Error(`Unresolved dependency: ${file}: ${specifier}`);
      collect(relative(root, path));
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
}
entries.forEach(collect);
const metadata = JSON.parse(readFileSync(join(root, 'packages/runtime-sdk/package.json'), 'utf8'));
mkdirSync(destination, { recursive: true });
for (const file of sourceFiles) {
  const target = join(destination, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, file), target);
}
for (const name of ['package.json', 'README.md', 'CHANGELOG.md']) copyFileSync(join(root, 'packages/runtime-sdk', name), join(destination, name));
writeFileSync(join(destination, '.gitignore'), 'node_modules/\ndist/\n');
const declarationConfig = {
  compilerOptions: { target: 'ESNext', module: 'Preserve', moduleResolution: 'bundler', strict: true, skipLibCheck: true, declaration: true, emitDeclarationOnly: true, outDir: './dist/types', rootDir: '.', types: ['bun'], lib: ['ESNext', 'DOM'], noUncheckedIndexedAccess: true },
  files: entries,
};
writeFileSync(join(destination, 'tsconfig.json'), JSON.stringify(declarationConfig, null, 2) + '\n');
const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root });
if (commit.exitCode !== 0) throw new Error('Cannot record source revision.');
const manifest = {
  schemaVersion: 1, sdkVersion: metadata.version, sourceCommit: commit.stdout.toString().trim(),
  files: Object.fromEntries([...sourceFiles].sort().map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')])),
};
writeFileSync(join(destination, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const [entry, target] of [[entries[0]!, 'bun'], [entries[1]!, 'browser']] as const) {
  const result = await Bun.build({ entrypoints: [join(destination, entry)], target, outdir: join(destination, 'dist'), external: ['@tauri-apps/api/core'], packages: 'external' });
  if (!result.success) throw new Error(result.logs.map(String).join('\n'));
}
// Resolve type dependencies from the source checkout for this initial export without copying node_modules.
const initialConfig = { ...declarationConfig, compilerOptions: { ...declarationConfig.compilerOptions, typeRoots: [join(root, 'node_modules/@types')], baseUrl: root, paths: { '@tauri-apps/api/*': ['node_modules/@tauri-apps/api/*'] } } };
const tempConfig = join(destination, '.initial-types.json');
writeFileSync(tempConfig, JSON.stringify(initialConfig));
const typecheck = Bun.spawnSync([join(root, 'node_modules/.bin/tsc'), '-p', tempConfig], { cwd: destination, stdout: 'pipe', stderr: 'pipe' });
const { unlinkSync } = await import('node:fs');
unlinkSync(tempConfig);
if (typecheck.exitCode !== 0) throw new Error(typecheck.stdout.toString() + typecheck.stderr.toString());
console.log(`Exported ${metadata.name}@${metadata.version}: ${destination} (${sourceFiles.size} source files)`);
