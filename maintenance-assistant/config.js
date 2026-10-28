// Runtime settings: Cosmos DB connection, container mapping and LLM. Saved to data/settings.json (never returned to the browser with secrets).
const fs = require("fs");
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

const FILE = path.join(__dirname, "data", "settings.json");
// Logical entities the app uses; each can be mapped to a differently named container.
const LOGICAL = ["Machines", "Telemetry", "Thresholds", "MaintenanceHistory", "WorkOrders", "Technicians",
  "PartsInventory", "Suppliers", "KnowledgeBase", "MaintenanceWindows"];

const fail = (status, message) => Object.assign(new Error(message), { status });

function parseConnectionString(cs) {
  const out = {};
  for (const part of String(cs || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return { endpoint: out.AccountEndpoint, key: out.AccountKey };
}

function loadState() {
  const env = process.env;
  const fromEnv = {
    cosmos: { ...parseConnectionString(env.COSMOS_CONNECTION_STRING), database: env.COSMOS_DATABASE },
    containers: {},
    llm: { endpoint: env.AZURE_OPENAI_ENDPOINT, deployment: env.AZURE_OPENAI_DEPLOYMENT, apiKey: env.AZURE_OPENAI_API_KEY,
      apiVersion: env.AZURE_OPENAI_API_VERSION || "2024-10-21" },
  };
  if (!fs.existsSync(FILE)) return fromEnv;
  const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  return {
    cosmos: { ...fromEnv.cosmos, ...saved.cosmos },
    containers: saved.containers || {},
    llm: { ...fromEnv.llm, ...saved.llm },
  };
}

let state = null;
let realDb = null;

function connect() {
  const { endpoint, key, database } = state.cosmos;
  realDb = endpoint && key && database ? new CosmosClient({ endpoint, key }).database(database) : null;
}

function init() {
  state = loadState();
  connect();
}

function requireDb() {
  if (!realDb) throw fail(503, "No database is configured. Open Settings to connect one.");
  return realDb;
}

// Facade so every module can keep using logical container names.
const db = {
  container: (name) => requireDb().container(state.containers[name] || name),
  get containers() { return requireDb().containers; },
};

const isHttps = (u) => { try { return new URL(u).protocol === "https:"; } catch { return false; } };

function publicSettings() {
  const containers = Object.fromEntries(LOGICAL.map((l) => [l, state.containers[l] || l]));
  return {
    cosmos: { endpoint: state.cosmos.endpoint || "", database: state.cosmos.database || "", hasKey: Boolean(state.cosmos.key) },
    containers,
    logical: LOGICAL,
    llm: { endpoint: state.llm.endpoint || "", deployment: state.llm.deployment || "", apiVersion: state.llm.apiVersion || "2024-10-21",
      hasKey: Boolean(state.llm.apiKey) },
    connected: Boolean(realDb),
    llmConfigured: Boolean(state.llm.endpoint && state.llm.deployment && state.llm.apiKey),
  };
}

function resolveCreds(input = {}) {
  const parsed = input.connectionString ? parseConnectionString(input.connectionString) : {};
  const endpoint = parsed.endpoint || input.endpoint || state.cosmos.endpoint;
  const sameEndpoint = endpoint === state.cosmos.endpoint;
  const key = parsed.key || input.key || (sameEndpoint ? state.cosmos.key : undefined);
  if (!endpoint || !isHttps(endpoint)) throw fail(400, "Enter a valid https endpoint or connection string.");
  if (!key) throw fail(400, "An account key is required.");
  return { endpoint, key };
}

// Lists databases (and containers of the chosen database) and proposes a mapping for the logical entities.
async function testCosmos(input) {
  const { endpoint, key } = resolveCreds(input);
  const client = new CosmosClient({ endpoint, key });
  const databases = (await client.databases.readAll().fetchAll()).resources.map((d) => d.id);
  const database = input.database || (databases.length === 1 ? databases[0] : null);
  let containers = [];
  if (database) {
    if (!databases.includes(database)) throw fail(400, `Database "${database}" was not found on this account.`);
    containers = (await client.database(database).containers.readAll().fetchAll()).resources.map((c) => c.id);
  }
  const lower = new Map(containers.map((c) => [c.toLowerCase(), c]));
  const suggested = Object.fromEntries(LOGICAL.map((l) => [l, lower.get(l.toLowerCase()) || null]));
  return { databases, database, containers, suggested };
}

function save(update = {}) {
  const next = { cosmos: { ...state.cosmos }, containers: { ...state.containers }, llm: { ...state.llm } };
  if (update.cosmos) {
    const { endpoint, key } = update.cosmos.connectionString ? parseConnectionString(update.cosmos.connectionString) : {};
    const ep = endpoint || update.cosmos.endpoint;
    if (ep) { if (!isHttps(ep)) throw fail(400, "The Cosmos endpoint must be an https URL."); next.cosmos.endpoint = ep; }
    const k = key || update.cosmos.key;
    if (k) next.cosmos.key = k;
    if (update.cosmos.database) next.cosmos.database = update.cosmos.database;
  }
  if (update.containers) {
    for (const l of LOGICAL) if (update.containers[l]) next.containers[l] = update.containers[l];
  }
  if (update.llm) {
    const { endpoint, deployment, apiKey, apiVersion } = update.llm;
    if (endpoint !== undefined) {
      if (endpoint && !isHttps(endpoint)) throw fail(400, "The LLM endpoint must be an https URL.");
      next.llm.endpoint = endpoint;
    }
    if (deployment !== undefined) next.llm.deployment = deployment;
    if (apiKey) next.llm.apiKey = apiKey;
    if (apiVersion) next.llm.apiVersion = apiVersion;
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  state = next;
  connect();
  return publicSettings();
}

const getLlm = () => state.llm;

init();
module.exports = { db, LOGICAL, publicSettings, testCosmos, save, getLlm, fail };
