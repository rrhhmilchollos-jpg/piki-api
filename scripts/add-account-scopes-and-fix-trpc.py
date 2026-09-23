from pathlib import Path

p=Path('src/models.ts'); s=p.read_text()
s=s.replace('apiRole: { type: String, enum: ["admin", "partner", "rider", "fleet"], required: true, index: true }, restaurantId:', 'apiRole: { type: String, enum: ["admin", "partner", "rider", "fleet", "commercial"], required: true, index: true }, portfolioId: { type: String, required: true, unique: true, index: true, default: lambda: "portfolio_" + str(__import__("uuid").uuid4()) }, fleetId: { type: Schema.Types.ObjectId, ref: "Fleet", default: null, index: true }, zoneSlugs: { type: [String], default: [] }, restaurantId:')
s=s.replace('email: { type: String, default: "" }, phone:', 'email: { type: String, default: "" }, commercialEmployeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null, index: true }, phone:')
# replace invalid generated JS lambda with a valid JS function
s=s.replace('default: lambda: "portfolio_" + str(__import__("uuid").uuid4())', 'default: () => `portfolio_${new mongoose.Types.ObjectId().toString()}`')
p.write_text(s)

p=Path('src/auth.ts'); s=p.read_text()
s=s.replace('export const apiRoles = ["admin", "partner", "rider", "fleet"] as const;', 'export const apiRoles = ["admin", "partner", "rider", "fleet", "commercial"] as const;')
s=s.replace('["fleet", process.env.FLEET_API_TOKEN],\n];', '["fleet", process.env.FLEET_API_TOKEN],\n  ["commercial", process.env.COMMERCIAL_API_TOKEN],\n];')
p.write_text(s)

p=Path('src/server.ts'); s=p.read_text()
s=s.replace('apiRole: z.enum(["admin", "partner", "rider", "fleet"]).optional(), restaurantId:', 'apiRole: z.enum(["admin", "partner", "rider", "fleet", "commercial"]).optional(), restaurantId:')
s=s.replace('restaurantId: z.string().regex(/^[a-f\\d]{24}$/).nullable().optional() });', 'restaurantId: z.string().regex(/^[a-f\\d]{24}$/).nullable().optional(), fleetId: z.string().regex(/^[a-f\\d]{24}$/).nullable().optional(), zoneSlugs: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(100).default([]) });')
s=s.replace('parsed.data.jobRole === "zone_manager" || parsed.data.jobRole === "commercial" ? "admin" : parsed.data.jobRole', 'parsed.data.jobRole === "commercial" ? "commercial" : parsed.data.jobRole === "zone_manager" ? "fleet" : parsed.data.jobRole')
s=s.replace('restaurantId: parsed.data.restaurantId ? objectId(parsed.data.restaurantId) : null, apiRole,', 'restaurantId: parsed.data.restaurantId ? objectId(parsed.data.restaurantId) : null, fleetId: parsed.data.fleetId ? objectId(parsed.data.fleetId) : null, apiRole,')
s=s.replace('jobRole: employee.jobRole, apiRole: employee.apiRole }', 'jobRole: employee.jobRole, apiRole: employee.apiRole, portfolioId: employee.portfolioId, fleetId: employee.fleetId, zoneSlugs: employee.zoneSlugs }')
s=s.replace('jobRole: employee.jobRole, apiRole: employee.apiRole, active: employee.active }', 'jobRole: employee.jobRole, apiRole: employee.apiRole, portfolioId: employee.portfolioId, fleetId: employee.fleetId, zoneSlugs: employee.zoneSlugs, active: employee.active }')
s=s.replace('select("name email jobRole apiRole active mustChangePassword lastLoginAt createdAt")', 'select("name email jobRole apiRole portfolioId fleetId zoneSlugs active mustChangePassword lastLoginAt createdAt")')
old='app.get("/api/v1/fleets", requireRole("admin", "fleet"), async (_req, res) => {\n  const fleets = await Fleet.find({}).sort({ name: 1 }).lean().exec();'
new='app.get("/api/v1/fleets", requireRole("admin", "fleet"), async (req, res) => {\n  const employee = req.auth?.employeeId ? await EmployeeAccount.findById(req.auth.employeeId).select("fleetId").lean().exec() as any : null;\n  const filter = req.auth?.role === "fleet" ? { _id: employee?.fleetId || null } : {};\n  const fleets = await Fleet.find(filter).sort({ name: 1 }).lean().exec();'
s=s.replace(old,new)
marker='app.get("/api/v1/admin/restaurants", requireRole("admin"), async (req, res) => {'
endpoint='''app.get("/api/v1/commercial/portfolio", requireRole("commercial"), async (req, res) => {
  const employeeId = req.auth?.employeeId;
  const employee = employeeId ? await EmployeeAccount.findById(employeeId).select("portfolioId").lean().exec() as any : null;
  const restaurants = employeeId ? await Restaurant.find({ commercialEmployeeId: objectId(employeeId) }).sort({ createdAt: -1 }).lean().exec() : [];
  return res.json({ portfolioId: employee?.portfolioId || null, restaurants });
});

app.patch("/api/v1/admin/restaurants/:id/assign-commercial", requireRole("admin"), async (req, res) => {
  const restaurantId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  const commercialId = objectId(String(req.body?.employeeId || ""));
  if (!restaurantId || !commercialId) return res.status(400).json({ error: "INVALID_ASSIGNMENT" });
  const commercial = await EmployeeAccount.findOne({ _id: commercialId, jobRole: "commercial", active: true }).lean().exec() as any;
  if (!commercial) return res.status(404).json({ error: "COMMERCIAL_ACCOUNT_NOT_FOUND" });
  const restaurant = await Restaurant.findByIdAndUpdate(restaurantId, { $set: { commercialEmployeeId: commercialId } }, { new: true }).lean().exec();
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  return res.json({ restaurant, portfolioId: commercial.portfolioId });
});

'''
s=s.replace(marker,endpoint+marker)
p.write_text(s)

p=Path('src/customerCompat.ts'); s=p.read_text()
old='function fail(res: Response, message: string, code = "BAD_REQUEST") { return res.status(400).json({ error: { json: { message, data: { code } } } }); }'
new='function fail(res: Response, message: string, code = "BAD_REQUEST") { const status = code === "UNAUTHORIZED" || code === "AUTH_REQUIRED" ? 401 : code === "CONFLICT" ? 409 : code === "NOT_FOUND" ? 404 : code === "STRIPE_UNAVAILABLE" ? 503 : 400; return res.status(status).json({ error: { json: { message, code: -32000, data: { code, httpStatus: status } } } }); }'
s=s.replace(old,new)
p.write_text(s)
