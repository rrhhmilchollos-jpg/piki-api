import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Request, Response } from "express";
import { PasskeyChallenge, PasskeyCredential } from "./models.js";

type OwnerType = "customer" | "employee";
type ChallengeKind = "registration" | "authentication";

type PasskeyOwner = { _id: unknown; name: string; email: string };

type PasskeyConfiguration = {
  rpID: string;
  origins: string[];
};

const challengeTtlMs = 5 * 60_000;

/**
 * The relying-party configuration is intentionally centralized and can be
 * changed per environment without changing credentials already registered.
 */
export function resolvePasskeyConfiguration(env: NodeJS.ProcessEnv = process.env): PasskeyConfiguration {
  const rpID = String(env.PASSKEY_RP_ID || "pikidelivery.com").trim();
  const origins = String(
    env.PASSKEY_ORIGINS ||
      "https://pikidelivery.com,https://www.pikidelivery.com,https://app.pikidelivery.com",
  )
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter((origin) => /^https:\/\/[a-z0-9.-]+$/i.test(origin));

  if (!rpID || !origins.length) throw new Error("PASSKEY_CONFIGURATION_INVALID");
  return { rpID, origins: [...new Set(origins)] };
}

function configuration() {
  return resolvePasskeyConfiguration();
}

function responseCredentialId(body: any) {
  return typeof body?.id === "string" ? body.id : typeof body?.rawId === "string" ? body.rawId : "";
}

async function rememberChallenge(input: {
  ownerType: OwnerType;
  ownerId: unknown;
  kind: ChallengeKind;
  challenge: string;
}) {
  const now = new Date();
  await PasskeyChallenge.updateMany(
    { ownerType: input.ownerType, ownerId: input.ownerId, kind: input.kind, consumedAt: null },
    { $set: { consumedAt: now } },
  ).exec();
  return PasskeyChallenge.create({
    ...input,
    expiresAt: new Date(now.getTime() + challengeTtlMs),
  });
}

async function activeChallenge(ownerType: OwnerType, ownerId: string, kind: ChallengeKind) {
  return PasskeyChallenge.findOne({
    ownerType,
    ownerId,
    kind,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean()
    .exec() as Promise<any>;
}

async function consumeChallenge(id: unknown) {
  return PasskeyChallenge.findOneAndUpdate(
    { _id: id, consumedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } },
    { new: true },
  )
    .lean()
    .exec();
}

export async function registrationOptions(
  _req: Request,
  res: Response,
  ownerType: OwnerType,
  owner: PasskeyOwner,
) {
  const { rpID } = configuration();
  const existing = await PasskeyCredential.find({ ownerType, ownerId: owner._id })
    .select("credentialId transports")
    .lean()
    .exec() as any[];
  const options = await generateRegistrationOptions({
    rpName: "PIKI Delivery",
    rpID,
    userName: owner.email,
    userDisplayName: owner.name,
    userID: Buffer.from(String(owner._id)),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports || [],
    })),
  });
  await rememberChallenge({ ownerType, ownerId: owner._id, kind: "registration", challenge: options.challenge });
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.json(options);
}

export async function verifyRegistration(
  req: Request,
  res: Response,
  ownerType: OwnerType,
  owner: Pick<PasskeyOwner, "_id">,
) {
  const saved = await activeChallenge(ownerType, String(owner._id), "registration");
  if (!saved) return res.status(400).json({ error: "PASSKEY_CHALLENGE_EXPIRED" });

  try {
    const { rpID, origins } = configuration();
    const result = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: saved.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo) {
      return res.status(400).json({ error: "PASSKEY_REGISTRATION_FAILED" });
    }
    if (!(await consumeChallenge(saved._id))) {
      return res.status(409).json({ error: "PASSKEY_CHALLENGE_ALREADY_USED" });
    }

    const info: any = result.registrationInfo;
    const credentialId = String(info.credential.id);
    const existing = await PasskeyCredential.findOne({ credentialId }).lean().exec() as any;
    if (existing && (existing.ownerType !== ownerType || String(existing.ownerId) !== String(owner._id))) {
      return res.status(409).json({ error: "PASSKEY_ALREADY_REGISTERED" });
    }
    if (!existing) {
      await PasskeyCredential.create({
        ownerType,
        ownerId: owner._id,
        credentialId,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: info.credential.counter,
        transports: Array.isArray(req.body?.response?.transports) ? req.body.response.transports : [],
      });
    }
    return res.json({ verified: true });
  } catch (error) {
    console.warn("Passkey registration verification failed", error instanceof Error ? error.name : "unknown");
    return res.status(400).json({ error: "PASSKEY_REGISTRATION_FAILED" });
  }
}

export async function authenticationOptions(
  _req: Request,
  res: Response,
  ownerType: OwnerType,
  ownerId: string,
) {
  const { rpID } = configuration();
  const allowedCredentials = await PasskeyCredential.find({ ownerType, ownerId })
    .select("credentialId transports")
    .lean()
    .exec() as any[];
  if (!allowedCredentials.length) return res.status(404).json({ error: "PASSKEY_NOT_REGISTERED" });

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: allowedCredentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports || [],
    })),
  });
  await rememberChallenge({ ownerType, ownerId, kind: "authentication", challenge: options.challenge });
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.json(options);
}

export async function verifyAuthentication(
  req: Request,
  res: Response,
  ownerType: OwnerType,
  ownerId: string,
) {
  const saved = await activeChallenge(ownerType, ownerId, "authentication");
  if (!saved) {
    res.status(400).json({ error: "PASSKEY_CHALLENGE_EXPIRED" });
    return null;
  }

  const credentialId = responseCredentialId(req.body);
  const credential = credentialId
    ? await PasskeyCredential.findOne({ ownerType, ownerId, credentialId }).lean().exec() as any
    : null;
  if (!credential) {
    res.status(404).json({ error: "PASSKEY_NOT_REGISTERED" });
    return null;
  }

  try {
    const { rpID, origins } = configuration();
    const result = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: saved.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      credential: {
        id: credential.credentialId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports || [],
      },
      requireUserVerification: true,
    });
    if (!result.verified) {
      res.status(401).json({ error: "PASSKEY_AUTHENTICATION_FAILED" });
      return null;
    }
    if (!(await consumeChallenge(saved._id))) {
      res.status(409).json({ error: "PASSKEY_CHALLENGE_ALREADY_USED" });
      return null;
    }
    await PasskeyCredential.updateOne(
      { _id: credential._id },
      { $set: { counter: result.authenticationInfo.newCounter } },
    ).exec();
    return { verified: true, ownerType, ownerId: String(credential.ownerId) };
  } catch (error) {
    console.warn("Passkey authentication verification failed", error instanceof Error ? error.name : "unknown");
    res.status(401).json({ error: "PASSKEY_AUTHENTICATION_FAILED" });
    return null;
  }
}
