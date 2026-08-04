'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  beginReply,
  sendDiscordReplyOnce,
} = require('../../src/reply-delivery');

const [mode, stateDir, markerPath] = process.argv.slice(2);
const config = {
  paths: {
    stateDir,
    replyReceiptDir: path.join(stateDir, 'reply-receipts'),
  },
};
const identity = { channelId: 'c1', sourceMessageId: 'm1' };
const args = { channelId: 'c1', replyTo: 'm1' };
const content = 'answer';

function appendMarker(value) {
  fs.appendFileSync(markerPath, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function run() {
  if (mode === 'crash-before-send') {
    await beginReply(config, identity, content);
    process.exit(73);
  }

  let preparedNonce = '';
  const result = await sendDiscordReplyOnce({
    args,
    config,
    content,
    preflight: async (_target, sendIdentity) => {
      preparedNonce = sendIdentity.nonce;
      return { sendIdentity };
    },
    reconciler: async (_target, _prepared, receipt) => {
      const markers = fs.existsSync(markerPath)
        ? fs.readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean)
        : [];
      const found = markers.includes(`remote:${receipt.nonce}`);
      return found
        ? { found: true, channelId: 'c1', messageId: 'remote-existing' }
        : { found: false };
    },
    sender: async () => {
      if (mode === 'crash-after-remote') {
        appendMarker(`remote:${preparedNonce}`);
        process.exit(74);
      }
      appendMarker(`send:${preparedNonce}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { channelId: 'c1', messageId: 'out-only' };
    },
    confirmer: async (_target, _prepared, sent) => sent,
  });
  process.stdout.write(`${JSON.stringify({
    duplicateSuppressed: result.duplicateSuppressed,
    messageId: result.messageId,
    reconciled: result.reconciled === true,
  })}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
