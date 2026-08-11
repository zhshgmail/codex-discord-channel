'use strict';

const fs = require('node:fs');

const output = process.env.CODEX_TEST_CAPTURE_PATH;
if (!output) process.exit(2);
const argv = process.argv.slice(2);
const listenIndex = argv.indexOf('--listen');
fs.writeFileSync(output, JSON.stringify({
  argv,
  codexHome: process.env.CODEX_HOME,
  discordInstance: process.env.DISCORD_INSTANCE,
  discordStateDir: process.env.DISCORD_CONFIG_DIR,
  appServerUrl: listenIndex === -1 ? null : argv[listenIndex + 1],
  discordBotTokenPresent: process.env.DISCORD_BOT_TOKEN !== undefined,
  codexTargetThreadIdPresent: process.env.CODEX_TARGET_THREAD_ID !== undefined,
}));
