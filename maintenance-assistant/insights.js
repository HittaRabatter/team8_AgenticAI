// Fleet overview: risk per machine (telemetry vs thresholds, trend, failure history) and the parts to order.
const { evaluateBreaches, rankOf, createTools, readingsTable } = require("./orchestrator");
const { DAY, recommendOrder } = require("./procurement");
const { ACTIVE_STATUSES, shiftIntervals, MIN } = require("./scheduler");

const ACTIVE = ACTIVE_STATUSES;
const clean = ({ _rid, _self, _etag, _attachments, _ts, ...rest }) => rest;
const PRIORITY = { critical: 0, high: 1, medium: 2, low: 3 };

// Minutes until the driving metric reaches its critical limit, from the last two readings.
function projectTrend(readings, driver, threshold) {
  if (!driver || readings.length < 2) return null;
  const [last, prev] = readings;
  const v1 = last.metrics?.[driver.metric], v0 = prev.metrics?.[driver.metric];
  const minutes = (Date.parse(last.timestamp) - Date.parse(prev.timestamp)) / 60000;
  if (typeof v1 !== "number" || typeof v0 !== "number" || !(minutes > 0)) return null;
  const low = threshold.criticalThreshold < threshold.warningThreshold;
  const slope = (v1 - v0) / minutes;
  const remaining = threshold.criticalThreshold - v1;
  if (low ? remaining >= 0 : remaining <= 0) return { metric: driver.metric, projectedMinutesToCritical: 0 };
  if (slope === 0 || (remaining > 0) !== (slope > 0)) return { metric: driver.metric, projectedMinutesToCritical: null };
  return { metric: driver.metric, projectedMinutesToCritical: Math.round(remaining / slope) };
}

function riskScore(breaches, history) {
  const top = breaches[0];
  const live = top ? (top.level === 2 ? 70 + 20 * top.severityRatio : 35 + 25 * top.severityRatio) : 0;
  const past = Math.min(10, history.incidents * 2.5) + Math.min(5, history.downtimeHours / 8);
  return Math.min(100, Math.round(live + past));
}

async function buildOverview(db) {
  const all = async (name, query = "SELECT * FROM c", parameters = []) =>
    (await db.container(name).items.query({ query, parameters }).fetchAll()).resources;

  const [machines, thresholds, history, workOrders, parts, suppliers] = await Promise.all([
    all("Machines"), all("Thresholds"), all("MaintenanceHistory"), all("WorkOrders"),
    all("PartsInventory"), all("Suppliers"),
  ]);
  const nowMs = Date.now();
  const tools = createTools(db);

  const rows = await Promise.all(machines.map(async (m) => {
    const readings = await all("Telemetry", "SELECT TOP 5 * FROM c WHERE c.machineId = @m ORDER BY c.timestamp DESC",
      [{ name: "@m", value: m.id }]);
    const latest = readings[0] || null;
    const limits = thresholds.filter((t) => t.machineType === m.type);
    const breaches = latest ? evaluateBreaches(latest.metrics, limits) : [];
    const mine = history.filter((h) => h.machineId === m.id);
    const stats = {
      incidents: mine.length,
      downtimeHours: Math.round(mine.reduce((s, h) => s + (h.downtime || 0), 0) / 6) / 10,
      totalCost: mine.reduce((s, h) => s + (h.cost || 0), 0),
      avgCost: mine.length ? Math.round(mine.reduce((s, h) => s + (h.cost || 0), 0) / mine.length) : 0,
      lastFault: mine.sort((a, b) => String(b.occurrenceDate).localeCompare(String(a.occurrenceDate)))[0]?.faultType || null,
    };
    const score = riskScore(breaches, stats);
    const open = workOrders.filter((w) => w.machineId === m.id && ACTIVE.includes(w.status));
    const driver = breaches[0];
    const article = driver ? await tools.search_knowledge_base(driver.metric, m.type) : null;
    return {
      possibleIssue: article ? { articleId: article.id, issue: article.issue, impact: article.impact,
        estimatedRepairTime: article.estimatedRepairTime, priority: article.priority } : null,
      machineId: m.id, name: m.name, type: m.type, location: m.location, status: m.status,
      telemetryStatus: latest?.status || null, telemetryTime: latest?.timestamp || null,
      alerts: latest?.alerts || [],
      severity: Math.max(latest ? rankOf(latest.status) : 0, ...breaches.map((b) => b.level)),
      breaches: breaches.slice(0, 3),
      readings: latest ? readingsTable(latest.metrics, limits) : [],
      trend: projectTrend(readings, driver, limits.find((t) => t.metric === driver?.metric)),
      riskScore: score,
      riskLevel: score >= 70 ? "critical" : score >= 35 ? "high" : "low",
      history: stats,
      openWorkOrders: open.map((w) => ({ id: w.id, number: w.workOrderNumber, status: w.status, scheduledDate: w.scheduledDate || null })),
    };
  }));
  rows.sort((a, b) => b.riskScore - a.riskScore);

  // Parts required by active work orders, with the earliest date they are needed.
  const need = new Map();
  for (const wo of workOrders.filter((w) => ACTIVE.includes(w.status))) {
    for (const rp of wo.requiredParts || []) {
      const part = parts.find((p) => p.id === rp.partId || p.partNumber === rp.partNumber);
      if (!part) continue;
      const cur = need.get(part.id) || { qty: 0, days: null };
      cur.qty += rp.quantity || 1;
      if (wo.scheduledDate) {
        const d = (Date.parse(wo.scheduledDate) - nowMs) / DAY;
        cur.days = cur.days == null ? d : Math.min(cur.days, d);
      }
      need.set(part.id, cur);
    }
  }
  const procurement = parts
    .map((part) => recommendOrder({ part, requiredQty: need.get(part.id)?.qty || 0, suppliers, daysUntilNeeded: need.get(part.id)?.days ?? null }))
    .filter(Boolean)
    .sort((a, b) => Number(b.atRisk) - Number(a.atRisk) || b.totalCost - a.totalCost);

  const names = new Map(machines.map((m) => [m.id, m.name]));
  const openWorkOrders = workOrders
    .filter((w) => ACTIVE.includes(w.status))
    .map((w) => ({ ...clean(w), machineName: names.get(w.machineId) || w.machineId }))
    .sort((a, b) => (PRIORITY[a.priority] ?? 4) - (PRIORITY[b.priority] ?? 4) || String(a.scheduledDate || "~").localeCompare(String(b.scheduledDate || "~")));
  const incidents = [...history]
    .sort((a, b) => String(b.occurrenceDate).localeCompare(String(a.occurrenceDate)))
    .slice(0, 8)
    .map((h) => ({ ...clean(h), machineName: names.get(h.machineId) || h.machineId }));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    machines: rows,
    procurement,
    openWorkOrders,
    incidents,
    totals: {
      openWorkOrders: openWorkOrders.length,
      atRisk: rows.filter((r) => r.riskLevel !== "low").length,
      orderCost: Math.round(procurement.reduce((s, r) => s + r.totalCost, 0) * 100) / 100,
      lateOrders: procurement.filter((r) => r.atRisk).length,
    },
  };
}

// Daily plan per technician: shift hours and booked work orders (as lead or support) for one UTC day.
async function buildSchedule(db, dateStr) {
  const all = async (name) => (await db.container(name).items.query("SELECT * FROM c").fetchAll()).resources;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") ? dateStr : new Date().toISOString().slice(0, 10);
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const dayEnd = dayStart + DAY;

  const [technicians, workOrders, machines] = await Promise.all([all("Technicians"), all("WorkOrders"), all("Machines")]);
  const names = new Map(machines.map((m) => [m.id, m.name]));
  const planned = workOrders.filter((w) => w.status !== "cancelled");

  const techs = technicians.map((t) => {
    const shiftBlocks = shiftIntervals(t.shiftSchedule, dayStart, dayEnd).map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() }));
    const entries = [];
    for (const w of planned) {
      if (!w.scheduledDate) continue;
      const start = Date.parse(w.scheduledDate);
      const end = w.scheduledEnd ? Date.parse(w.scheduledEnd) : start + (w.estimatedDuration || 240) * MIN;
      if (end <= dayStart || start >= dayEnd) continue;
      const member = (w.crew || []).find((c) => c.technicianId === t.id);
      const lead = (w.assignedTo || w.assignedTechnician) === t.id;
      if (!member && !lead) continue;
      entries.push({
        workOrderId: w.id, number: w.workOrderNumber, title: w.title, status: w.status, priority: w.priority,
        machineId: w.machineId, machineName: names.get(w.machineId) || w.machineId,
        start: new Date(start).toISOString(), end: new Date(end).toISOString(),
        role: member?.role || "lead", focus: member?.focus || null,
        crew: (w.crew || []).map((c) => c.name),
      });
    }
    entries.sort((a, b) => a.start.localeCompare(b.start));
    const overlap = (s, e) => Math.max(0, Math.min(e, dayEnd) - Math.max(s, dayStart));
    return {
      id: t.id, name: t.name, role: t.role, skills: t.skills, shift: t.shiftSchedule, available: t.available,
      shiftBlocks, entries,
      shiftMinutes: Math.round(shiftBlocks.reduce((s, b) => s + (Date.parse(b.end) - Date.parse(b.start)), 0) / MIN),
      bookedMinutes: Math.round(entries.reduce((s, x) => s + overlap(Date.parse(x.start), Date.parse(x.end)), 0) / MIN),
    };
  });

  const unscheduled = planned.filter((w) => ACTIVE.includes(w.status) && !w.scheduledDate)
    .map((w) => ({ id: w.id, number: w.workOrderNumber, title: w.title, machineName: names.get(w.machineId) || w.machineId, priority: w.priority }));
  return { date: day, technicians: techs, unscheduled };
}

module.exports = { buildOverview, buildSchedule };
