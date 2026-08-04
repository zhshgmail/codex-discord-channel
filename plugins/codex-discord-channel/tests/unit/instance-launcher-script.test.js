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

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-launch-script-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex02');
  const binDir = path.join(home, 'bin');
  const trace = path.join(home, 'trace.log');
  const loginMarker = path.join(home, 'login-complete');
  const loginExitMarker = path.join(home, 'login-exit');
  const transportFailMarker = path.join(home, 'transport-fail-once');
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
    `FAKE_CHANNEL_BIN_CONST=${shellLiteral(fakeChannel)}`,
    `FAKE_CODEX_BIN_CONST=${shellLiteral(fakeCodex)}`,
    `LOGIN_MARKER_CONST=${shellLiteral(loginMarker)}`,
    `LOGIN_EXIT_MARKER_CONST=${shellLiteral(loginExitMarker)}`,
    `STATE_DIR_CONST=${shellLiteral(stateDir)}`,
    `THREAD_ID_CONST=${shellLiteral('019f3763-d308-7871-bedc-e6489b02190e')}`,
    `TRACE_CONST=${shellLiteral(trace)}`,
    `TRANSPORT_FAIL_MARKER_CONST=${shellLiteral(transportFailMarker)}`,
    `TUI_COUNT_CONST=${shellLiteral(path.join(home, 'tui-count'))}`,
    'if [[ $1 == "$FAKE_CHANNEL_BIN_CONST" && $2 == tui-recovery-target ]]; then',
    '  case $3 in',
    '    clear) rm -f "$STATE_DIR_CONST/tui-recovery-target.json" "$STATE_DIR_CONST/tui-recovery-target.invalid" "$STATE_DIR_CONST/tui-recovery-capture-id"; exit 0 ;;',
    '    snapshot)',
    '      if [[ -f $STATE_DIR_CONST/app-server-target.json ]]; then',
    '        cp "$STATE_DIR_CONST/app-server-target.json" "$STATE_DIR_CONST/tui-recovery-target.json"',
    '        printf "%s\\n" "$4" >"$STATE_DIR_CONST/tui-recovery-capture-id"',
    '        exit 0',
    '      fi',
    '      exit 10',
    '      ;;',
    '    read)',
    '      if [[ -f $STATE_DIR_CONST/tui-recovery-target.json && -f $STATE_DIR_CONST/tui-recovery-capture-id && $(<"$STATE_DIR_CONST/tui-recovery-capture-id") == "$4" ]]; then',
    '        printf "%s\\n" "$THREAD_ID_CONST"',
    '        exit 0',
    '      fi',
    '      exit 10',
    '      ;;',
    '  esac',
    'fi',
    'printf "node %s\\n" "$*" >>"$TRACE_CONST"',
    'if [[ ${LOGIN_REQUIRED:-0} == 1 && $2 == tui-login-state && ! -f $LOGIN_MARKER_CONST ]]; then exit 10; fi',
    'if [[ $1 == "$FAKE_CODEX_BIN_CONST" ]]; then',
    '  while IFS= read -r -d "" entry; do',
    '    key=${entry%%=*}',
    '    case $key in',
    '      DISCORD_*|CODEX_DISCORD_*) printf "leaked environment: %s\\n" "$key" >&2; exit 92 ;;',
    '    esac',
    '  done < <(/usr/bin/env -0)',
    'fi',
    'if [[ $1 == "$FAKE_CODEX_BIN_CONST" && $2 == login ]]; then',
    '  if [[ -f $LOGIN_EXIT_MARKER_CONST ]]; then read -r login_exit <"$LOGIN_EXIT_MARKER_CONST"; exit "$login_exit"; fi',
    '  touch "$LOGIN_MARKER_CONST"',
    'fi',
    'if [[ $1 == "$FAKE_CODEX_BIN_CONST" && $2 == --remote && -f $TRANSPORT_FAIL_MARKER_CONST ]]; then',
    '  count=0',
    '  [[ -f $TUI_COUNT_CONST ]] && read -r count <"$TUI_COUNT_CONST"',
    '  count=$((count + 1))',
    '  printf "%s\\n" "$count" >"$TUI_COUNT_CONST"',
    '  if ((count == 1)); then',
    '    printf "{\\"version\\":1,\\"threadId\\":\\"%s\\",\\"status\\":\\"active\\",\\"activeTurnId\\":\\"turn-1\\",\\"loadedThreadIds\\":[\\"%s\\"]}\\n" "$THREAD_ID_CONST" "$THREAD_ID_CONST" >"$STATE_DIR_CONST/app-server-target.json"',
    '    sleep 0.4',
    '    rm -f "$STATE_DIR_CONST/app-server.sock"',
    '    python3 - "$STATE_DIR_CONST/app-server.sock" <<\'PY\'',
    'import socket, sys',
    'sock = socket.socket(socket.AF_UNIX)',
    'sock.bind(sys.argv[1])',
    'sock.close()',
    'PY',
    '    exit 71',
    '  fi',
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
  return {
    binDir,
    codexHome,
    fakeChannel,
    fakeCodex,
    home,
    loginExitMarker,
    loginMarker,
    stateDir,
    trace,
    transportFailMarker,
    tuiCount: path.join(home, 'tui-count'),
  };
}

function launchEnv(setup, overrides = {}) {
  return {
    ...process.env,
    DISCORD_BOT_TOKEN: 'fixture-secret',
    DISCORD_BOT_USER_ID: 'fixture-bot',
    DISCORD_CONFIG_DIR: setup.stateDir,
    FAKE_CHANNEL_BIN: setup.fakeChannel,
    FAKE_CODEX_BIN: setup.fakeCodex,
    HOME: setup.home,
    LOGIN_MARKER: setup.loginMarker,
    PATH: `${setup.binDir}:${process.env.PATH}`,
    STATE_DIR: setup.stateDir,
    THREAD_ID: '019f3763-d308-7871-bedc-e6489b02190e',
    TRACE: setup.trace,
    TUI_COUNT: setup.tuiCount,
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
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock resume thread-2`,
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
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock`,
  ]);
});

test('cancelled first-run TTY login starts neither service nor TUI', () => {
  const setup = fixture();
  fs.writeFileSync(setup.loginExitMarker, '130\n');
  const result = spawnSync('/usr/bin/script', ['-qec', `${launcher} codex02`, '/dev/null'], {
    encoding: 'utf8',
    env: launchEnv(setup, { LOGIN_REQUIRED: '1' }),
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

test('shell launcher resumes the exact captured thread after app-server replacement', () => {
  const setup = fixture();
  fs.writeFileSync(setup.transportFailMarker, '1\n');
  const result = spawnSync(
    launcher,
    ['codex02', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--last'],
    {
      encoding: 'utf8',
      env: launchEnv(setup),
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

test('shell launcher strips every Discord-prefixed variable from the TUI child', () => {
  const setup = fixture();
  const result = spawnSync(launcher, ['codex02', 'resume', 'thread-2'], {
    encoding: 'utf8',
    env: launchEnv(setup, {
      'CODEX_DISCORD_BAD-NAME': 'invalid-codex-discord-name',
      CODEX_DISCORD_UNKNOWN_SECRET: 'unknown-codex-discord-secret',
      'DISCORD_BAD-NAME': 'invalid-discord-name',
      DISCORD_PROXY_URL: 'fixture-proxy-secret',
      DISCORD_UNKNOWN_SECRET: 'unknown-discord-secret',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
});

test('shell launcher strips invalid Discord-prefixed names from the login child', () => {
  const setup = fixture();
  const command = `${launcher} codex02`;
  const result = spawnSync('/usr/bin/script', ['-qec', command, '/dev/null'], {
    encoding: 'utf8',
    env: launchEnv(setup, {
      'CODEX_DISCORD_BAD-NAME': 'invalid-codex-discord-name',
      'DISCORD_BAD-NAME': 'invalid-discord-name',
      DISCORD_PROXY_URL: 'fixture-proxy-secret',
      LOGIN_REQUIRED: '1',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(setup.loginMarker), true);
});

test('recovery appends exact resume while preserving flags from a non-resume launch', () => {
  const setup = fixture();
  fs.writeFileSync(setup.transportFailMarker, '1\n');
  const result = spawnSync(
    launcher,
    ['codex02', '--dangerously-bypass-approvals-and-sandbox', '--profile', 'review'],
    {
      encoding: 'utf8',
      env: launchEnv(setup),
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

test('recovery replaces only the resume operand and preserves all trailing arguments in order', () => {
  const setup = fixture();
  fs.writeFileSync(setup.transportFailMarker, '1\n');
  const result = spawnSync(
    launcher,
    [
      'codex02',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      '--profile',
      'after',
      '--sandbox',
      'read-only',
      '--no-alt-screen',
      'old-thread-id',
      'continue the first prompt',
      'then preserve the second prompt',
    ],
    {
      encoding: 'utf8',
      env: launchEnv(setup),
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const tuiLaunches = fs.readFileSync(setup.trace, 'utf8').trim().split('\n')
    .filter((line) => line.includes(`${setup.fakeCodex} --remote`));
  assert.deepEqual(tuiLaunches, [
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock --dangerously-bypass-approvals-and-sandbox resume --profile after --sandbox read-only --no-alt-screen old-thread-id continue the first prompt then preserve the second prompt`,
    `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock --dangerously-bypass-approvals-and-sandbox resume --profile after --sandbox read-only --no-alt-screen 019f3763-d308-7871-bedc-e6489b02190e continue the first prompt then preserve the second prompt`,
  ]);
});

test('recovery preserves variadic image values and replaces only the parsed resume operand', () => {
  const cases = [
    {
      name: 'images after resume',
      args: ['resume', '-i', 'one.png', 'two.png', 'old-thread', 'continue'],
      recovered: 'resume -i one.png two.png 019f3763-d308-7871-bedc-e6489b02190e continue',
    },
    {
      name: 'images before resume',
      args: ['-i', 'one.png', 'two.png', 'resume', 'old-thread', 'continue'],
      recovered: '-i one.png two.png resume 019f3763-d308-7871-bedc-e6489b02190e continue',
    },
    {
      name: 'images after the resume operand',
      args: ['resume', 'old-thread', '--image', 'one.png', 'two.png', 'continue'],
      recovered: 'resume 019f3763-d308-7871-bedc-e6489b02190e --image one.png two.png continue',
    },
    {
      name: 'resume options after images',
      args: [
        '--profile',
        'before',
        'resume',
        '--image',
        'one.png',
        'two.png',
        '--sandbox',
        'read-only',
        'old-thread',
        'continue',
      ],
      recovered: '--profile before resume --image one.png two.png --sandbox read-only 019f3763-d308-7871-bedc-e6489b02190e continue',
    },
  ];

  for (const item of cases) {
    const setup = fixture();
    fs.writeFileSync(setup.transportFailMarker, '1\n');
    const result = spawnSync(launcher, ['codex02', ...item.args], {
      encoding: 'utf8',
      env: launchEnv(setup),
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${item.name}: ${result.stderr}`);
    const tuiLaunches = fs.readFileSync(setup.trace, 'utf8').trim().split('\n')
      .filter((line) => line.includes(`${setup.fakeCodex} --remote`));
    assert.equal(
      tuiLaunches[1],
      `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock ${item.recovered}`,
      item.name,
    );
  }
});

test('recovery appends resume without consuming image values or option values as a subcommand', () => {
  const cases = [
    {
      name: 'separated variadic images without resume',
      args: ['-i', 'one.png', 'two.png', 'prompt'],
      recovered: '-i one.png two.png prompt resume 019f3763-d308-7871-bedc-e6489b02190e',
    },
    {
      name: 'resume is a global option value',
      args: ['--profile', 'resume', '--image=one.png,two.png'],
      recovered: '--profile resume --image=one.png,two.png resume 019f3763-d308-7871-bedc-e6489b02190e',
    },
    {
      name: 'resume option value before separated variadic images',
      args: ['--profile', 'resume', '-i', 'one.png', 'two.png', 'prompt'],
      recovered: '--profile resume -i one.png two.png prompt resume 019f3763-d308-7871-bedc-e6489b02190e',
    },
  ];

  for (const item of cases) {
    const setup = fixture();
    fs.writeFileSync(setup.transportFailMarker, '1\n');
    const result = spawnSync(launcher, ['codex02', ...item.args], {
      encoding: 'utf8',
      env: launchEnv(setup),
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${item.name}: ${result.stderr}`);
    const tuiLaunches = fs.readFileSync(setup.trace, 'utf8').trim().split('\n')
      .filter((line) => line.includes(`${setup.fakeCodex} --remote`));
    assert.equal(
      tuiLaunches[1],
      `node ${setup.fakeCodex} --remote unix://${setup.stateDir}/app-server.sock ${item.recovered}`,
      item.name,
    );
  }
});
