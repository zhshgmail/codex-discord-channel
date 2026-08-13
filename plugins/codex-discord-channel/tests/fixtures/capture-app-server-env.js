'use strict';

const fs = require('node:fs');

const output = process.env.CODEX_TEST_CAPTURE_PATH;
if (!output) process.exit(2);
fs.writeFileSync(output, JSON.stringify({
  argv: process.argv.slice(2),
  codexHome: process.env.CODEX_HOME,
  discordInstance: process.env.DISCORD_INSTANCE,
  discordStateDir: process.env.DISCORD_CONFIG_DIR,
  appServerUrl: process.env.CODEX_DISCORD_APP_SERVER_URL,
  discordBotTokenPresent: process.env.DISCORD_BOT_TOKEN !== undefined,
  codexTargetThreadIdPresent: process.env.CODEX_TARGET_THREAD_ID !== undefined,
}));
