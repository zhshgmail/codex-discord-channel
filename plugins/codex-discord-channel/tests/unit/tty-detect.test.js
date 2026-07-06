'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isInteractiveCodexArgs,
  parseCodexTtyCandidates,
} = require('../../src/tty-detect');

test('interactive Codex detector accepts TUI commands', () => {
  assert.equal(isInteractiveCodexArgs('codex'), true);
  assert.equal(isInteractiveCodexArgs('codex resume 019e'), true);
  assert.equal(isInteractiveCodexArgs('node /home/test/bin/codex --dangerously-bypass-approvals-and-sandbox resume'), true);
  assert.equal(isInteractiveCodexArgs('/home/test/vendor/bin/codex --dangerously-bypass-approvals-and-sandbox'), true);
});

test('interactive Codex detector rejects non-interactive commands', () => {
  assert.equal(isInteractiveCodexArgs('codex exec "prompt"'), false);
  assert.equal(isInteractiveCodexArgs('codex mcp-server'), false);
  assert.equal(isInteractiveCodexArgs('node ./src/mcp-server.js'), false);
  assert.equal(isInteractiveCodexArgs('codex plugin add test'), false);
});

test('parseCodexTtyCandidates returns newest interactive pts candidate', () => {
  const output = [
    ' 100 pts/1    codex exec "prompt"',
    ' 101 pts/2    codex resume 019e',
    ' 102 ?        codex resume 019f',
    ' 103 pts/3    node /home/test/bin/codex --dangerously-bypass-approvals-and-sandbox',
    '',
  ].join('\n');

  assert.deepEqual(parseCodexTtyCandidates(output), [
    { pid: 103, tty: '/dev/pts/3', args: 'node /home/test/bin/codex --dangerously-bypass-approvals-and-sandbox' },
    { pid: 101, tty: '/dev/pts/2', args: 'codex resume 019e' },
  ]);
});
