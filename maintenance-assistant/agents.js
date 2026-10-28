// Reads the team's agent definitions from ./agents (downloaded from the agentic-factory-hack repository).
// The fault -> skills / parts tables and the Repair Planner rules are parsed from agentplanning.agent.md so that file stays the source of truth.
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "agents");
const read = (file) => { try { return fs.readFileSync(path.join(DIR, file), "utf8"); } catch { return ""; } };

const planning = read("agentplanning.agent.md");
const factory = read(path.join("knowledge", "factory-hack.md"));

// Lines like: - `fault_type` -> `a`, `b`   (an "(empty array)" entry yields no values)
function parseMap(title) {
  const block = new RegExp(`\\*\\*${title}:\\*\\*([\\s\\S]*?)(?:\\n\\*\\*|\\n## |$)`).exec(planning)?.[1] || "";
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^- `([^`]+)` \u2192 (.+)$/.exec(line.trim());
    if (m) out[m[1]] = [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  }
  return out;
}

const instructions = /AgentInstructions = """([\s\S]*?)"""/.exec(planning)?.[1] || "";
const repairRules = (/Rules:\s*([\s\S]*)$/.exec(instructions)?.[1] || "")
  .split(/\r?\n/).map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);

// "apply logic: if currentValue >= threshold - 1" in the use-case notes: a reading this close to its limit is an early warning.
const margin = /currentValue\s*>=\s*threshold\s*-\s*(\d+(?:\.\d+)?)/.exec(factory);

const description = (text) => /description:\s*'([^']*)'/.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || "")?.[1] || "";

function listAgents() {
  const usage = {
    "agentplanning.agent.md": "Used at run time: fault to skills and parts tables, repair planner rules, and the four-agent workflow names.",
    "hackagent.agent.md": "Not used at run time: it generates hackathon challenge repositories.",
    "knowledge/factory-hack.md": "Used at run time: use-case architecture and the early-warning rule (reading >= limit - 1).",
    "knowledge/claimsv2-hack.md": "Not used: the file is empty.",
  };
  const files = [];
  const walk = (rel) => {
    for (const e of fs.existsSync(path.join(DIR, rel)) ? fs.readdirSync(path.join(DIR, rel), { withFileTypes: true }) : []) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else {
        const name = r.split(path.sep).join("/");
        const text = read(r);
        files.push({ file: name, bytes: Buffer.byteLength(text), description: description(text), usage: usage[name] || "" });
      }
    }
  };
  walk("");
  return files;
}

module.exports = {
  faultSkills: parseMap("Fault \u2192 Required Skills"),
  faultParts: parseMap("Fault \u2192 Required Parts"),
  repairRules,
  earlyWarningMargin: margin ? Number(margin[1]) : 1,
  listAgents,
};
