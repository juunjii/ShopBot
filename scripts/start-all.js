#!/usr/bin/env node
/* eslint-disable */
// Cross-platform start-all script
// - Installs dependencies in repo root and infra/
// - Runs infra seed script synchronously
// - Starts backend (infra) and frontend (root) dev servers concurrently
// - Streams logs to current terminal with prefixes
// Usage: node ./scripts/start-all.js

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const readline = require('readline');

function abs(...p) {
    return path.resolve(__dirname, '..', ...p);
}

const ROOT = abs();
const BACKEND = abs('infra');

function runSync(cmd, args, cwd) {
    console.log(`\n==> [${cwd}] ${cmd} ${args.join(' ')}`);
    const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    if (res.error) {
        console.error('Command failed:', res.error);
        process.exit(res.status || 1);
    }
    if (res.status !== 0) {
        console.error(`Command exited with status ${res.status}`);
        process.exit(res.status || 1);
    }
}

function startProcess(prefix, cmd, args, cwd) {
    console.log(`\nStarting ${prefix}: ${cmd} ${args.join(' ')} (cwd=${cwd})`);
    const child = spawn(cmd, args, { cwd, env: process.env, shell: process.platform === 'win32' });

    // Helper to prefix lines
    function pipeWithPrefix(stream, outFn) {
        const rl = readline.createInterface({ input: stream });
        rl.on('line', (line) => {
            outFn(`[${prefix}] ${line}`);
        });
    }

    pipeWithPrefix(child.stdout, (line) => console.log(line));
    pipeWithPrefix(child.stderr, (line) => console.error(line));

    child.on('exit', (code, signal) => {
        console.log(`[${prefix}] process exited with code=${code} signal=${signal}`);
    });

    child.on('error', (err) => {
        console.error(`[${prefix}] process error:`, err);
    });

    return child;
}

(async function main() {
    try {
        // 1) Check Node and npm availability
        try {
            runSync(process.execPath, ['--version'], ROOT);
        } catch (_) {
            console.warn('Unable to run node --version');
        }

        try {
            runSync('npm', ['--version'], ROOT);
        } catch (_) {
            console.error('npm not found. Please install npm and retry.');
            process.exit(1);
        }

        // 2) Install frontend deps (root)
        console.log('\nInstalling frontend (root) dependencies...');
        runSync('npm', ['install'], ROOT);

        // 3) Install backend deps (infra)
        console.log('\nInstalling backend (infra) dependencies...');
        runSync('npm', ['install'], BACKEND);

        // 4) Run seed synchronously
        console.log('\nRunning database seed (infra)...');
        // seed script must exist in infra/package.json
        runSync('npm', ['run', 'seed'], BACKEND);

        // 5) Start backend and frontend dev servers concurrently
        console.log('\nStarting dev servers (backend + frontend). Logs will be prefixed.');

        const backend = startProcess('backend', 'npm', ['run', 'dev'], BACKEND);
        const frontend = startProcess('frontend', 'npm', ['run', 'dev'], ROOT);

        // Clean shutdown: forward signals and kill children
        function shutdown(code) {
            console.log('\nShutting down child processes...');
            [backend, frontend].forEach((c) => {
                if (c && !c.killed) {
                    try {
                        if (process.platform === 'win32') {
                            // On Windows, use taskkill for node spawned shells
                            spawnSync('taskkill', ['/PID', c.pid, '/T', '/F']);
                        } else {
                            c.kill('SIGTERM');
                        }
                    } catch (_) {
                        try { c.kill(); } catch (_) { }
                    }
                }
            });
            setTimeout(() => process.exit(code ?? 0), 500);
        }

        process.on('SIGINT', () => shutdown(0));
        process.on('SIGTERM', () => shutdown(0));
        process.on('uncaughtException', (err) => {
            console.error('Uncaught exception:', err);
            shutdown(1);
        });

        // Keep main process alive while children run
    } catch (err) {
        console.error('Error in start-all script:', err);
        process.exit(1);
    }
})();
