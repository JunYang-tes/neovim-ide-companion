import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  isInitializeRequest,
  type JSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { Server as HTTPServer } from 'node:http';
import { z } from 'zod';
import { DiffManager } from './diff-manager.js';
import logger from './log.js';
import { OpenFilesManager } from './open-files-manager.js';
import { ClaudeIdeServer } from './claude.js'
import { GeminiIdeServer } from './gemini.js';
import { PORT_IN_USE } from './exit-code.js';

const MCP_SESSION_ID_HEADER = 'mcp-session-id';

function sendIdeContextUpdateNotification(
  transport: StreamableHTTPServerTransport,
  openFilesManager: OpenFilesManager,
) {
  const ideContext = openFilesManager.state;

  const notification: JSONRPCNotification = {
    jsonrpc: '2.0',
    method: 'ide/contextUpdate',
    params: ideContext,
  };
  transport.send(notification);
}

export class IDEServer {
  private server: HTTPServer | undefined;
  diffManager: DiffManager;
  openFilesManager: OpenFilesManager;
  claudeIdeServer = new ClaudeIdeServer();
  geminiIdeServer: GeminiIdeServer;

  constructor() {
    this.diffManager = new DiffManager();
    this.openFilesManager = new OpenFilesManager();
    this.geminiIdeServer = new GeminiIdeServer(this.openFilesManager);
  }

  async start(port: number) {
    await this.openFilesManager.initialize();

    const sessionsWithInitialNotification = new Set<string>();
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } =
      {};

    const app = express();
    app.use(express.json());
    this.claudeIdeServer.start(app, port);
    this.geminiIdeServer.start(app)
    this.server = app.listen(port, (err) => {
      if (err) {
        logger.err(err, "Failed to start IDE server")
        process.exit(PORT_IN_USE);
      }
      const address = (this.server as HTTPServer).address();
      if (address && typeof address !== 'string') {
        const port = address.port;
        // Instead of environment variables, just log the port
        logger.info(`IDE server listening on port ${port}`);
      }
    }
    );
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err?: Error) => {
          if (err) {
            logger.error(`Error shutting down IDE server: ${err.message}`);
            return reject(err);
          }
          logger.info(`IDE server shut down`);
          resolve();
        });
      });
      this.server = undefined;
    }
  }
}

