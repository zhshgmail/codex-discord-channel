'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const launcher = path.resolve(__dirname, '..', '..', 'bin', 'codex-discord-instance');

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-launch-script-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex02');
  const binDir = path.join(home, 'bin');
  const trace = path.join(home, 'trace.log');
  const fakeNode = path.join(binDir, 'node');
  const fakeChannel = path.join(binDir, 'codex-discord-channel');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(fakeChannel, '// fixture\n');
  executable(fakeNode, [
    '#!/usr/bin/env bash',
    'printf "node %s\\n" "$*" >>"$TRACE"',
    'exit 0',
    '',
  ].join('\n'));
  executable(path.join(binDir, 'systemctl'), [
    '#!/usr/bin/env bash',
    'printf "systemctl %s\\n" "$*" >>"$TRACE"',
    'if [[ $2 == enable ]]; then',
    '  python3 - "$STATE_DIR/app-server.sock" <<\'PY\'',
    'import socket, sys',
    'sock = socket.socket(socket.AF_UNIX)',
    'sock.bind(sys.argv[1])',
    'sock.close()',
    'PY',
    'fi',
    'if [[ $2 == show ]]; then echo 12345; fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(stateDir, 'account.env'), [
    `NODE_BIN=${fakeNode}`,
    `CODEX_DISCORD_CHANNEL_BIN=${fakeChannel}`,
    '',
  ].join('\n'));
  return { binDir, home, stateDir, trace };
}

test('shell launcher checks identity, starts both units, verifies each, then enters the TUI', () => {
  const setup = fixture();
  const result = spawnSync(launcher, ['codex02', 'resume', 'thread-2'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DISCORD_CONFIG_DIR: setup.stateDir,
      HOME: setup.home,
      PATH: `${setup.binDir}:${process.env.PATH}`,
      STATE_DIR: setup.stateDir,
      TRACE: setup.trace,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(setup.trace, 'utf8').trim().split('\n'), [
    `node ${path.join(setup.binDir, 'codex-discord-channel')} tui-check --instance codex02 --state-dir ${setup.stateDir}`,
    'systemctl --user enable --now codex-discord-app-server@codex02.service codex-discord-channel@codex02.service',
    'systemctl --user is-active --quiet codex-discord-app-server@codex02.service',
    'systemctl --user is-active --quiet codex-discord-channel@codex02.service',
    'systemctl --user show --property MainPID --value codex-discord-app-server@codex02.service',
    'systemctl --user show --property MainPID --value codex-discord-channel@codex02.service',
    `node ${path.join(setup.binDir, 'codex-discord-channel')} live-check --instance codex02 --state-dir ${setup.stateDir} --pid 12345 --pid 12345`,
    `node ${path.join(setup.binDir, 'codex-discord-channel')} tui --instance codex02 --state-dir ${setup.stateDir} -- resume thread-2`,
  ]);
});

test('shell launcher rejects duplicate executable authority before starting systemd', () => {
  const setup = fixture();
  fs.appendFileSync(
    path.join(setup.stateDir, 'account.env'),
    `NODE_BIN=${path.join(setup.binDir, 'node')}\n`,
  );
  const result = spawnSync(launcher, ['codex02'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DISCORD_CONFIG_DIR: setup.stateDir,
      HOME: setup.home,
      PATH: `${setup.binDir}:${process.env.PATH}`,
      STATE_DIR: setup.stateDir,
      TRACE: setup.trace,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one NODE_BIN/);
  assert.equal(fs.existsSync(setup.trace), false);
});
