// Role-play helpers: write simulated telemetry so machines can be put into a fault state and returned to normal.
const round = (n) => Math.round(n * 100) / 100;

async function writeReading(db, machineId, mode) {
  const q = async (name, query, parameters = []) => (await db.container(name).items.query({ query, parameters }).fetchAll()).resources;
  const [machine] = await q("Machines", "SELECT * FROM c WHERE c.id = @id", [{ name: "@id", value: machineId }]);
  if (!machine) throw Object.assign(new Error(`machine ${machineId} not found`), { status: 404 });
  if (!["normal", "warning", "critical"].includes(mode)) throw Object.assign(new Error("mode must be normal, warning or critical"), { status: 400 });

  const [thresholds, latest] = await Promise.all([
    q("Thresholds", "SELECT * FROM c WHERE c.machineType = @t", [{ name: "@t", value: machine.type }]),
    q("Telemetry", "SELECT TOP 1 * FROM c WHERE c.machineId = @m ORDER BY c.timestamp DESC", [{ name: "@m", value: machineId }]),
  ]);

  const metrics = { ...(latest[0]?.metrics || {}) };
  const alerts = [];
  thresholds.forEach((t, i) => {
    const low = t.criticalThreshold < t.warningThreshold;
    const range = t.normalRange || {};
    const mid = range.min != null && range.max != null ? (range.min + range.max) / 2 : t.warningThreshold;
    // The first two monitored metrics carry the fault; the rest stay normal.
    if (mode === "normal" || i > 1) metrics[t.metric] = round(mid);
    else if (mode === "warning") { metrics[t.metric] = round(t.warningThreshold + 0.3 * (t.criticalThreshold - t.warningThreshold)); alerts.push(`${t.metric}_warning`); }
    else { metrics[t.metric] = round(t.criticalThreshold + (low ? -1 : 1) * Math.abs(t.criticalThreshold - t.warningThreshold) * 0.1); alerts.push(`${t.metric}_critical`); }
  });

  const doc = { id: `telemetry-sim-${machineId}-${Date.now()}`, machineId, timestamp: new Date().toISOString(), metrics, status: mode,
    ...(alerts.length ? { alerts } : {}), source: "simulated" };
  await db.container("Telemetry").items.create(doc);
  return { machineId, machineName: machine.name, mode, readingId: doc.id, metrics };
}

module.exports = { writeReading };
