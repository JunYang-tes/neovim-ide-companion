import type { NeovimClient, Buffer, Window } from 'neovim';
import { fileURLToPath, pathToFileURL } from 'url';
import logger from './log.js';
import { attach, findNvim } from 'neovim'
import { isSameFile } from './fs.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export interface NeovimSession {
  client: NeovimClient;
  disconnect: () => void;
}

if (!process.env['NVIM_LISTEN_ADDRESS']) {
  logger.error('environment variable NVIM_LISTEN_ADDRESS is not set');
  if (!process.env.VITEST) {
    process.exit(1);
  }
}


let neovimProcess: ChildProcessWithoutNullStreams | null = null
export const nvim: NeovimClient = process.env.VITEST
  ? (() => {
    const found = findNvim({ orderBy: 'desc', minVersion: '0.9.0' })
    neovimProcess = spawn(found.matches[0].path, ['--clean', '--embed', '-u', "NORC"], {});
    return attach({ proc: neovimProcess });
  })()
  : (() => {
    const nvim = attach({
      socket: process.env['NVIM_LISTEN_ADDRESS'],
      options: {
        logger: logger
      }
    })
    nvim.on('disconnect', () => {
      logger.error('Neovim disconnected');
      process.exit(1);
    })
    return nvim
  })();

export function connectNewNeovim() {
  if (neovimProcess) {
    neovimProcess.kill()
  }
  const found = findNvim({ orderBy: 'desc', minVersion: '0.9.0' })
  neovimProcess = spawn(found.matches[0].path, ['--clean', '--embed', '-u', "NORC"], {});
  nvim.attach({
    reader: neovimProcess.stdout,
    writer: neovimProcess.stdin
  })
}

export async function onNotification(cb: (m: string, args: any[]) => boolean) {
  const notificationHandler = (m: string, args: any[]) => {
    if (cb(m, args)) {
      nvim.off('notification', notificationHandler);
    }
  }
  nvim.on('notification', notificationHandler);
}


export async function findWindow(
  predict: (win: Window) => Promise<boolean> | boolean,
) {
  const tabs = await nvim.tabpages;
  for (const tab of tabs) {
    const windows = await tab.windows;
    for (const win of windows) {
      if (await predict(win)) {
        return win;
      }
    }
  }
  return null;
}

export async function findBuffer(
  predict: (b: Buffer) => Promise<boolean> | boolean,
) {
  const buffers = await nvim.buffers;
  for (const buf of buffers) {
    if (await predict(buf)) {
      return buf;
    }
  }
  return null;
}

export async function findFileBuffer(file: string) {
  return findBuffer(async b => isSameFile(await b.name, file))
}

export async function mapBuffer<U>(f: (b: Buffer) => Promise<U>) {
  const buffers = await nvim.buffers;
  return (await Promise.all(buffers.map(f)))
}

export async function filterBuffer(
  predict: (b: Buffer) => Promise<boolean> | boolean
) {
  const buffers = await nvim.buffers;
  return (await Promise.all(buffers.map(async b => [b, await predict(b)] as const)))
    .filter(([b, p]) => p)
    .map(([b]) => b);
}


export function withResolvers<T>() {
  let resolve: (v: T | PromiseLike<T>) => void;
  let reject: (r?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve: resolve!,
    reject: reject!,
  };
}

export async function editInNewTab(filepathOrUrl: string) {
  const filepath = filepathOrUrl.startsWith("file://")
    ? fileURLToPath(filepathOrUrl)
    : filepathOrUrl;
  const swap = withResolvers<void>();
  const bufenter = withResolvers<void>();
  const ids: string[] = [];
  ids.push(
    (await registerAutocmd("SwapExists", { pattern: filepath }, (args: { buf: number }) => {
      if (args.buf !== 0) {
        swap.resolve();
        unregisterAutocmd(ids);
      }
    }))!,
  );
  ids.push(
    (await registerAutocmd("BufEnter", { pattern: filepath }, () => {
      bufenter.resolve();
      unregisterAutocmd(ids);
    }))!,
  );

  try {
    await nvim.command(`tabnew ${filepath}`);
  } catch (_e) {
  }
  return Promise.race([swap.promise, bufenter.promise]);
}

const autocmdCallbacks = new Map<
  string,
  // biome-ignore lint/suspicious/noConfusingVoidType: -_-!
  (...args: any[]) => void | boolean | Promise<undefined | boolean>
>();
let callbackIdCounter = 0;

export async function registerAutocmd(
  event: string | string[],
  option: {
    buffer?: number
    pattern?: string
  },
  // biome-ignore lint/suspicious/noConfusingVoidType: -_-!
  callback: (...args: any[]) => void | boolean | Promise<undefined | boolean>,
) {
  const method = "nvim_AUTOCMD_CALLBACK";
  if (callbackIdCounter === 0) {
    nvim.on("notification", (m: string, args: any[]) => {
      if (method === m) {
        const [callbackId, ...rest] = args;
        const cb = autocmdCallbacks.get(callbackId);
        if (cb) {
          // @ts-ignore
          Promise.resolve(cb(...rest)).then((unregister) => {
            if (unregister) {
              unregisterAutocmd(callbackId);
            }
          });
        }
      }
    });
  }

  const callbackId = `autocmd_${++callbackIdCounter}`;
  autocmdCallbacks.set(callbackId, callback);
  const channelId = await nvim.channelId;

  const luaCmd = `
		local event,buffer,pattern,callbackId,channelId,method=...
    local id
    local opt = {
      callback = function(...)
				local ok, err = pcall(vim.rpcnotify, channelId,method, callbackId,...)			
				if not ok then
					vim.api.nvim_del_autocmd(id)
				end
      end
    }
    if buffer >=0 then
      opt.buffer = buffer
    end
    if pattern ~= "" then
      opt.pattern = pattern
    end
	  id=vim.api.nvim_create_autocmd(event, opt)
  `;

  nvim.lua(luaCmd, [event, option.buffer ?? -1, option.pattern ?? "", callbackId, channelId, method]);
  return callbackId;
}
export function unregisterAutocmd(callbackId: string | string[]) {
  if (Array.isArray(callbackId)) {
    for (const id of callbackId) {
      autocmdCallbacks.delete(id);
    }
  } else {
    autocmdCallbacks.delete(callbackId);
  }
}
export async function createTransientBuffer(content: string, ft = "") {
  const buf = await createBuffer(content, ft);
  if (buf) {
    buf.setOption("bufhidden", "wipe");
    buf.setOption("swapfile", false);
  }
  return buf;
}

export async function createBuffer(content: string, ft = "") {
  nvim.command("tabnew");
  let buf = await nvim.createBuffer(false, true);
  if (typeof buf === "number") {
    buf = (await findBuffer(async (b) => b.id === buf))!;
  }

  buf.setLines(content.split("\n"), {
    start: 0,
    end: -1,
  });
  if (ft) {
    buf.setOption("filetype", ft);
  }

  await nvim.request("nvim_win_set_buf", [0, buf.id]);

  return buf;
}

export type DiffResult = 'accepted' | 'rejected'

let diffCounter = 0
export async function diff(oldPath: string, newPath: string) {
  await nvim.command(`tabnew ${newPath}`);
  await nvim.command(`vert diffsplit ${oldPath}`);

  const { promise, resolve } = withResolvers<DiffResult>();

  let resolved = false;

  const doResolve = async (result: DiffResult) => {
    logger.debug("resolve diff " + result)
    if (resolved) {
      return;
    }
    resolved = true;
    await Promise.all([
      findBuffer(async b => {
        const name = await b.name;
        return isSameFile(name, oldPath)
      })
        .then(b => {
          if (b) {
            logger.debug("delete buffer " + oldPath)
            return nvim.command(`bdelete! ${b.id}`)
          } else {
            logger.debug("Cannot find buffer corresponding to " + oldPath)
          }
        })
        .catch((e) => {
          logger.err(e, "Failed to delete buffer : " + oldPath)
        }),
      findBuffer(async b => isSameFile(await b.name, newPath))
        .then(async b => {
          if (b) {
            await nvim.request("nvim_win_set_buf", [0, b.id]);
            await nvim.command("w")
            await nvim.command(`bdelete! ${b.id}`)
          } else {
            logger.debug("Cannot find buffer corresponding to " + oldPath)
          }
        })
        .catch((e) => {
          logger.err(e, "Failed to delete buffer: " + oldPath)
        })
    ])
    resolve(result);
  };

  const acceptId = `diff_accept_${++diffCounter}`;
  const rejectId = `diff_reject_${++diffCounter}`;

  const leaveCallback = () => {
    doResolve("accepted");
    return true; // unregister self
  };

  //registerAutocmd(["BufWinLeave"], { pattern: oldPath }, leaveCallback)
  registerAutocmd(["BufWritePost"], { pattern: newPath }, leaveCallback)

  const channelId = await nvim.channelId;
  const method = "diff-keymap";

  const setKeymaps = async (bufnr: number) => {
    const luaCode = `
        print("set keymaps")
        local bufnr, channelId, method, acceptId, rejectId = ...
        vim.keymap.set('n', 'a', function() 
print("a")
            vim.rpcnotify(channelId, method, acceptId)
        end, { buffer = bufnr, nowait = true })
        vim.keymap.set('n', 'r', function() 
print("r")
            vim.rpcnotify(channelId, method, rejectId)
        end, { buffer = bufnr, nowait = true })
      `;
    await nvim.lua(luaCode, [bufnr, channelId, method, acceptId, rejectId]);
  };
  onNotification((m, args) => {
    if (m === method) {
      logger.debug("a or n pressed")
      if (args[0] === acceptId) {
        doResolve("accepted");
      } else if (args[0] === rejectId) {
        doResolve("rejected");
      }
      return true
    }
    return false
  })
  const [oldBuf, newBuf] = await Promise.all([
    findBuffer(async b => isSameFile(await b.name, oldPath)),
    findBuffer(async b => isSameFile(await b.name, newPath))
  ])
  if (oldBuf == null || newBuf == null) {
    logger.error("Cannot find buffers corresponding to " + oldPath + " and " + newPath)
    return promise
  }

  await setKeymaps(oldBuf.id as number);
  await setKeymaps(newBuf.id as number);
  for (const win of await nvim.windows) {
    const b = await win.buffer;
    if (b.id === newBuf.id) {
      await nvim.request("nvim_set_current_win", [win.id]);
      break;
    }
  }

  const nsId = await nvim.request('nvim_create_namespace', ["neovim-ide-companion-diff"]);
  const setVirtualText = async (bufnr: number) => {
    await nvim.request('nvim_buf_set_extmark', [bufnr, nsId, 0, -1, {
      virt_text: [[" a: accept all, r: reject all", "Comment"]],
      virt_text_pos: "inline",
    }]);
  };

  await setVirtualText(newBuf.id)
  await setVirtualText(oldBuf.id)


  return promise;
}

export async function tempEdit(content: string) {
  const buf = await createBuffer(content)
  if (buf == null || nvim == null) {
    return null
  }
  return new Promise<string>((res) => {
    registerAutocmd("BufWinLeave", { buffer: buf.id }, async (args: { buf: number }) => {
      const lines = await buf.getLines({ start: 0, end: -1, strictIndexing: false })
      nvim.command("bdelete! " + buf.id)
      res(lines.join("\n"))
      return true
    })
  })
}

export async function openFile(path: string) {
  const buf = await findBuffer(async b => isSameFile(await b.name, path))
  if (buf) {
    return buf
  }
  if (await isCurrentBufNeovimIdeCompanion()) {
    await nvim.lua(`local file = ...
  local file = ...
  local path = vim.fn.fnameescape(file)

  local group = vim.api.nvim_create_augroup("EditAnywayOnce", { clear = true })

  vim.api.nvim_create_autocmd("SwapExists", {
    group = group,
    pattern = "*",
    callback = function()
      vim.v.swapchoice = "e"
    end,
  })

  pcall(function()
    vim.cmd("split " .. path)
  end)

  vim.api.nvim_del_augroup_by_name("EditAnywayOnce")
    `, [path])
  } else {
    await nvim.lua(`
  local file = ...
  local path = vim.fn.fnameescape(file)

  local group = vim.api.nvim_create_augroup("EditAnywayOnce", { clear = true })

  vim.api.nvim_create_autocmd("SwapExists", {
    group = group,
    pattern = "*",
    callback = function()
      vim.v.swapchoice = "e"
    end,
  })

  pcall(function()
    vim.cmd("edit " .. path)
  end)

  vim.api.nvim_del_augroup_by_name("EditAnywayOnce")
    `, [path])
  }
  return await findBuffer(async b => isSameFile(await b.name, path))
}

/**
 * Diagnostic severity levels
 */
export const enum DiagnosticSeverity {
  /**
   * Reports an error.
   */
  Error = 1,
  /**
   * Reports a warning.
   */
  Warning = 2,
  /**
   * Reports an information.
   */
  Information = 3,
  /**
   * Reports a hint.
   */
  Hint = 4
}

/**
 * Represents a position in a text document.
 */
export interface Position {
  /**
   * Line position in a document (zero-based).
   */
  line: number;

  /**
   * Character offset on a line in a document (zero-based).
   */
  character: number;
}

/**
 * A range in a text document expressed as (zero-based) start and end positions.
 */
export interface Range {
  /**
   * The range's start position.
   */
  start: Position;

  /**
   * The range's end position.
   */
  end: Position;
}

/**
 * Represents a diagnostic, such as a compiler error or warning.
 */
export interface Diagnostic {
  /**
   * The range at which the message applies.
   */
  range: Range;

  /**
   * The diagnostic's severity.
   */
  severity: DiagnosticSeverity;

  /**
   * The diagnostic's message.
   */
  message: string;

  /**
   * The diagnostic's source.
   */
  source?: string;

  /**
   * The diagnostic's code.
   */
  code?: string | number;
}

async function getDiagnosticsBuf(bufnr: number): Promise<Diagnostic[]> {

  // Execute Lua code to get diagnostics from Neovim
  try {
    // @ts-ignore
    const diagnostics: any[] = await nvim.lua(`
			local bufnr = ...
			if bufnr == nil or bufnr == 0 then
				bufnr = vim.api.nvim_get_current_buf()
			end
			return vim.diagnostic.get(bufnr)
		`, [bufnr]);

    // Convert Neovim diagnostics to our Diagnostic format
    return diagnostics.map(d => ({
      range: {
        start: { line: d.lnum, character: d.col },
        end: { line: d.end_lnum !== undefined ? d.end_lnum : d.lnum, character: d.end_col !== undefined ? d.end_col : d.col }
      },
      severity: d.severity,
      message: d.message,
      source: d.source,
      code: d.code?.toString()
    }));
  } catch (error) {
    logger.err(error);
    return [];
  }
}

export async function getDiagnostics(filepath?: string): Promise<Array<{
  uri: string;
  diagnostics: Diagnostic[];
}>> {
  // If filepath is undefined, get all diagnostics from all buffers
  if (filepath === undefined) {
    const bufs = await nvim.buffers;
    return Promise.all(bufs.map(async buf => {
      const name = await buf.name;
      const diagnostics = await getDiagnosticsBuf(buf.id)
      return {
        uri: pathToFileURL(name).toString(),
        diagnostics
      }
    }))
      .then(diagnostics => diagnostics.filter(d => d.diagnostics.length > 0));
  }

  // Get the buffer for the specified filepath
  const buf = await findBuffer(async (b) => {
    const name = await b.name;
    return name === filepath;
  });

  if (!buf) {
    return [];
  }
  const diagnostics = await getDiagnosticsBuf(buf.id)
  if (diagnostics.length > 0) {
    return [{
      uri: pathToFileURL(filepath).toString(),
      diagnostics
    }]
  }
  return []
}
export async function isCurrentBufNeovimIdeCompanion() {
  // check if there is a var on current call called neovim-ide-companion-ts or is-neovim-ide-companion
  const buf = await nvim.buffer;
  return isNeovimIdeCompanionBuffer(buf);
}

export async function isNeovimIdeCompanionBuffer(buf: Buffer) {
  const ts = await buf.getVar("neovim-ide-companion-ts");
  if (ts) {
    return true;
  }
  const isCompanion = await buf.getVar("is-neovim-ide-companion");
  return Boolean(isCompanion);
}

export async function activeLastTermBuffer() {
  const buf = (await mapBuffer(async b => {
    const ts = Number(await b.getVar("neovim-ide-companion-ts")) || 0
    return [ts, b.id] as const
  }))
    .reduce((acc, [ts, id]) => {
      if (ts > acc.ts) {
        return { ts, id }
      }
      return acc
    }, { ts: 0, id: 0 })
  if (buf.id !== 0 && buf.ts !== 0) {
    const win = await findWindow(async w => {
      return (await w.buffer.id) === buf.id
    })
    if (win) {
      // Activate this window
      await nvim.request("nvim_set_current_win", [win.id]);
    } else {
      // If no window contains this buffer, create a new split with this buffer
      await nvim.command(`sbuffer ${buf.id}`);
    }
  }
}

export async function activeBuffer(buf: Buffer) {
  const win = await findWindow(async w => {
    return (await w.buffer.id) === buf.id
  })
  if (win) {
    // Activate this window
    await nvim.request("nvim_set_current_win", [win.id]);
  } else {
    // If no window contains this buffer, create a new split with this buffer
    await nvim.command(`sbuffer ${buf.id}`);
  }
}
