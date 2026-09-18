'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const artifactsDirectory = path.join(root, 'artifacts');
const stagingDirectory = path.join(artifactsDirectory, '.palette-stage');
const dependencyDirectory = path.join(stagingDirectory, 'dependencies');
const packageDirectory = path.join(stagingDirectory, 'package');
const npmCli = process.env.npm_execpath;

if (npmCli === undefined) {
  throw new Error('Run this script through "npm run pack:palette"');
}

const runNpm = (arguments_) => {
  execFileSync(process.execPath, [npmCli, ...arguments_], { cwd: root, stdio: 'inherit' });
};

fs.rmSync(stagingDirectory, { recursive: true, force: true });
fs.mkdirSync(dependencyDirectory, { recursive: true });
fs.mkdirSync(packageDirectory, { recursive: true });

for (const packageName of [
  'core',
  'device-enless-twin-temp',
  'app-twin-temp-failed-closed',
  'device-sxs-ecobolt2',
  'app-ecobolt2-failed-open',
]) {
  runNpm([
    'pack',
    path.join(root, 'packages', packageName),
    '--pack-destination',
    dependencyDirectory,
  ]);
}

for (const entry of ['package.json', 'dist', 'nodes']) {
  fs.cpSync(path.join(root, 'packages', 'node-red', entry), path.join(packageDirectory, entry), {
    recursive: true,
  });
}

const dependencyArchives = fs
  .readdirSync(dependencyDirectory)
  .filter((entry) => entry.endsWith('.tgz'))
  .map((entry) => path.join(dependencyDirectory, entry));

runNpm([
  'install',
  '--prefix',
  packageDirectory,
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--no-package-lock',
  '--no-save',
  ...dependencyArchives,
]);

for (const entry of fs.readdirSync(artifactsDirectory)) {
  if (/^node-red-contrib-sxs-industrial-.*\.tgz$/.test(entry)) {
    fs.rmSync(path.join(artifactsDirectory, entry));
  }
}

runNpm(['pack', packageDirectory, '--pack-destination', artifactsDirectory]);
fs.rmSync(stagingDirectory, { recursive: true, force: true });
