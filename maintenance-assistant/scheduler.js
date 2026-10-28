// Shift- and window-aware slot search. All times are UTC, matching MaintenanceWindows timestamps.
const MIN = 60000, HOUR = 3600000, DAY = 24 * HOUR;

// [start hour, end hour]; night wraps past midnight.
const SHIFT_HOURS = { day: [6, 18], night: [18, 6] };
const ACTIVE_STATUSES = ["open", "scheduled", "in_progress"];
const DEFAULT_DURATION_MIN = 240;

const clip = (list, lo, hi) =>
  list.map(([s, e]) => [Math.max(s, lo), Math.min(e, hi)]).filter(([s, e]) => e > s);

const intersect = (a, b) => {
  const out = [];
  for (const [s1, e1] of a) for (const [s2, e2] of b) {
    const s = Math.max(s1, s2), e = Math.min(e1, e2);
    if (e > s) out.push([s, e]);
  }
  return out.sort((x, y) => x[0] - y[0]);
};

const subtract = (list, busy) =>
  busy.reduce((acc, [bs, be]) => acc.flatMap(([s, e]) =>
    be <= s || bs >= e ? [[s, e]] : [[s, Math.min(bs, e)], [Math.max(be, s), e]].filter(([x, y]) => y > x)), list);

function shiftIntervals(shift, lo, hi) {
  const [startHour, endHour] = SHIFT_HOURS[String(shift || "day").toLowerCase()] || SHIFT_HOURS.day;
  const length = (((endHour - startHour + 24) % 24) || 24) * HOUR;
  const first = Date.UTC(new Date(lo).getUTCFullYear(), new Date(lo).getUTCMonth(), new Date(lo).getUTCDate()) - DAY;
  const out = [];
  for (let d = first; d <= hi; d += DAY) out.push([d + startHour * HOUR, d + startHour * HOUR + length]);
  return clip(out, lo, hi);
}

function bookingIntervals(workOrders, nowMs) {
  const byTech = new Map(), byMachine = new Map();
  const add = (map, key, iv) => key && map.set(key, [...(map.get(key) || []), iv]);
  for (const wo of workOrders) {
    if (!ACTIVE_STATUSES.includes(wo.status) || !wo.scheduledDate) continue;
    const start = Date.parse(wo.scheduledDate);
    const end = wo.scheduledEnd ? Date.parse(wo.scheduledEnd) : start + (wo.estimatedDuration || DEFAULT_DURATION_MIN) * MIN;
    if (!(end > nowMs)) continue;
    const people = new Set([wo.assignedTo, wo.assignedTechnician, ...(wo.crew || []).map((c) => c.technicianId)]);
    for (const id of people) add(byTech, id, [start, end]);
    add(byMachine, wo.machineId, [start, end]);
  }
  return { byTech, byMachine };
}

// Slots must lie fully inside the technician's shift (and inside a maintenance window when `windows` is given).
function buildSlots({ shift, busy, windows, lo, hi, durationMs, max = 3 }) {
  const free = subtract(shiftIntervals(shift, lo, hi), busy);
  const slots = [];
  const take = (intervals, meta) => {
    for (const [s, e] of intervals) {
      const start = Math.ceil(s / (15 * MIN)) * 15 * MIN;
      if (start + durationMs <= e) {
        slots.push({ start: new Date(start).toISOString(), end: new Date(start + durationMs).toISOString(), ...meta });
      }
    }
  };
  if (windows) {
    for (const w of windows) {
      take(intersect([[Date.parse(w.startTime), Date.parse(w.endTime)]], free),
        { windowId: w.id, productionImpact: w.productionImpact });
    }
  } else {
    take(free, { windowId: null, productionImpact: null });
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start)).slice(0, max);
}

// True when [start, end] lies inside one of the technician's shifts and overlaps no booking.
function isFree({ shift, busy, start, end }) {
  const s = Date.parse(start), e = Date.parse(end);
  const inShift = shiftIntervals(shift, s - DAY, e + DAY).some(([a, b]) => a <= s && b >= e);
  return inShift && !busy.some(([a, b]) => a < e && b > s);
}

module.exports = { MIN, HOUR, DAY, DEFAULT_DURATION_MIN, ACTIVE_STATUSES, shiftIntervals, bookingIntervals, buildSlots, isFree };
