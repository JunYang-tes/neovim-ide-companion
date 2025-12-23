#!/usr/bin/env node
import { IDEServer } from './ide-server.js';
import logger from './log.js'

async function main() {
  if (!process.env['NVIM_LISTEN_ADDRESS']) {
    logger.error('NVIM_LISTEN_ADDRESS environment variable is not set.');
    logger.error('This application requires a running Neovim instance.');
    process.exit(1);
  }

  const portArg = process.argv.find((arg) => arg.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1], 10) : 0;

  const server = new IDEServer();
  await server.start(port);
}

main()
  .catch((err) => {
    logger.error("Crashed")
    logger.error(err);
    process.exit(1);
  })
