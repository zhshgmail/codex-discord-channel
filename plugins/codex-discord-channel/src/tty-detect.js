'use strict';

const path = require('node:path');

const NON_INTERACTIVE_CODEX_COMMANDS = new Set([
  'app-server',
  'exec',
  'review',
  'mcp',
  'mcp-server',
  'debug',
  'plugin',
  'login',
  'logout',
  'apply',
  'archive',
  'unarchive',
  'cloud',
  'exec-server',
  'remote-control',
  'completion',
  'doctor',
  'sandbox',
  'features',
  'help',
]);

function tokenizeArgs(args) {
  return String(args || '').trim().split(/\s+/).filter(Boolean);
}

function stripTokenQuotes(token) {
  return String(token || '').replace(/^["']|["']$/g, '');
}

function isCodexExecutableToken(token) {
  const base = path.basename(stripTokenQuotes(token));
  return base === 'codex' || base === 'codex.exe';
}

function isInteractiveCodexArgs(args) {
  const tokens = tokenizeArgs(args);
  const codexIndex = tokens.findIndex(isCodexExecutableToken);
  if (codexIndex === -1) return false;
  return !tokens
    .slice(codexIndex + 1)
    .some((token) => NON_INTERACTIVE_CODEX_COMMANDS.has(stripTokenQuotes(token)));
}

function parseCodexTtyCandidates(psOutput) {
  const candidates = [];
  for (const line of String(psOutput || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, rawPid, tty, args] = match;
    if (!tty.startsWith('pts/')) continue;
    if (!isInteractiveCodexArgs(args)) continue;
    candidates.push({ pid: Number(rawPid), tty: `/dev/${tty}`, args });
  }
  candidates.sort((a, b) => b.pid - a.pid);
  return candidates;
}

module.exports = {
  isInteractiveCodexArgs,
  parseCodexTtyCandidates,
};
