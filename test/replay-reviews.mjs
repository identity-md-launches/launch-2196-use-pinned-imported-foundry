// Re-run the accepted review programs while confining generated files to test/.
// No live transaction is sent: local/fork writers are fixed to loopback by the
// original programs. "protocol" performs public reads only; "router" needs RPC.
import {mkdir, readFile, copyFile, symlink, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const modes = {
  local: {script: 'simulate.mjs', args: [], report: 'local-e2e.json'},
  protocol: {script: 'check-protocol.mjs', args: [], report: 'protocol-review.json'},
  router: {script: 'review-factory.mjs', args: ['--production-router'], report: 'production-router-review.json'},
};
const mode = process.argv[2] ?? 'local';
if (!Object.hasOwn(modes, mode)) throw Error('Use local, protocol, or router');
const scratch = join(root, 'test/scratch/review-' + mode);
await mkdir(join(scratch, 'scripts'), {recursive: true});
await mkdir(join(scratch, 'reports'), {recursive: true});
await mkdir(join(scratch, 'test'), {recursive: true});
// The scripts are copied without semantic changes. Only their base directory
// changes, so their normal reports and compiler artifacts stay inside test/.
for (const name of ['simulate.mjs', 'check-protocol.mjs', 'review-factory.mjs', 'review-router-cases.mjs']) {
  await copyFile(join(root, 'scripts', name), join(scratch, 'scripts', name));
}
for (const [name, target] of Object.entries({
  vendor: join(root, 'vendor'), worker: join(root, 'worker'), 'test/fixtures': join(root, 'test/fixtures'),
  out: join(root, 'test/scratch/out'), 'config.example.json': join(root, 'config.example.json'),
})) {
  const path = join(scratch, name);
  await rm(path, {force: true});
  await symlink(target, path);
}
const selected = modes[mode];
const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [join(scratch, 'scripts', selected.script), ...selected.args], {
    cwd: root, stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', code => resolveExit(code ?? 1));
});
if (exitCode !== 0) process.exitCode = exitCode;
else {
  const report = join(scratch, 'reports', selected.report);
  const value = JSON.parse(await readFile(report, 'utf8'));
  if (value.status !== 'passed') throw Error('Review did not pass');
  const output = join(root, 'test/review-results');
  await mkdir(output, {recursive: true});
  await copyFile(report, join(output, selected.report));
}
