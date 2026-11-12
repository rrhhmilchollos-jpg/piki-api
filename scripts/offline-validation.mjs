// Local-only validation; no installation, dotenv, server, HTTP or database.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const dependencies = new URL("../package.json", import.meta.url).pathname;
const require = createRequire(dependencies);
const mode = process.argv[2];
if (mode === "check") {
  const ts = require("typescript");
  const parsed = ts.getParsedCommandLineOfConfigFile(resolve("tsconfig.json"), { noEmit: true, typeRoots: [resolve(dependencies, "../node_modules/@types")] }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } });
  const host = ts.createCompilerHost(parsed.options);
  host.resolveModuleNames = (names, containingFile) => names.map((name) => ts.resolveModuleName(name, containingFile, parsed.options, host).resolvedModule || ts.resolveModuleName(name, dependencies, parsed.options, host).resolvedModule);
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
  process.exitCode = diagnostics.length ? 1 : 0;
} else if (mode === "test") {
  const preload = `
    import { registerHooks, createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import tls from 'node:tls';
    const base = ${JSON.stringify(pathToFileURL(dependencies).href)};
    registerHooks({ resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); } catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) throw error;
        return nextResolve(specifier, { ...context, parentURL: base });
      }
    }});
    const forbidden = () => { throw new Error('EXTERNAL_IO_FORBIDDEN'); };
    net.Socket.prototype.connect = forbidden; net.Server.prototype.listen = forbidden;
    http.request = forbidden; http.get = forbidden; https.request = forbidden; https.get = forbidden;
    tls.connect = forbidden;
    globalThis.fetch = forbidden;
    const mongoose = createRequire(base)('mongoose');
    mongoose.set('bufferCommands', false); mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
    mongoose.connect = forbidden; mongoose.Connection.prototype.openUri = forbidden;
    mongoose.startSession = forbidden;
    mongoose.Query.prototype.exec = forbidden;
  `;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", PIKI_NO_LISTEN: "true", DOTENV_CONFIG_PATH: "/dev/null" };
  const files = process.argv.slice(3);
  const child = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "--import", pathToFileURL(require.resolve("tsx")).href, "--test", ...(files.length ? files : ["src/*.test.ts"])], { stdio: "inherit", env });
  process.exitCode = child.status ?? 1;
} else { console.error("Use: node scripts/offline-validation.mjs check|test [src/test-file.test.ts ...]"); process.exitCode = 2; }
