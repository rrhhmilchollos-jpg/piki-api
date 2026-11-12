// Check-only preload: no dotenv/secrets, networking, listener or app bootstrap.
import fs from "node:fs";
import fsp from "node:fs/promises";
import childProcess from "node:child_process";
import dns from "node:dns";
import dgram from "node:dgram";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const secret = (path) => /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.user_env|[^/\\]*\.(?:pem|p12|pfx|key|crt|cer))$/i.test(path instanceof URL ? fileURLToPath(path) : String(path));
for (const target of [fs, fsp]) for (const method of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
  if (typeof target[method] !== "function") continue;
  const original = target[method];
  target[method] = function (path, ...args) { if (secret(path)) throw new Error("SECRET_FILE_READ_FORBIDDEN"); return original.call(this, path, ...args); };
}
const forbidden = () => { throw new Error("EXTERNAL_IO_FORBIDDEN"); };
for (const method of ["lookup", "resolve", "resolve4", "resolve6", "reverse"]) { dns[method] = forbidden; dns.promises[method] = forbidden; }
dgram.createSocket = forbidden;
net.Socket.prototype.connect = forbidden; net.Server.prototype.listen = forbidden;
http.request = forbidden; http.get = forbidden; https.request = forbidden; https.get = forbidden;
tls.connect = forbidden; globalThis.fetch = forbidden;
// The existing offline runner sanitizes its child environment. A preload in
// its parent alone would not protect the test process, so propagate explicitly.
const self = fileURLToPath(import.meta.url);
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function (command, args, options) {
  if (command !== process.execPath) throw new Error("UNAPPROVED_CHILD_PROCESS_FORBIDDEN");
  return spawnSync.call(this, command, ["--import", self, ...(args.includes("--test") ? ["--test-concurrency=4"] : []), ...args], options);
};
const spawn = childProcess.spawn;
childProcess.spawn = function (command, ...args) {
  // tsx's prepared esbuild compiler is the only permitted native subprocess.
  if (!/(?:@esbuild[/\\]linux-x64|esbuild)[/\\]bin[/\\]esbuild$/.test(String(command))) throw new Error("UNAPPROVED_CHILD_PROCESS_FORBIDDEN");
  return spawn.call(this, command, ...args);
};
for (const method of ["exec", "execFile", "execSync", "execFileSync", "fork"]) childProcess[method] = forbidden;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (/^(server|mongooseBoot|dispatch-worker)\.(js|ts)$/.test(specifier.split("/").at(-1))) throw new Error("APPLICATION_BOOT_IMPORT_FORBIDDEN");
  return nextResolve(specifier, context);
}});
syncBuiltinESMExports();
