import test from "node:test";
import assert from "node:assert/strict";
import { composeCorporateMime } from "./corporateEmail.js";

test("the real MailComposer constructor builds MIME in memory without SMTP or IMAP", async () => {
  const raw = await composeCorporateMime({ from: "sender@example.invalid", to: "recipient@example.invalid", subject: "PIKI offline", text: "Solo memoria" });
  assert(Buffer.isBuffer(raw));
  const mime = raw.toString("utf8");
  assert(mime.includes("To: recipient@example.invalid"));
  assert(mime.includes("Subject: PIKI offline"));
  assert(mime.includes("Solo memoria"));
});
