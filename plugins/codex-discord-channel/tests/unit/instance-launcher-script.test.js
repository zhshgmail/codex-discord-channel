'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sourceLauncher = path.resolve(__dirname, '..', '..', 'bin', 'codex-discord-instance');

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-launch-script-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex02');
  const binDir = path.join(home, 'bin');
  const pluginBinDir = path.join(home, 'plugin', 'bin');
  const pluginRoot = path.join(home, 'plugin');
  const pluginRuntimeDir = path.join(home, 'plugin', 'runtime');
  const trace = path.join(home, 'trace.log');
  const childEnvTrace = path.join(home, 'child-env.log');
  const channelEnvTrace = path.join(home, 'channel-env.log');
  const loginMarker = path.join(home, 'login-complete');
  const fakeNode = path.join(binDir, 'node');
  const fakeCodex = path.join(binDir, 'codex.js');
  const fakeChannel = path.join(pluginRuntimeDir, 'channel.cjs');
  const socketOwner = path.join(binDir, 'socket-owner.py');
  const launcher = path.join(pluginBinDir, 'codex-discord-instance');
  const generationHelper = path.join(pluginBinDir, 'codex-discord-generation');
  const codexHome = path.join(home, '.codex-account-02');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(pluginBinDir, { recursive: true });
  fs.mkdirSync(pluginRuntimeDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.copyFileSync(sourceLauncher, launcher);
  fs.chmodSync(launcher, 0o700);
  fs.copyFileSync(path.resolve(__dirname, '..', '..', 'bin', 'codex-discord-generation'), generationHelper);
  fs.chmodSync(generationHelper, 0o700);
  fs.writeFileSync(fakeCodex, '// fixture\n');
  fs.writeFileSync(fakeChannel, '// fixture\n');
  executable(socketOwner, String.raw`#!/usr/bin/env python3
import os, signal, socket, sys, time

path = sys.argv[1]
replace_marker = path + '.replace'
sock = None

def bind():
    global sock
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(path)
    sock.listen(1)

def stop(_signum, _frame):
    global sock
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    if os.environ.get('APP_CREATES_SOCKET_ON_TERM') == '1' and sock is None:
        bind()
        time.sleep(0.15)
    if sock is not None:
        sock.close()
    if os.environ.get('APP_LEAVES_SOCKET') != '1' and os.environ.get('APP_CREATES_SOCKET_ON_TERM') != '1':
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
if os.environ.get('APP_CREATES_SOCKET_ON_TERM') != '1':
    bind()
while True:
    if os.path.exists(replace_marker):
        os.unlink(replace_marker)
        if sock is not None:
            sock.close()
        bind()
    time.sleep(0.01)
`);
  executable(fakeNode, [
    '#!/usr/bin/env bash',
    'if [[ $1 == "$GENERATION_HELPER" ]]; then exec "$REAL_NODE_BIN" "$@"; fi',
    'if [[ $1 == -e && $2 == \'process.stdout.write(String(Date.now()))\' ]]; then',
    '  printf "%s" "$FAKE_NODE_NOW_MS"',
    '  exit 0',
    'fi',
    'if [[ $1 == "$FAKE_CHANNEL_BIN" ]]; then',
    '  state_activation=$(awk -F= \'$1 == "CODEX_DISCORD_DELIVERY_ACTIVATION_ID" { print substr($0, index($0, "=") + 1) }\' "$STATE_DIR/.env")',
    '  effective_activation=${CODEX_DISCORD_DELIVERY_ACTIVATION_ID:-$state_activation}',
    '  printf "%s|%s|%s|%s|%s|%s|%s\n" "$2" "${CODEX_HOME-UNSET}" "${DISCORD_CONFIG_DIR-UNSET}" "${DISCORD_STATE_DIR-UNSET}" "${CODEX_ACCOUNT_ENV_FILE-UNSET}" "${CODEX_NETWORK_ENV_FILE-UNSET}" "$effective_activation" >>"$CHANNEL_ENV_TRACE"',
    'fi',
    'if [[ $1 == "$FAKE_CHANNEL_BIN" && $2 == tui-recovery-target ]]; then',
    '  case $3 in',
    '    begin)',
    '      printf "recovery-begin %s\\n" "$7" >>"$TRACE"',
    '      printf "{\\"version\\":3,\\"leaseId\\":\\"%s\\",\\"supervisorPid\\":%s,\\"supervisorStartTicks\\":\\"%s\\",\\"startedAtMs\\":%s,\\"phase\\":\\"launching\\"}\\n" "$6" "$4" "$5" "$7" >"$STATE_DIR/tui-recovery-target.json"',
    '      exit 0',
    '      ;;',
    '    clear) rm -f "$STATE_DIR/tui-recovery-target.json"; exit 0 ;;',
    '    clear-owned) rm -f "$STATE_DIR/tui-recovery-target.json"; exit 0 ;;',
    '    snapshot)',
    '      if [[ -f $STATE_DIR/app-server-target.json ]]; then',
    '        python3 - "$STATE_DIR/tui-recovery-target.json" "$STATE_DIR/app-server-target.json" <<\'PY\'',
    'import json, sys',
    'lease_path, target_path = sys.argv[1:]',
    'lease = json.load(open(lease_path))',
    'target = json.load(open(target_path))',
    'lease.update(phase="active", threadId=target["threadId"], loadedThreadIds=target["loadedThreadIds"])',
    'json.dump(lease, open(lease_path, "w"))',
    'PY',
    '        exit 0',
    '      fi',
    '      exit 10',
    '      ;;',
    '    read)',
    '      if [[ -f $STATE_DIR/tui-recovery-target.json ]]; then',
    '        printf "%s\\n" "$THREAD_ID"',
    '        exit 0',
    '      fi',
    '      exit 10',
    '      ;;',
    '  esac',
    'fi',
    'printf "node %s\\n" "$*" >>"$TRACE"',
    'if [[ $1 == "$FAKE_CHANNEL_BIN" && $2 == app-server ]]; then',
    '  exec python3 "$SOCKET_OWNER" "$STATE_DIR/app-server.sock"',
    'fi',
    'if [[ $1 == "$FAKE_CHANNEL_BIN" && $2 == gateway ]]; then',
    '  if [[ ${GATEWAY_EXIT_IMMEDIATELY:-0} == 1 ]]; then sleep 0.1; exit 42; fi',
    '  if [[ ${GATEWAY_EXIT_WHEN_SOCKET_EXISTS:-0} == 1 ]]; then',
    '    while [[ ! -S $STATE_DIR/app-server.sock ]]; do sleep 0.01; done',
    '    exit 42',
    '  fi',
    '  if [[ ${GATEWAY_EXIT_AFTER_START:-0} == 1 ]]; then sleep 0.2; exit 42; fi',
    '  trap \'exit 0\' TERM INT',
    '  while true; do sleep 0.1; done',
    'fi',
    'if [[ $1 == "$FAKE_CODEX_BIN" ]]; then',
    '  env | LC_ALL=C sort | grep -E "^(DISCORD_|CODEX_DISCORD_|CODEX_APP_SERVER_URL=|CODEX_ACCOUNT_ENV_FILE=|CODEX_NETWORK_ENV_FILE=)" >>"$CHILD_ENV_TRACE" || true',
    'fi',
    'if [[ $1 == "$FAKE_CODEX_BIN" && $2 == --remote && ${TUI_STAY_ACTIVE:-0} == 1 ]]; then',
    '  trap \'exit 0\' TERM INT',
    '  while true; do sleep 0.1; done',
    'fi',
    'if [[ ${LOGIN_REQUIRED:-0} == 1 && $2 == tui-login-state && ! -f $LOGIN_MARKER ]]; then exit 10; fi',
    'if [[ $1 == "$FAKE_CODEX_BIN" && $2 == login ]]; then',
    '  if [[ -n ${DISCORD_BOT_TOKEN+x} || -n ${DISCORD_BOT_USER_ID+x} ]]; then exit 91; fi',
    '  if [[ ${LOGIN_EXIT:-0} != 0 ]]; then exit "$LOGIN_EXIT"; fi',
    '  touch "$LOGIN_MARKER"',
    'fi',
    'if [[ $1 == "$FAKE_CODEX_BIN" && $2 == --remote && ${TRANSPORT_FAIL_ONCE:-0} == 1 ]]; then',
    '  count=0',
    '  [[ -f $TUI_COUNT ]] && read -r count <"$TUI_COUNT"',
    '  count=$((count + 1))',
    '  printf "%s\\n" "$count" >"$TUI_COUNT"',
    '  if ((count == 1)); then',
    '    printf "{\\"version\\":1,\\"threadId\\":\\"%s\\",\\"status\\":\\"active\\",\\"activeTurnId\\":\\"turn-1\\",\\"loadedThreadIds\\":[\\"%s\\"]}\\n" "$THREAD_ID" "$THREAD_ID" >"$STATE_DIR/app-server-target.json"',
    '    before=$(stat -Lc "%d:%i" "$STATE_DIR/app-server.sock")',
    '    : >"$STATE_DIR/app-server.sock.replace"',
    '    for _attempt in {1..100}; do',
    '      after=$(stat -Lc "%d:%i" "$STATE_DIR/app-server.sock" 2>/dev/null || true)',
    '      [[ -n $after && $after != "$before" ]] && break',
    '      sleep 0.01',
    '    done',
    '    exit 71',
    '  fi',
    'fi',
    'if [[ $1 == "$FAKE_CODEX_BIN" && $2 == --remote && ${EXIT_WITH_TARGET:-0} == 1 ]]; then',
    '  printf "{\\"version\\":1,\\"threadId\\":\\"%s\\",\\"status\\":\\"active\\",\\"activeTurnId\\":\\"turn-1\\",\\"loadedThreadIds\\":[\\"%s\\"]}\\n" "$THREAD_ID" "$THREAD_ID" >"$STATE_DIR/app-server-target.json"',
    '  sleep 0.4',
    '  exit 72',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  executable(path.join(binDir, 'date'), [
    '#!/usr/bin/env bash',
    'if [[ $# == 1 && $1 == +%s%3N && -n ${FAKE_DATE_NOW_MS:-} ]]; then',
    '  printf "%s\\n" "$FAKE_DATE_NOW_MS"',
    '  exit 0',
    'fi',
    'exec /usr/bin/date "$@"',
    '',
  ].join('\n'));
  executable(path.join(binDir, 'systemctl'), [
    '#!/usr/bin/env bash',
    'printf "systemctl %s\\n" "$*" >>"$TRACE"',
    'exit 99',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(stateDir, 'account.env'), [
    `CODEX_HOME=${codexHome}`,
    `CODEX_BIN=${fakeCodex}`,
    `NODE_BIN=${fakeNode}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(stateDir, '.env'), [
    'CODEX_DISCORD_DELIVERY_ACTIVATION_ID=/marketplace/0.3.0/stale-plugin-root',
    '',
  ].join('\n'));
  return {
    binDir,
    channelEnvTrace,
    childEnvTrace,
    codexHome,
    fakeChannel,
    fakeCodex,
    generationHelper,
    home,
    launcher,
    loginMarker,
    pluginRoot,
    socketOwner,
    stateDir,
    trace,
    tuiCount: path.join(home, 'tui-count'),
  };
}

function launchEnv(setup, overrides = {}) {
  return {
    ...process.env,
    DISCORD_BOT_TOKEN: 'fixture-secret',
    DISCORD_BOT_USER_ID: 'fixture-bot',
    DISCORD_CONFIG_DIR: setup.stateDir,
    CHILD_ENV_TRACE: setup.childEnvTrace,
    CHANNEL_ENV_TRACE: setup.channelEnvTrace,
    FAKE_CHANNEL_BIN: setup.fakeChannel,
    FAKE_CODEX_BIN: setup.fakeCodex,
    GENERATION_HELPER: setup.generationHelper,
    HOME: setup.home,
    LOGIN_MARKER: setup.loginMarker,
    PATH: `${setup.binDir}:${process.env.PATH}`,
    REAL_NODE_BIN: process.execPath,
    SOCKET_OWNER: setup.socketOwner,
    STATE_DIR: setup.stateDir,
    THREAD_ID: '019f3763-d308-7871-bedc-e6489b02190e',
    TRACE: setup.trace,
    TUI_COUNT: setup.tuiCount,
    ...overrides,
  };
}

test('shell launcher owns both workers without systemd, verifies each, then enters the TUI', () => {
  const setup = fixture();
  fs.appendFileSync(
    path.join(setup.stateDir, 'account.env'),
    'CODEX_DISCORD_CHANNEL_BIN=/tmp/stale-external-worker.cjs\n',
  );
  const result = spawnSync(setup.launcher, ['codex02', 'resume', 'thread-2'], {
    encoding: 'utf8',
    env: launchEnv(setup),
  });
  assert.equal(result.status, 0, result.stderr);
  const trace = fs.readFileSync(setup.trace, 'utf8').trim().split('\n');
  assert.equal(trace.some((line) => line.startsWith('systemctl ')), false);
  assert.ok(trace.includes(`node ${setup.fakeChannel} app-server --instance codex02 --state-dir ${setup.stateDir}`));
  assert.ok(trace.includes(`node ${setup.fakeChannel} gateway --instance codex02 --state-dir ${setup.stateDir}`));
  assert.ok(trace.some((line) => line.startsWith(`node ${setup.fakeChannel} live-check `)));
  assert.ok(trace.includes(`node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock resume thread-2`));
  const channelEnvironments = fs.readFileSync(setup.channelEnvTrace, 'utf8').trim().split('\n');
  assert.ok(channelEnvironments.length > 0);
  for (const entry of channelEnvironments) {
    assert.equal(entry.split('|')[6], setup.pluginRoot);
  }
  assert.equal(fs.existsSync(path.join(setup.stateDir, 'app-server.sock')), false);
});

test('instance argument ignores Discord state inherited from another alias', () => {
  const setup = fixture();
  const foreignStateDir = path.join(
    setup.home,
    '.codex',
    'channels',
    'discord',
    'codex01',
  );
  fs.mkdirSync(foreignStateDir, { recursive: true });

  const result = spawnSync(setup.launcher, ['codex02', 'resume', 'thread-2'], {
    encoding: 'utf8',
    env: launchEnv(setup, {
      CODEX_HOME: path.join(setup.home, '.codex-account-01'),
      CODEX_ACCOUNT_ENV_FILE: path.join(setup.home, 'foreign-account.env'),
      CODEX_NETWORK_ENV_FILE: path.join(setup.home, 'foreign-network.env'),
      DISCORD_INSTANCE: 'codex01',
      DISCORD_CONFIG_DIR: foreignStateDir,
      DISCORD_STATE_DIR: foreignStateDir,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const trace = fs.readFileSync(setup.trace, 'utf8').trim().split('\n');
  assert.ok(trace.includes(
    `node ${setup.fakeChannel} gateway --instance codex02 --state-dir ${setup.stateDir}`,
  ));
  assert.ok(trace.includes(
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock resume thread-2`,
  ));
  const channelEnvironments = fs.readFileSync(setup.channelEnvTrace, 'utf8').trim().split('\n');
  assert.ok(channelEnvironments.length > 0);
  for (const entry of channelEnvironments) {
    const [, codexHome, configDir, legacyStateDir, accountEnvFile, networkEnvFile,
      activationId] = entry.split('|');
    assert.equal(codexHome, setup.codexHome);
    assert.equal(configDir, setup.stateDir);
    assert.equal(legacyStateDir, 'UNSET');
    assert.equal(accountEnvFile, 'UNSET');
    assert.equal(networkEnvFile, 'UNSET');
    assert.equal(activationId, setup.pluginRoot);
  }
});

test('first-run TTY login succeeds before workers and the TUI start', () => {
  const setup = fixture();
  const command = `${setup.launcher} codex02`;
  const result = spawnSync('/usr/bin/script', ['-qec', command, '/dev/null'], {
    encoding: 'utf8',
    env: launchEnv(setup, { LOGIN_REQUIRED: '1' }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(setup.loginMarker), true);
  const trace = fs.readFileSync(setup.trace, 'utf8').trim().split('\n');
  assert.deepEqual(trace.slice(0, 3), [
    `node ${setup.fakeChannel} tui-login-state --instance codex02 --state-dir ${setup.stateDir}`,
    `node ${setup.fakeCodex} login`,
    `node ${setup.fakeChannel} tui-check --instance codex02 --state-dir ${setup.stateDir}`,
  ]);
  assert.equal(trace.some((line) => line.startsWith('systemctl ')), false);
  assert.ok(trace.includes(`node ${setup.fakeChannel} app-server --instance codex02 --state-dir ${setup.stateDir}`));
  assert.ok(trace.includes(`node ${setup.fakeChannel} gateway --instance codex02 --state-dir ${setup.stateDir}`));
  assert.ok(trace.includes(`node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock`));
});

test('cancelled first-run TTY login starts neither worker nor TUI', () => {
  const setup = fixture();
  const result = spawnSync('/usr/bin/script', ['-qec', `${setup.launcher} codex02`, '/dev/null'], {
    encoding: 'utf8',
    env: launchEnv(setup, { LOGIN_EXIT: '130', LOGIN_REQUIRED: '1' }),
  });

  assert.equal(result.status, 130);
  assert.deepEqual(fs.readFileSync(setup.trace, 'utf8').trim().split('\n'), [
    `node ${setup.fakeChannel} tui-login-state --instance codex02 --state-dir ${setup.stateDir}`,
    `node ${setup.fakeCodex} login`,
  ]);
  assert.equal(fs.existsSync(setup.loginMarker), false);
});

test('missing TTY refuses first-run login before spawning Codex or workers', () => {
  const setup = fixture();
  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: launchEnv(setup, { LOGIN_REQUIRED: '1' }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires an interactive TTY/);
  assert.deepEqual(fs.readFileSync(setup.trace, 'utf8').trim().split('\n'), [
    `node ${setup.fakeChannel} tui-login-state --instance codex02 --state-dir ${setup.stateDir}`,
  ]);
  assert.equal(fs.existsSync(setup.loginMarker), false);
});

test('shell launcher rejects duplicate executable authority before starting workers', () => {
  const setup = fixture();
  fs.appendFileSync(
    path.join(setup.stateDir, 'account.env'),
    `NODE_BIN=${path.join(setup.binDir, 'node')}\n`,
  );
  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: launchEnv(setup),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one NODE_BIN/);
  assert.equal(fs.existsSync(setup.trace), false);
});

test('launcher rejection never removes an app-server socket it does not own', () => {
  const setup = fixture();
  const socketPath = path.join(setup.stateDir, 'app-server.sock');
  const bound = spawnSync('python3', ['-c', [
    'import socket, sys',
    'sock = socket.socket(socket.AF_UNIX)',
    'sock.bind(sys.argv[1])',
    'sock.close()',
  ].join('\n'), socketPath], { encoding: 'utf8' });
  assert.equal(bound.status, 0, bound.stderr);

  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: launchEnv(setup),
  });
  assert.equal(result.status, 73, result.stderr);
  assert.match(result.stderr, /already has an app-server socket/);
  assert.equal(fs.existsSync(socketPath), true, 'foreign socket must remain untouched');
});

test('worker exit fails the active TUI closed and cleans the owned socket', () => {
  const setup = fixture();
  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: launchEnv(setup, { GATEWAY_EXIT_AFTER_START: '1', TUI_STAY_ACTIVE: '1' }),
    timeout: 5000,
  });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /Discord gateway .* exited while the TUI was active/);
  assert.equal(fs.existsSync(path.join(setup.stateDir, 'app-server.sock')), false);
});

test('startup failure cleans a socket created by the owned app-server child', () => {
  const setup = fixture();
  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: launchEnv(setup, { APP_LEAVES_SOCKET: '1', GATEWAY_EXIT_WHEN_SOCKET_EXISTS: '1' }),
    timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /gateway .* exited during startup/);
  assert.equal(
    fs.existsSync(path.join(setup.stateDir, 'app-server.sock')),
    false,
    'socket created after launcher ownership must be cleaned',
  );
});

test('cleanup removes an owned socket created after sibling startup failure', () => {
  const setup = fixture();
  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: launchEnv(setup, {
      APP_CREATES_SOCKET_ON_TERM: '1',
      GATEWAY_EXIT_IMMEDIATELY: '1',
    }),
    timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /gateway .* exited during startup/);
  assert.equal(
    fs.existsSync(path.join(setup.stateDir, 'app-server.sock')),
    false,
    'owned app child cannot leave a socket during cleanup',
  );
});

test('shell launcher resumes the exact captured thread after app-server replacement', () => {
  const setup = fixture();
  const result = spawnSync(
    setup.launcher,
    ['codex02', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--last'],
    {
      encoding: 'utf8',
      env: launchEnv(setup, { TRANSPORT_FAIL_ONCE: '1' }),
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const tuiLaunches = fs.readFileSync(setup.trace, 'utf8').trim().split('\n')
    .filter((line) => line.includes(`${setup.fakeCodex} --remote`));
  assert.deepEqual(tuiLaunches, [
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock --dangerously-bypass-approvals-and-sandbox resume --last`,
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock --dangerously-bypass-approvals-and-sandbox resume 019f3763-d308-7871-bedc-e6489b02190e`,
  ]);
  assert.match(result.stderr, /resuming thread 019f3763-d308-7871-bedc-e6489b02190e/);
});

test('recovery begin receives milliseconds from the configured Node clock', () => {
  const setup = fixture();
  const nodeNowMs = '1770000123456';
  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: launchEnv(setup, {
      FAKE_DATE_NOW_MS: '1770000123456789012',
      FAKE_NODE_NOW_MS: nodeNowMs,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const recoveryBegins = fs.readFileSync(setup.trace, 'utf8').trim().split('\n')
    .filter((line) => line.startsWith('recovery-begin '));
  assert.deepEqual(recoveryBegins, [`recovery-begin ${nodeNowMs}`]);
});

test('shell launcher clears the supervised TUI lease on every launcher exit', () => {
  const setup = fixture();
  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: launchEnv(setup, { EXIT_WITH_TARGET: '1' }),
    timeout: 5000,
  });

  assert.equal(result.status, 72, result.stderr);
  assert.equal(fs.existsSync(path.join(setup.stateDir, 'tui-recovery-target.json')), false);
});

test('Codex child receives only the explicit Discord instance allowlist', () => {
  const setup = fixture();
  const result = spawnSync(setup.launcher, ['codex02', 'resume', 'thread-2'], {
    encoding: 'utf8',
    env: launchEnv(setup, {
      CODEX_APP_SERVER_URL: 'unix:///tmp/foreign-codex01.sock',
      CODEX_ACCOUNT_ENV_FILE: path.join(setup.home, 'foreign-account.env'),
      CODEX_DISCORD_UNKNOWN_SECRET: 'must-not-leak',
      CODEX_NETWORK_ENV_FILE: path.join(setup.home, 'foreign-network.env'),
      DISCORD_PROXY_URL: 'http://proxy.invalid',
      DISCORD_UNKNOWN_SECRET: 'must-not-leak',
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  const childEnvironment = fs.readFileSync(setup.childEnvTrace, 'utf8').trim().split('\n');
  const generationEntry = childEnvironment.find((entry) => entry.startsWith('CODEX_DISCORD_LAUNCH_GENERATION='));
  assert.match(generationEntry, /^CODEX_DISCORD_LAUNCH_GENERATION=[0-9a-f-]{36}$/);
  assert.deepEqual(childEnvironment.filter((entry) => entry !== generationEntry), [
    `CODEX_DISCORD_DELIVERY_ACTIVATION_ID=${setup.pluginRoot}`,
    `CODEX_DISCORD_LAUNCH_CODEX_HOME=${setup.codexHome}`,
    `CODEX_DISCORD_LAUNCH_ENDPOINT=${setup.stateDir}/app-server.sock`,
    'CODEX_DISCORD_LAUNCH_INSTANCE=codex02',
    `CODEX_DISCORD_LAUNCH_PLUGIN_ROOT=${setup.pluginRoot}`,
    'CODEX_DISCORD_LAUNCH_ROLE=tui',
    `CODEX_DISCORD_LAUNCH_STATE_DIR=${setup.stateDir}`,
    `DISCORD_CONFIG_DIR=${setup.stateDir}`,
    'DISCORD_INSTANCE=codex02',
  ]);
});

test('recovery inserts exact resume after preserving global flags when no resume was supplied', () => {
  const setup = fixture();
  const result = spawnSync(
    setup.launcher,
    ['codex02', '--dangerously-bypass-approvals-and-sandbox', '--profile', 'review'],
    {
      encoding: 'utf8',
      env: launchEnv(setup, { TRANSPORT_FAIL_ONCE: '1' }),
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const tuiLaunches = fs.readFileSync(setup.trace, 'utf8').trim().split('\n')
    .filter((line) => line.includes(`${setup.fakeCodex} --remote`));
  assert.deepEqual(tuiLaunches, [
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock --dangerously-bypass-approvals-and-sandbox --profile review`,
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock --dangerously-bypass-approvals-and-sandbox --profile review resume 019f3763-d308-7871-bedc-e6489b02190e`,
  ]);
});

test('recovery discards the original prompt instead of replaying it after resume', () => {
  const setup = fixture();
  const result = spawnSync(
    setup.launcher,
    [
      'codex02',
      '--dangerously-bypass-approvals-and-sandbox',
      '--profile',
      'review',
      '--',
      'initial prompt',
    ],
    {
      encoding: 'utf8',
      env: launchEnv(setup, { TRANSPORT_FAIL_ONCE: '1' }),
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const tuiLaunches = fs.readFileSync(setup.trace, 'utf8').trim().split('\n')
    .filter((line) => line.includes(`${setup.fakeCodex} --remote`));
  assert.deepEqual(tuiLaunches, [
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock --dangerously-bypass-approvals-and-sandbox --profile review -- initial prompt`,
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock --dangerously-bypass-approvals-and-sandbox --profile review resume 019f3763-d308-7871-bedc-e6489b02190e`,
  ]);
});

test('recovery discards image prompt inputs instead of replaying them after resume', () => {
  for (const imageArgs of [['--image', 'old.png'], ['-i', 'old.png'], ['--image=old.png']]) {
    const setup = fixture();
    const result = spawnSync(
      setup.launcher,
      ['codex02', '--profile', 'review', ...imageArgs, '--', 'initial prompt'],
      {
        encoding: 'utf8',
        env: launchEnv(setup, { TRANSPORT_FAIL_ONCE: '1' }),
        timeout: 5000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const tuiLaunches = fs.readFileSync(setup.trace, 'utf8').trim().split('\n')
      .filter((line) => line.includes(`${setup.fakeCodex} --remote`));
    assert.equal(tuiLaunches.length, 2);
    assert.equal(tuiLaunches[1],
      `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock --profile review resume 019f3763-d308-7871-bedc-e6489b02190e`);
  }
});
