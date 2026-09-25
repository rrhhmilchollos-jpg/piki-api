from pathlib import Path
p=Path('/home/ubuntu/piki-api/src/server.ts')
s=p.read_text()
needle='app.post("/api/v1/zones", requireRole("admin", "fleet"), async (req, res) => {'
route='''app.get("/api/v1/riders/operational-map", requireRole("rider"), async (req, res) => {
  const employee = req.auth?.employeeId ? await EmployeeAccount.findById(req.auth.employeeId).select("zoneSlugs fleetId").lean().exec() as any : null;
  const zoneSlugs = Array.isArray(employee?.zoneSlugs) ? employee.zoneSlugs.filter((value: unknown): value is string => typeof value === "string") : [];
  const filter: Record<string, unknown> = { isActive: true };
  if (zoneSlugs.length) filter.slug = { $in: zoneSlugs };
  const zones = await Zone.find(filter).select("slug name isActive polygon").sort({ name: 1 }).lean().exec();
  return res.json({ zones, source: "piki-api", refreshedAt: new Date().toISOString() });
});
'''
if route not in s:
    s=s.replace(needle, route+needle)
p.write_text(s)
''