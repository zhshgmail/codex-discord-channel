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
  const loginMarker = path.join(home, 'login-complete');
  const fakeNode = path.join(binDir, 'node');
  const fakeCodex = path.join(binDir, 'codex.js');
  const fakeChannel = path.join(binDir, 'codex-discord-channel');
  const codexHome = path.join(home, '.codex-account-02');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(fakeCodex, '// fixture\n');
  fs.writeFileSync(fakeChannel, '// fixture\n');
  executable(fakeNode, [
    '#!/usr/bin/env bash',
    'printf "node %s\\n" "$*" >>"$TRACE"',
    'if [[ ${LOGIN_REQUIRED:-0} == 1 && $2 == tui-login-state && ! -f $LOGIN_MARKER ]]; then exit 10; fi',
    'if [[ $1 == "$FAKE_CODEX_BIN" && $2 == login ]]; then',
    '  if [[ -n ${DISCORD_BOT_TOKEN+x} || -n ${DISCORD_BOT_USER_ID+x} ]]; then exit 91; fi',
    '  if [[ ${LOGIN_EXIT:-0} != 0 ]]; then exit "$LOGIN_EXIT"; fi',
    '  touch "$LOGIN_MARKER"',
    'fi',
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
    `CODEX_HOME=${codexHome}`,
    `CODEX_BIN=${fakeCodex}`,
    `NODE_BIN=${fakeNode}`,
    `CODEX_DISCORD_CHANNEL_BIN=${fakeChannel}`,
    '',
  ].join('\n'));
  return { binDir, codexHome, fakeCodex, home, loginMarker, stateDir, trace };
}

function launchEnv(setup, overrides = {}) {
  return {
    ...process.env,
    DISCORD_BOT_TOKEN: 'fixture-secret',
    DISCORD_BOT_USER_ID: 'fixture-bot',
    DISCORD_CONFIG_DIR: setup.stateDir,
    FAKE_CODEX_BIN: setup.fakeCodex,
    HOME: setup.home,
    LOGIN_MARKER: setup.loginMarker,
    PATH: `${setup.binDir}:${process.env.PATH}`,
    STATE_DIR: setup.stateDir,
    TRACE: setup.trace,
    ...overrides,
  };
}

test('shell launcher checks identity, starts both units, verifies each, then enters the TUI', () => {
  const setup = fixture();
  const result = spawnSync(launcher, ['codex02', 'resume', 'thread-2'], {
    encoding: 'utf8',
    env: launchEnv(setup),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(setup.trace, 'utf8').trim().split('\n'), [
    `node ${path.join(setup.binDir, 'codex-discord-channel')} tui-login-state --instance codex02 --state-dir ${setup.stateDir}`,
    'systemctl --user enable --now codex-discord-app-server@codex02.service codex-discord-channel@codex02.service',
    'systemctl --user is-active --quiet codex-discord-app-server@codex02.service',
    'systemctl --user is-active --quiet codex-discord-channel@codex02.service',
    'systemctl --user show --property MainPID --value codex-discord-app-server@codex02.service',
    'systemctl --user show --property MainPID --value codex-discord-channel@codex02.service',
    `node ${path.join(setup.binDir, 'codex-discord-channel')} live-check --instance codex02 --state-dir ${setup.stateDir} --pid 12345 --pid 12345`,
    `node ${path.join(setup.binDir, 'codex-discord-channel')} tui --instance codex02 --state-dir ${setup.stateDir} -- resume thread-2`,
  ]);
});

test('first-run TTY login succeeds before services and the TUI start', () => {
  const setup = fixture();
  const command = `${launcher} codex02`;
  const result = spawnSync('/usr/bin/script', ['-qec', command, '/dev/null'], {
    encoding: 'utf8',
    env: launchEnv(setup, { LOGIN_REQUIRED: '1' }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(setup.loginMarker), true);
  assert.deepEqual(fs.readFileSync(setup.trace, 'utf8').trim().split('\n'), [
    `node ${path.join(setup.binDir, 'codex-discord-channel')} tui-login-state --instance codex02 --state-dir ${setup.stateDir}`,
    `node ${setup.fakeCodex} login`,
    `node ${path.join(setup.binDir, 'codex-discord-channel')} tui-check --instance codex02 --state-dir ${setup.stateDir}`,
    'systemctl --user enable --now codex-discord-app-server@codex02.service codex-discord-channel@codex02.service',
    'systemctl --user is-active --quiet codex-discord-app-server@codex02.service',
    'systemctl --user is-active --quiet codex-discord-channel@codex02.service',
    'systemctl --user show --property MainPID --value codex-discord-app-server@codex02.service',
    'systemctl --user show --property MainPID --value codex-discord-channel@codex02.service',
    `node ${path.join(setup.binDir, 'codex-discord-channel')} live-check --instance codex02 --state-dir ${setup.stateDir} --pid 12345 --pid 12345`,
    `node ${path.join(setup.binDir, 'codex-discord-channel')} tui --instance codex02 --state-dir ${setup.stateDir} --`,
  ]);
});

test('cancelled first-run TTY login starts neither service nor TUI', () => {
  const setup = fixture();
  const result = spawnSync('/usr/bin/script', ['-qec', `${launcher} codex02`, '/dev/null'], {
    encoding: 'utf8',
    env: launchEnv(setup, { LOGIN_EXIT: '130', LOGIN_REQUIRED: '1' }),
  });

  assert.equal(result.status, 130);
  assert.deepEqual(fs.readFileSync(setup.trace, 'utf8').trim().split('\n'), [
    `node ${path.join(setup.binDir, 'codex-discord-channel')} tui-login-state --instance codex02 --state-dir ${setup.stateDir}`,
    `node ${setup.fakeCodex} login`,
  ]);
  assert.equal(fs.existsSync(setup.loginMarker), false);
});

test('missing TTY refuses first-run login before spawning Codex or services', () => {
  const setup = fixture();
  const result = spawnSync(launcher, ['codex02'], {
    encoding: 'utf8',
    env: launchEnv(setup, { LOGIN_REQUIRED: '1' }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires an interactive TTY/);
  assert.deepEqual(fs.readFileSync(setup.trace, 'utf8').trim().split('\n'), [
    `node ${path.join(setup.binDir, 'codex-discord-channel')} tui-login-state --instance codex02 --state-dir ${setup.stateDir}`,
  ]);
  assert.equal(fs.existsSync(setup.loginMarker), false);
});

test('shell launcher rejects duplicate executable authority before starting systemd', () => {
  const setup = fixture();
  fs.appendFileSync(
    path.join(setup.stateDir, 'account.env'),
    `NODE_BIN=${path.join(setup.binDir, 'node')}\n`,
  );
  const result = spawnSync(launcher, ['codex02'], {
    encoding: 'utf8',
    env: launchEnv(setup),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one NODE_BIN/);
  assert.equal(fs.existsSync(setup.trace), false);
});
