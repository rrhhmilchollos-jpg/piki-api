import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { Request, Response } from "express";
import { PasskeyCredential } from "./models.js";

export const passkeyChallenges = new Map<string, { challenge: string; ownerType: "customer" | "employee"; ownerId: string; kind: "registration" | "authentication"; expiresAt: number }>();
const rpID = process.env.PASSKEY_RP_ID || "pikidelivery.com";
const origins = (process.env.PASSKEY_ORIGINS || "https://pikidelivery.com,https://app.pikidelivery.com,https://admin.pikidelivery.com,https://partners.pikidelivery.com,https://riders.pikidelivery.com,https://fleet.pikidelivery.com").split(",");
function remember(key: string, value: Omit<typeof passkeyChallenges extends Map<any, infer V> ? V : never, never>) { passkeyChallenges.set(key, value); }
export async function registrationOptions(req: Request, res: Response, ownerType: "customer" | "employee", owner: { _id: any; name: string; email: string }) {
  const existing = await PasskeyCredential.find({ ownerType, ownerId: owner._id }).select("credentialId transports").lean().exec();
  const options = await generateRegistrationOptions({ rpName: "PIKI Delivery", rpID, userName: owner.email, userDisplayName: owner.name, userID: Buffer.from(String(owner._id)), attestationType: "none", excludeCredentials: existing.map((c: any) => ({ id: c.credentialId, transports: c.transports })) });
  remember(`${ownerType}:${owner._id}`, { challenge: options.challenge, ownerType, ownerId: String(owner._id), kind: "registration", expiresAt: Date.now() + 5 * 60_000 });
  return res.json(options);
}
export async function verifyRegistration(req: Request, res: Response, ownerType: "customer" | "employee", owner: { _id: any }) {
  const key = `${ownerType}:${owner._id}`; const saved = passkeyChallenges.get(key); if (!saved || saved.kind !== "registration" || saved.expiresAt < Date.now()) return res.status(400).json({ error: "PASSKEY_CHALLENGE_EXPIRED" });
  const result = await verifyRegistrationResponse({ response: req.body, expectedChallenge: saved.challenge, expectedOrigin: origins, expectedRPID: rpID });
  if (!result.verified || !result.registrationInfo) return res.status(400).json({ error: "PASSKEY_REGISTRATION_FAILED" });
  const info: any = result.registrationInfo; await PasskeyCredential.create({ ownerType, ownerId: owner._id, credentialId: info.credential.id, publicKey: Buffer.from(info.credential.publicKey), counter: info.credential.counter, transports: req.body.response?.transports || [] }); passkeyChallenges.delete(key); return res.json({ verified: true });
}
export async function authenticationOptions(req: Request, res: Response, ownerType: "customer" | "employee", ownerId?: string) {
  const allow = ownerId ? await PasskeyCredential.find({ ownerType, ownerId }).select("credentialId transports").lean().exec() : [];
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred", ...(allow.length ? { allowCredentials: allow.map((c: any) => ({ id: c.credentialId, transports: c.transports })) } : {}) });
  const key = `${ownerType}:auth:${ownerId || "discoverable"}`; remember(key, { challenge: options.challenge, ownerType, ownerId: ownerId || "", kind: "authentication", expiresAt: Date.now() + 5 * 60_000 }); return res.json(options);
}
export async function verifyAuthentication(req: Request, res: Response, ownerType: "customer" | "employee", ownerId?: string) {
  const key = `${ownerType}:auth:${ownerId || "discoverable"}`; const saved = passkeyChallenges.get(key); if (!saved || saved.expiresAt < Date.now()) return res.status(400).json({ error: "PASSKEY_CHALLENGE_EXPIRED" });
  const credentialId = req.body.id || req.body.rawId; const credential: any = await PasskeyCredential.findOne({ ownerType, credentialId }).lean().exec(); if (!credential) return res.status(404).json({ error: "PASSKEY_NOT_REGISTERED" });
  const result = await verifyAuthenticationResponse({ response: req.body, expectedChallenge: saved.challenge, expectedOrigin: origins, expectedRPID: rpID, credential: { id: credential.credentialId, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports } });
  if (!result.verified) return res.status(401).json({ error: "PASSKEY_AUTHENTICATION_FAILED" }); await PasskeyCredential.updateOne({ _id: credential._id }, { $set: { counter: result.authenticationInfo.newCounter } }).exec(); passkeyChallenges.delete(key); return { verified: true, ownerType, ownerId: String(credential.ownerId) };
}
