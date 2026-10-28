// Returns the data this app changed to its starting state: the original work orders and no simulated readings.
const fs = require("fs");
const path = require("path");

const BASELINE = path.join(__dirname, "seed", "initial-workorders.json");

async function restoreInitialData(db) {
  const q = async (name, query, parameters = []) => (await db.container(name).items.query({ query, parameters }).fetchAll()).resources;
  const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

  const workOrders = db.container("WorkOrders");
  const current = await q("WorkOrders", "SELECT c.id, c.status FROM c");
  for (const w of current) await workOrders.item(w.id, w.status).delete();
  for (const w of baseline) await workOrders.items.create(w);

  const telemetry = db.container("Telemetry");
  const simulated = await q("Telemetry", "SELECT c.id, c.machineId FROM c WHERE c.source = 'simulated'");
  for (const t of simulated) await telemetry.item(t.id, t.machineId).delete();

  return { workOrdersRemoved: current.length, workOrdersRestored: baseline.length, simulatedReadingsRemoved: simulated.length };
}

module.exports = { restoreInitialData };
