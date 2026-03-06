#!/usr/bin/env node

import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const rawArgs = process.argv.slice(2);
const useDev = rawArgs.includes('--dev');
const forwardedArgs = rawArgs.filter(arg => arg !== '--dev');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(
  npmCommand,
  ['run', useDev ? 'dev' : 'start', '--', ...forwardedArgs],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  }
);

child.on('error', (err) => {
  console.error(`Failed to launch app: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
