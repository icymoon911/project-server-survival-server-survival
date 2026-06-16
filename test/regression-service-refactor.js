/**
 * Regression test for Service.js refactoring.
 *
 * Verifies:
 * 1. All service types in CONFIG.services have visual config
 * 2. All service types have a handler (explicit or default fallback)
 * 3. Tier ring config covers all upgradeable types
 * 4. Handler processJob functions exist and are callable
 * 5. Compute/serverless share the same handler object
 *
 * Run: node test/regression-service-refactor.js
 */

// Minimal mocks
global.THREE = {
  BoxGeometry: function() {},
  CylinderGeometry: function() {},
  SphereGeometry: function() {},
  OctahedronGeometry: function() {},
  DodecahedronGeometry: function() {},
  TetrahedronGeometry: function() {},
  RingGeometry: function() {},
  TorusGeometry: function() {},
  MeshStandardMaterial: function(p) { this.color = { getHex: () => p.color || 0 }; Object.assign(this, p); },
  MeshBasicMaterial: function(p) { Object.assign(this, p); },
  Mesh: function() {
    this.position = { x:0,y:0,z:0, copy: () => {}, clone: () => ({}) };
    this.rotation = { x:0,y:0,z:0 };
    this.add = () => {};
    this.material = { color: { getHex: () => 0 } };
    this.castShadow = false;
    this.receiveShadow = false;
    this.userData = {};
  },
  DoubleSide: 2,
  Color: function(c) { this.c = c; },
  Vector3: function(x,y,z) { this.x=x; this.y=y; this.z=z; this.clone = () => new THREE.Vector3(x,y,z); },
};

global.TRAFFIC_TYPES = { STATIC:"STATIC", READ:"READ", WRITE:"WRITE", UPLOAD:"UPLOAD", SEARCH:"SEARCH", MALICIOUS:"MALICIOUS" };

global.CONFIG = {
  colors: {
    bg:0, grid:0, alb:0, compute:0, db:0, waf:0, s3:0, lineActive:0, line:0,
    requestFail:0, cache:0, sqs:0, apigw:0, nosql:0, search:0, replica:0, serverless:0,
  },
  services: {
    waf: { name:"Firewall", cost:40, type:"waf", processingTime:20, capacity:30, upkeep:4 },
    alb: { name:"Load Balancer", cost:50, type:"alb", processingTime:50, capacity:20, upkeep:6 },
    compute: { name:"Compute", cost:60, type:"compute", processingTime:600, capacity:4, upkeep:12, tiers:[{level:1,capacity:4,cost:0},{level:2,capacity:10,cost:100},{level:3,capacity:18,cost:160}] },
    db: { name:"Relational DB", cost:150, type:"db", processingTime:300, capacity:8, upkeep:24, tiers:[{level:1,capacity:8,cost:0},{level:2,capacity:20,cost:200},{level:3,capacity:35,cost:350}] },
    s3: { name:"File Storage", cost:25, type:"s3", processingTime:200, capacity:25, upkeep:5 },
    cdn: { name:"CDN", cost:60, type:"cdn", processingTime:30, capacity:50, upkeep:5, cacheHitRate:0.95 },
    cache: { name:"Memory Cache", cost:60, type:"cache", processingTime:50, capacity:30, upkeep:8, cacheHitRate:0.35, tiers:[{level:1,capacity:30,cacheHitRate:0.35,cost:0},{level:2,capacity:50,cacheHitRate:0.5,cost:120},{level:3,capacity:80,cacheHitRate:0.65,cost:180}] },
    sqs: { name:"Message Queue", cost:45, type:"sqs", processingTime:20, capacity:50, maxQueueSize:200, upkeep:3 },
    apigw: { name:"API Gateway", cost:70, type:"apigw", processingTime:30, capacity:40, upkeep:8, rateLimit:20, tiers:[{level:1,capacity:40,rateLimit:20,cost:0},{level:2,capacity:60,rateLimit:40,cost:120},{level:3,capacity:80,rateLimit:80,cost:200}] },
    nosql: { name:"NoSQL DB", cost:80, type:"nosql", processingTime:150, capacity:15, upkeep:14, tiers:[{level:1,capacity:15,cost:0},{level:2,capacity:30,cost:120},{level:3,capacity:50,cost:200}] },
    search: { name:"Search Engine", cost:120, type:"search", processingTime:100, capacity:12, upkeep:16, tiers:[{level:1,capacity:12,cost:0},{level:2,capacity:25,cost:150},{level:3,capacity:40,cost:250}] },
    replica: { name:"Read Replica", cost:100, type:"replica", processingTime:200, capacity:12, upkeep:12, tiers:[{level:1,capacity:12,cost:0},{level:2,capacity:24,cost:130},{level:3,capacity:40,cost:200}] },
    serverless: { name:"Serverless Function", cost:45, type:"serverless", processingTime:900, capacity:30, upkeep:2, perRequestCost:0.03 },
  },
  survival: { degradation: { criticalHealth: 40 } },
};

global.STATE = { services: [], money: 1000, finances: { expenses: { services:0, upkeep:0, byService:{} } } };
global.serviceGroup = { add: () => {}, remove: () => {} };
global.finishRequest = () => {};
global.failRequest = () => {};
global.throttleRequest = () => {};
global.flashMoney = () => {};
global.calculateFailChanceBasedOnLoad = () => 0;
global.updateScore = () => {};
global.getUpkeepMultiplier = () => 1.0;
global.addInterventionWarning = () => {};
global.i18n = { t: (k) => k };

// Load the modules (simulate browser <script> tags with shared context)
const vm = require("vm");
const fs = require("fs");
const path = require("path");

// Create a shared context with all globals
const sandbox = {
  THREE: global.THREE,
  TRAFFIC_TYPES: global.TRAFFIC_TYPES,
  CONFIG: global.CONFIG,
  STATE: global.STATE,
  serviceGroup: global.serviceGroup,
  finishRequest: global.finishRequest,
  failRequest: global.failRequest,
  throttleRequest: global.throttleRequest,
  flashMoney: global.flashMoney,
  calculateFailChanceBasedOnLoad: global.calculateFailChanceBasedOnLoad,
  updateScore: global.updateScore,
  getUpkeepMultiplier: global.getUpkeepMultiplier,
  console,
};
const context = vm.createContext(sandbox);

function loadScript(file) {
  let code = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  // Convert top-level const/let to var so they become context properties
  code = code.replace(/^const /gm, "var ").replace(/^let /gm, "var ");
  const script = new vm.Script(code, { filename: file });
  script.runInContext(context);
}

loadScript("src/entities/serviceVisuals.js");
loadScript("src/entities/serviceHandlers.js");

// Extract from context
const SERVICE_VISUALS = context.SERVICE_VISUALS;
const TIER_RING_CONFIG = context.TIER_RING_CONFIG;
const createServiceMesh = context.createServiceMesh;
const createTierRing = context.createTierRing;
const SERVICE_HANDLERS = context.SERVICE_HANDLERS;
const getHandler = context.getHandler;

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// --- Test 1: Visual config covers all types ---
console.log("\n[1] SERVICE_VISUALS covers all CONFIG.services types:");
for (const type of Object.keys(CONFIG.services)) {
  assert(SERVICE_VISUALS[type], `${type} has visual config`);
}

// --- Test 2: Handlers cover all types (explicit or default) ---
console.log("\n[2] getHandler() returns a handler for all types:");
for (const type of Object.keys(CONFIG.services)) {
  const handler = getHandler(type);
  assert(handler && typeof handler.processJob === "function", `${type} has processJob`);
}

// --- Test 3: Compute and serverless share the same handler ---
console.log("\n[3] Compute and serverless share handler:");
assert(getHandler("compute") === getHandler("serverless"), "compute and serverless use same handler object");

// --- Test 4: Tier ring config covers upgradeable types ---
console.log("\n[4] TIER_RING_CONFIG covers upgradeable types:");
const upgradeableTypes = ["compute", "db", "cache", "apigw", "nosql", "search", "replica"];
for (const type of upgradeableTypes) {
  const cfg = TIER_RING_CONFIG[type] || TIER_RING_CONFIG._default;
  assert(cfg && cfg.ringSize > 0 && cfg.ringColor > 0, `${type} has tier ring config (size=${cfg.ringSize}, color=0x${cfg.ringColor.toString(16)})`);
}

// --- Test 5: createServiceMesh produces valid output ---
console.log("\n[5] createServiceMesh() produces valid meshes:");
for (const type of Object.keys(CONFIG.services)) {
  const pos = new THREE.Vector3(0, 0, 0);
  const result = createServiceMesh(type, pos);
  assert(result.mesh && result.mat && result.yOffset > 0, `${type} mesh created (yOffset=${result.yOffset})`);
}

// --- Test 6: createTierRing produces valid rings ---
console.log("\n[6] createTierRing() produces valid rings:");
for (const type of upgradeableTypes) {
  const ring = createTierRing(type, 2, 1.5);
  assert(ring && ring.rotation, `${type} tier 2 ring created`);
  const ring3 = createTierRing(type, 3, 1.5);
  assert(ring3 && ring3.rotation, `${type} tier 3 ring created`);
}

// --- Test 7: Handler-specific features ---
console.log("\n[7] Handler-specific features:");
const apigwHandler = getHandler("apigw");
assert(typeof apigwHandler.preProcess === "function", "apigw has preProcess (rate counter reset)");

const computeHandler = getHandler("compute");
assert(typeof computeHandler.preProcess === "function", "compute has preProcess (pull logic)");
assert(typeof computeHandler.getProcessingTime === "function", "compute has getProcessingTime (weighted)");
assert(typeof computeHandler.onJobFail === "function", "compute/serverless has onJobFail (serverless cost)");

const sqsHandler = getHandler("sqs");
assert(typeof sqsHandler.postUpdate === "function", "sqs has postUpdate (queue fill visual)");

// --- Test 8: Handlers without preProcess use default processingTime ---
console.log("\n[8] Default handler has no getProcessingTime (uses config.processingTime):");
const defaultHandler = getHandler("waf");
assert(!defaultHandler.getProcessingTime, "waf/default handler relies on config.processingTime");

const dbHandler = getHandler("db");
assert(!dbHandler.getProcessingTime, "db handler relies on config.processingTime");

// --- Summary ---
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("All regression checks passed ✓");
