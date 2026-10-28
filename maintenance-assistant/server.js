require("dotenv").config();
const express = require("express");
const config = require("./config");
const { runOrchestrator } = require("./orchestrator");
const { buildOverview, buildSchedule } = require("./insights");
const { buildForecast } = require("./forecast");
const { writeReading } = require("./simulation");
const { restoreInitialData } = require("./restore");

const { db } = config;

const app = express();
app.use(express.json());

// Reject cross-site writes; the settings endpoints can change the database connection.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin && new URL(origin).host !== req.headers.host) {
    return res.status(403).json({ error: "cross-origin request blocked" });
  }
  next();
});
app.get("/", (_req, res) => res.redirect("/dashboard.html"));
app.use(express.static("public"));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(e.status || 500).json({ error: e.message }));

app.get("/api/containers", wrap(async (_req, res) => {
  const { resources } = await db.containers.readAll().fetchAll();
  res.json(resources.map((c) => ({ id: c.id, partitionKey: c.partitionKey?.paths })));
}));

app.get("/api/items", wrap(async (req, res) => {
  const container = db.container(String(req.query.container));
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const q = String(req.query.q || "").toLowerCase();
  const querySpec = q
    ? {
        query: "SELECT TOP @limit * FROM c WHERE CONTAINS(LOWER(ToString(c)), @q)",
        parameters: [{ name: "@limit", value: limit }, { name: "@q", value: q }],
      }
    : { query: "SELECT TOP @limit * FROM c", parameters: [{ name: "@limit", value: limit }] };
  const { resources } = await container.items.query(querySpec).fetchAll();
  res.json(resources);
}));

const all = async (name, query = "SELECT * FROM c", parameters = []) => {
  const { resources } = await db.container(name).items.query({ query, parameters }).fetchAll();
  return resources;
};
const strip = ({ _rid, _self, _etag, _attachments, _ts, ...rest }) => rest;

app.get("/api/machines", wrap(async (_req, res) => {
  res.json((await all("Machines")).map(strip));
}));

app.get("/api/machines/:id/details", wrap(async (req, res) => {
  const p = [{ name: "@id", value: req.params.id }];
  const [workOrders, history] = await Promise.all([
    all("WorkOrders", "SELECT * FROM c WHERE c.machineId = @id ORDER BY c.createdDate DESC", p),
    all("MaintenanceHistory", "SELECT * FROM c WHERE c.machineId = @id ORDER BY c.occurrenceDate DESC", p),
  ]);
  res.json({ workOrders: workOrders.map(strip), history: history.map(strip) });
}));

app.get("/api/technicians", wrap(async (_req, res) => {
  res.json((await all("Technicians")).map(strip));
}));

app.get("/api/workorders", wrap(async (_req, res) => {
  res.json((await all("WorkOrders", "SELECT * FROM c ORDER BY c.createdDate DESC")).map(strip));
}));

app.post("/api/workorders", wrap(async (req, res) => {
  const { machineId, title, description, type, priority, assignedTo, scheduledDate } = req.body;
  if (!machineId || !title) return res.status(400).json({ error: "machineId and title are required" });
  const stamp = Date.now();
  const doc = {
    id: `wo-${stamp}`,
    workOrderNumber: `WO-${stamp}`,
    machineId,
    title,
    description: description || "",
    type: type || "corrective",
    priority: priority || "medium",
    status: "open",
    assignedTo: assignedTo || null,
    createdDate: new Date().toISOString(),
    scheduledDate: scheduledDate || null,
    partsUsed: [],
    cost: 0,
  };
  const { resource } = await db.container("WorkOrders").items.create(doc);
  res.status(201).json(strip(resource));
}));

app.get("/api/settings", wrap(async (_req, res) => res.json(config.publicSettings())));
app.post("/api/settings/test", wrap(async (req, res) => {
  try { res.json({ ok: true, ...(await config.testCosmos(req.body || {})) }); }
  catch (e) { res.status(e.status || 200).json({ ok: false, error: e.message }); }
}));
app.put("/api/settings", wrap(async (req, res) => res.json(config.save(req.body || {}))));
app.post("/api/settings/llm/test", wrap(async (_req, res) => {
  const llm = require("./llm");
  if (!llm.isConfigured()) return res.json({ ok: false, error: "Endpoint, deployment and key are all required." });
  try { await llm.chatJson("Reply with the JSON object {\"ok\": true}.", { ping: true }); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
}));

app.get("/api/agents", wrap(async (_req, res) => res.json(require("./agents").listAgents())));

app.get("/api/forecast/:machineId", wrap(async (req, res) => {
  res.json(await buildForecast(db, req.params.machineId, {
    assumeIntervalMin: Number(req.query.assumeIntervalMin) || null,
    horizonHours: Number(req.query.horizonHours) || 24,
  }));
}));

app.get("/api/overview", wrap(async (_req, res) => {
  res.json(await buildOverview(db));
}));

app.get("/api/schedule", wrap(async (req, res) => {
  res.json(await buildSchedule(db, String(req.query.date || "")));
}));

app.post("/api/orchestrate/:machineId", wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await runOrchestrator(db, req.params.machineId, {
    dryRun: b.dryRun === true,
    useLlm: b.useLlm !== false,
    crewOverride: Number(b.crewSize) || null,
    assumeIntervalMin: Number(b.assumeIntervalMin) || null,
  }));
}));

const STATUSES = ["open", "in_progress", "completed", "cancelled"];

// The container is partitioned by /status, so a status change moves the document.
app.patch("/api/workorders/:id", wrap(async (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "invalid status" });
  const [current] = await all("WorkOrders", "SELECT * FROM c WHERE c.id = @id", [
    { name: "@id", value: req.params.id },
  ]);
  if (!current) return res.status(404).json({ error: "not found" });
  if (current.status === status) return res.json(strip(current));
  const next = strip({ ...current, status });
  if (status === "completed") next.completedDate = new Date().toISOString();
  const container = db.container("WorkOrders");
  const { resource } = await container.items.create(next);
  await container.item(current.id, current.status).delete();
  // Role play: finishing the repair returns the machine's readings to normal.
  const simulation = status === "completed" && next.machineId ? await writeReading(db, next.machineId, "normal").catch(() => null) : null;
  res.json({ ...strip(resource), simulation });
}));

const deleteById = async (id) => {
  const [current] = await all("WorkOrders", "SELECT c.id, c.status FROM c WHERE c.id = @id", [{ name: "@id", value: id }]);
  if (!current) return false;
  await db.container("WorkOrders").item(current.id, current.status).delete();
  return true;
};

// Only work orders created by this app (ids wo-<timestamp> or wo-pm-<timestamp>); the original sample records are kept.
app.delete("/api/workorders", wrap(async (req, res) => {
  if (req.query.scope !== "generated") return res.status(400).json({ error: "scope=generated is required" });
  const ids = (await all("WorkOrders", "SELECT c.id FROM c")).map((w) => w.id).filter((id) => /^wo-(pm-)?\d{10,}$/.test(id));
  for (const id of ids) await deleteById(id);
  res.json({ deleted: ids.length });
}));

app.delete("/api/workorders/:id", wrap(async (req, res) => {
  if (!(await deleteById(req.params.id))) return res.status(404).json({ error: "not found" });
  res.json({ deleted: 1 });
}));

app.post("/api/machines/:id/simulate", wrap(async (req, res) => {
  res.json(await writeReading(db, req.params.id, String(req.body?.mode || "")));
}));

app.post("/api/restore-initial", wrap(async (req, res) => {
  if (req.body?.confirm !== "RESTORE") return res.status(400).json({ error: "confirmation missing" });
  res.json(await restoreInitialData(db));
}));

app.listen(process.env.PORT || 3000, "127.0.0.1", () =>
  console.log(`Maintenance screen: http://localhost:${process.env.PORT || 3000}`));
