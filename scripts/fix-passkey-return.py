from pathlib import Path
p=Path('/home/ubuntu/piki-api/src/passkeys.ts'); s=p.read_text()
s=s.replace('passkeyChallenges.delete(key); return res.json({ verified: true, ownerType, ownerId: String(credential.ownerId) });', 'passkeyChallenges.delete(key); return { verified: true, ownerType, ownerId: String(credential.ownerId) };')
p.write_text(s)
p=Path('/home/ubuntu/piki-api/src/server.ts'); s=p.read_text()
s=s.replace('const result = await verifyAuthentication(req, res, "customer"); if (res.headersSent || !result) return; const owner =', 'const result = await verifyAuthentication(req, res, "customer") as any; if (res.headersSent || !result) return; const owner =')
p.write_text(s)
