/**
 * Blueprint System — Save, load, manage, export/import architecture blueprints.
 *
 * A blueprint captures the current service topology (types, positions, tiers,
 * connections) so players can reuse a proven architecture across games.
 *
 * Storage: localStorage key "serverSurvivalBlueprints"
 * Format:  { version, blueprints: [ BlueprintEntry, ... ] }
 */

const BLUEPRINT_STORAGE_KEY = "serverSurvivalBlueprints";
const BLUEPRINT_FORMAT_VERSION = 1;

// ─── Persistence helpers ────────────────────────────────────────────

function _loadBlueprintStore() {
  try {
    const raw = localStorage.getItem(BLUEPRINT_STORAGE_KEY);
    if (!raw) return { version: BLUEPRINT_FORMAT_VERSION, blueprints: [] };
    const store = JSON.parse(raw);
    // Future-proof: if version is newer than we know, still try to read
    if (!store || !Array.isArray(store.blueprints)) {
      return { version: BLUEPRINT_FORMAT_VERSION, blueprints: [] };
    }
    return store;
  } catch (e) {
    console.error("Blueprint: failed to read localStorage", e);
    return { version: BLUEPRINT_FORMAT_VERSION, blueprints: [] };
  }
}

function _saveBlueprintStore(store) {
  localStorage.setItem(BLUEPRINT_STORAGE_KEY, JSON.stringify(store));
}

// ─── Capture current architecture ──────────────────────────────────

function captureCurrentBlueprint() {
  /**
   * Build a serialisable snapshot of STATE.services + STATE.connections
   * + STATE.internetNode.connections.
   *
   * Each service is stored with index-based references so we can rebuild
   * connections without relying on random IDs.
   */
  const services = STATE.services.map((s, idx) => ({
    index: idx,
    type: s.type,
    position: { x: s.position.x, y: s.position.y, z: s.position.z },
    tier: s.tier || 1,
  }));

  // Service-to-service connections (index-based)
  const connections = STATE.connections.map((c) => {
    const fromIdx =
      c.from === "internet"
        ? -1
        : STATE.services.findIndex((s) => s.id === c.from);
    const toIdx =
      c.to === "internet"
        ? -1
        : STATE.services.findIndex((s) => s.id === c.to);
    return { from: fromIdx, to: toIdx };
  });

  // Internet → first-hop connections
  const internetConnections = STATE.internetNode.connections.map((id) => {
    const idx = STATE.services.findIndex((s) => s.id === id);
    return idx;
  });

  return { services, connections, internetConnections };
}

// ─── Cost calculation ───────────────────────────────────────────────

function calculateBlueprintCost(blueprintData) {
  /**
   * Sum up base service costs + tier upgrade costs.
   * Returns { total, serviceCost, upgradeCost, details[] }
   */
  let serviceCost = 0;
  let upgradeCost = 0;
  const details = [];

  for (const svc of blueprintData.services) {
    const cfg = CONFIG.services[svc.type];
    if (!cfg) continue;

    const base = cfg.cost;
    serviceCost += base;

    let tierUpCost = 0;
    if (svc.tier > 1 && cfg.tiers) {
      for (let t = 1; t < svc.tier; t++) {
        // tiers[t] is the upgrade FROM tier t to t+1  (index 0 = tier 1, free)
        if (cfg.tiers[t] && cfg.tiers[t].cost) {
          tierUpCost += cfg.tiers[t].cost;
        }
      }
    }
    upgradeCost += tierUpCost;

    details.push({
      type: svc.type,
      tier: svc.tier,
      baseCost: base,
      upgradeCost: tierUpCost,
    });
  }

  return {
    total: serviceCost + upgradeCost,
    serviceCost,
    upgradeCost,
    details,
  };
}

// ─── Validation ─────────────────────────────────────────────────────

function validateBlueprint(blueprintData, mode, level) {
  /**
   * Check whether every service type in the blueprint is allowed.
   *
   * @param mode   "survival" | "sandbox" | "campaign"
   * @param level  campaign level object (only for campaign mode)
   *
   * Returns { valid: bool, warnings: string[], blockedTypes: string[] }
   */
  const warnings = [];
  const blockedTypes = [];
  const allTypes = Object.keys(CONFIG.services);

  for (const svc of blueprintData.services) {
    // 1. Does the service type still exist in CONFIG?
    if (!CONFIG.services[svc.type]) {
      warnings.push(
        `Service type "${svc.type}" no longer exists — it will be skipped.`
      );
      blockedTypes.push(svc.type);
      continue;
    }

    // 2. Campaign level gating
    if (mode === "campaign" && level) {
      const allowed = level.allowedServices;
      const forbidden = level.forbiddenServices || [];

      if (allowed && allowed.length > 0) {
        // Normalize: "lambda" in UI maps to "compute" in config
        const normalizedAllowed = allowed.map((a) =>
          a === "lambda" ? "compute" : a
        );
        if (!normalizedAllowed.includes(svc.type)) {
          warnings.push(
            `"${CONFIG.services[svc.type].name}" is not allowed in this level.`
          );
          blockedTypes.push(svc.type);
          continue;
        }
      }

      if (forbidden.includes(svc.type)) {
        warnings.push(
          `"${CONFIG.services[svc.type].name}" is forbidden in this level.`
        );
        blockedTypes.push(svc.type);
        continue;
      }
    }
  }

  return {
    valid: blockedTypes.length === 0,
    warnings,
    blockedTypes,
  };
}

// ─── Apply blueprint to current game ────────────────────────────────

function applyBlueprint(blueprintData, mode, level) {
  /**
   * Rebuild services and connections inside the already-reset game.
   * Deducts costs from STATE.money. Returns { success, error? }.
   *
   * Call this AFTER resetGame() has set up the budget.
   */

  // Validate first
  const validation = validateBlueprint(blueprintData, mode, level);
  if (!validation.valid) {
    return {
      success: false,
      error: "validation",
      validation,
    };
  }

  // Calculate cost
  const cost = calculateBlueprintCost(blueprintData);

  // Budget check
  if (STATE.money < cost.total) {
    return {
      success: false,
      error: "budget",
      cost,
      message: `Blueprint costs $${cost.total} but you only have $${Math.floor(STATE.money)}.`,
    };
  }

  // Deduct cost
  STATE.money -= cost.total;
  if (STATE.finances) {
    STATE.finances.expenses.services += cost.serviceCost;
    // Track upgrade costs under expenses.services too (simpler)
    STATE.finances.expenses.services += cost.upgradeCost;
  }

  // Rebuild services
  const placed = [];
  for (const svcData of blueprintData.services) {
    if (!CONFIG.services[svcData.type]) continue; // skip unknown types

    const pos = new THREE.Vector3(
      svcData.position.x,
      svcData.position.y || 0,
      svcData.position.z
    );

    const service = new Service(svcData.type, pos);
    STATE.services.push(service);
    placed.push(service);

    // Apply tier upgrades (bypass cost check — already deducted)
    if (svcData.tier > 1 && service.tier < svcData.tier) {
      const tiers = CONFIG.services[svcData.type].tiers;
      if (tiers) {
        service.tier = svcData.tier;
        const tierData = tiers[service.tier - 1];
        if (tierData) {
          service.config = { ...service.config, capacity: tierData.capacity };
          if (tierData.cacheHitRate) {
            service.config = {
              ...service.config,
              cacheHitRate: tierData.cacheHitRate,
            };
          }
          if (tierData.rateLimit) {
            service.config = {
              ...service.config,
              rateLimit: tierData.rateLimit,
            };
          }
        }

        // Visual tier rings
        for (let t = 2; t <= service.tier; t++) {
          let ringSize, ringColor;
          if (service.type === "db") { ringSize = 2.2; ringColor = 0xff0000; }
          else if (service.type === "cache") { ringSize = 1.5; ringColor = 0xdc382d; }
          else if (service.type === "apigw") { ringSize = 1.5; ringColor = 0xe879f9; }
          else if (service.type === "nosql") { ringSize = 2.0; ringColor = 0x7c3aed; }
          else if (service.type === "search") { ringSize = 1.5; ringColor = 0x06b6d4; }
          else if (service.type === "replica") { ringSize = 1.8; ringColor = 0xf472b6; }
          else { ringSize = 1.3; ringColor = 0xffff00; }

          const ringGeo = new THREE.TorusGeometry(ringSize, 0.1, 8, 32);
          const ringMat = new THREE.MeshBasicMaterial({ color: ringColor });
          const ring = new THREE.Mesh(ringGeo, ringMat);
          ring.rotation.x = Math.PI / 2;
          ring.position.y = -service.mesh.position.y + (t === 2 ? 0.5 : 1.0);
          service.mesh.add(ring);
          service.tierRings.push(ring);
        }
      }
    }

    // Track finance counts
    if (STATE.finances) {
      STATE.finances.expenses.countByService[svcData.type] =
        (STATE.finances.expenses.countByService[svcData.type] || 0) + 1;
    }
  }

  // Rebuild internet connections
  if (blueprintData.internetConnections) {
    for (const idx of blueprintData.internetConnections) {
      if (idx >= 0 && placed[idx]) {
        createConnection("internet", placed[idx].id);
      }
    }
  }

  // Rebuild service-to-service connections
  if (blueprintData.connections) {
    for (const conn of blueprintData.connections) {
      const fromId =
        conn.from === -1 ? "internet" : placed[conn.from]?.id;
      const toId =
        conn.to === -1 ? "internet" : placed[conn.to]?.id;
      if (fromId && toId) {
        createConnection(fromId, toId);
      }
    }
  }

  updateRepairCostTable();

  return { success: true, cost, placed: placed.length };
}

// ─── Public API (window-scoped) ─────────────────────────────────────

/**
 * Save current architecture as a named blueprint.
 */
window.saveBlueprint = (name) => {
  if (!name || !name.trim()) return { success: false, error: "Name required" };
  name = name.trim();

  const data = captureCurrentBlueprint();
  const store = _loadBlueprintStore();

  // Check for duplicate name — overwrite
  const existingIdx = store.blueprints.findIndex((b) => b.name === name);
  const costInfo = calculateBlueprintCost(data);

  const entry = {
    id:
      existingIdx >= 0
        ? store.blueprints[existingIdx].id
        : "bp_" + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    name,
    version: BLUEPRINT_FORMAT_VERSION,
    createdAt: existingIdx >= 0 ? store.blueprints[existingIdx].createdAt : Date.now(),
    updatedAt: Date.now(),
    serviceCount: data.services.length,
    connectionCount: data.connections.length,
    estimatedCost: costInfo.total,
    data,
  };

  if (existingIdx >= 0) {
    store.blueprints[existingIdx] = entry;
  } else {
    store.blueprints.push(entry);
  }

  _saveBlueprintStore(store);
  return { success: true, blueprint: entry };
};

/**
 * Get all saved blueprints.
 */
window.getAllBlueprints = () => {
  return _loadBlueprintStore().blueprints;
};

/**
 * Get a single blueprint by ID.
 */
window.getBlueprint = (id) => {
  const store = _loadBlueprintStore();
  return store.blueprints.find((b) => b.id === id) || null;
};

/**
 * Delete a blueprint by ID.
 */
window.deleteBlueprint = (id) => {
  const store = _loadBlueprintStore();
  const before = store.blueprints.length;
  store.blueprints = store.blueprints.filter((b) => b.id !== id);
  if (store.blueprints.length < before) {
    _saveBlueprintStore(store);
    return true;
  }
  return false;
};

/**
 * Export a blueprint as a JSON string (for sharing).
 */
window.exportBlueprint = (id) => {
  const bp = getBlueprint(id);
  if (!bp) return null;
  // Wrap in a shareable envelope
  return JSON.stringify({
    _blueprintExport: true,
    formatVersion: BLUEPRINT_FORMAT_VERSION,
    name: bp.name,
    data: bp.data,
    exportedAt: Date.now(),
  });
};

/**
 * Import a blueprint from a JSON string.
 * Returns { success, blueprint?, error? }
 */
window.importBlueprint = (jsonString) => {
  try {
    const parsed = JSON.parse(jsonString);

    if (!parsed._blueprintExport || !parsed.data) {
      return { success: false, error: "Invalid blueprint format" };
    }

    const store = _loadBlueprintStore();

    // Avoid name collision
    let name = parsed.name || "Imported Blueprint";
    let counter = 1;
    while (store.blueprints.some((b) => b.name === name)) {
      name = `${parsed.name || "Imported Blueprint"} (${counter++})`;
    }

    const costInfo = calculateBlueprintCost(parsed.data);

    const entry = {
      id: "bp_" + Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      name,
      version: BLUEPRINT_FORMAT_VERSION,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      serviceCount: parsed.data.services.length,
      connectionCount: parsed.data.connections.length,
      estimatedCost: costInfo.total,
      data: parsed.data,
    };

    store.blueprints.push(entry);
    _saveBlueprintStore(store);

    return { success: true, blueprint: entry };
  } catch (e) {
    return { success: false, error: "Failed to parse blueprint: " + e.message };
  }
};

/**
 * Load a blueprint into the current game.
 * Must be called AFTER resetGame().
 */
window.loadBlueprintIntoGame = (id, mode, level) => {
  const bp = getBlueprint(id);
  if (!bp) return { success: false, error: "Blueprint not found" };

  return applyBlueprint(bp.data, mode || STATE.gameMode, level);
};

// ─── UI: Blueprint Manager Modal ────────────────────────────────────

window.openBlueprintManager = () => {
  const modal = document.getElementById("blueprint-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  renderBlueprintList();
};

window.closeBlueprintManager = () => {
  const modal = document.getElementById("blueprint-modal");
  if (modal) modal.classList.add("hidden");
};

function renderBlueprintList() {
  const list = document.getElementById("blueprint-list");
  if (!list) return;

  const blueprints = getAllBlueprints();

  if (blueprints.length === 0) {
    list.innerHTML = `
      <div class="text-center text-gray-500 py-8">
        <div class="text-3xl mb-2">📋</div>
        <div class="text-sm">No blueprints saved yet.</div>
        <div class="text-xs text-gray-600 mt-1">Save your current architecture during gameplay!</div>
      </div>`;
    return;
  }

  list.innerHTML = blueprints
    .map((bp) => {
      const date = new Date(bp.updatedAt).toLocaleDateString();
      return `
        <div class="border border-gray-700 rounded-lg p-3 mb-2 hover:bg-gray-800/50 transition" data-bp-id="${bp.id}">
          <div class="flex justify-between items-start mb-1">
            <div class="flex-1">
              <div class="text-white font-bold text-sm">${_escHtml(bp.name)}</div>
              <div class="text-gray-500 text-xs">${bp.serviceCount} services · ${bp.connectionCount} connections · $${bp.estimatedCost}</div>
              <div class="text-gray-600 text-[10px]">${date}</div>
            </div>
            <div class="flex gap-1">
              <button onclick="selectBlueprintForLoad('${bp.id}')"
                class="text-xs bg-green-700 hover:bg-green-600 text-white px-2 py-1 rounded transition" title="Load this blueprint">
                ▶ Load
              </button>
              <button onclick="exportBlueprintToFile('${bp.id}')"
                class="text-xs bg-blue-700 hover:bg-blue-600 text-white px-2 py-1 rounded transition" title="Export as file">
                ↗ Export
              </button>
              <button onclick="confirmDeleteBlueprint('${bp.id}')"
                class="text-xs bg-red-800 hover:bg-red-700 text-white px-2 py-1 rounded transition" title="Delete">
                ✕
              </button>
            </div>
          </div>
        </div>`;
    })
    .join("");
}

function _escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Selected blueprint for loading (set before starting a new game) ──

let _pendingBlueprintId = null;

window.selectBlueprintForLoad = (id) => {
  const bp = getBlueprint(id);
  if (!bp) return;

  _pendingBlueprintId = id;

  // Show confirmation in the modal
  const list = document.getElementById("blueprint-list");
  if (list) {
    // Highlight the selected one
    list.querySelectorAll("[data-bp-id]").forEach((el) => {
      el.classList.remove("border-green-500", "bg-green-900/20");
    });
    const selected = list.querySelector(`[data-bp-id="${id}"]`);
    if (selected) {
      selected.classList.add("border-green-500", "bg-green-900/20");
    }
  }

  // Update the status label
  const status = document.getElementById("blueprint-selected-label");
  if (status) {
    const span = status.querySelector("span");
    if (span) {
      span.textContent = `Selected: ${bp.name} ($${bp.estimatedCost})`;
    }
    status.classList.remove("hidden");
  }

  // Show validation warnings if we know the mode
  const validationArea = document.getElementById("blueprint-validation-area");
  if (validationArea) {
    validationArea.innerHTML = "";
  }
};

window.clearSelectedBlueprint = () => {
  _pendingBlueprintId = null;
  const status = document.getElementById("blueprint-selected-label");
  if (status) {
    const span = status.querySelector("span");
    if (span) span.textContent = "";
    status.classList.add("hidden");
  }
  const list = document.getElementById("blueprint-list");
  if (list) {
    list.querySelectorAll("[data-bp-id]").forEach((el) => {
      el.classList.remove("border-green-500", "bg-green-900/20");
    });
  }
};

window.getPendingBlueprintId = () => _pendingBlueprintId;

/**
 * Called from startGame / startSandbox / startCampaignLevel
 * to apply the selected blueprint after resetGame().
 */
window.applyPendingBlueprint = (mode, level) => {
  if (!_pendingBlueprintId) return null;

  const bp = getBlueprint(_pendingBlueprintId);
  if (!bp) {
    _pendingBlueprintId = null;
    return null;
  }

  // Validate
  const validation = validateBlueprint(bp.data, mode, level);
  if (!validation.valid) {
    // Show warnings to the user
    const msg =
      "Some services in the blueprint are not available:\n" +
      validation.warnings.join("\n") +
      "\n\nLoad anyway? (blocked services will be skipped)";
    if (!confirm(msg)) {
      _pendingBlueprintId = null;
      return null;
    }
  }

  const result = applyBlueprint(bp.data, mode, level);
  if (!result.success) {
    if (result.error === "budget") {
      addInterventionWarning(
        `Blueprint too expensive! Need $${result.cost.total}, have $${Math.floor(STATE.money)}.`,
        "danger",
        5000
      );
    }
    _pendingBlueprintId = null;
    return null;
  }

  addInterventionWarning(
    `Blueprint "${bp.name}" loaded! (${result.placed} services, -$${result.cost.total})`,
    "info",
    4000
  );
  STATE.sound?.playPlace();

  _pendingBlueprintId = null;
  return result;
};

// ── Save blueprint from in-game ─────────────────────────────────────

window.showSaveBlueprintDialog = () => {
  if (STATE.services.length === 0) {
    addInterventionWarning("No services to save!", "warning", 2000);
    return;
  }

  const name = prompt("Blueprint name:", `My Blueprint ${getAllBlueprints().length + 1}`);
  if (name === null) return; // cancelled

  const result = saveBlueprint(name);
  if (result.success) {
    addInterventionWarning(
      `Blueprint "${result.blueprint.name}" saved! (${result.blueprint.serviceCount} services)`,
      "info",
      3000
    );
    STATE.sound?.playSuccess();
  } else {
    addInterventionWarning("Failed to save blueprint: " + result.error, "danger", 3000);
  }
};

// ── Delete with confirmation ────────────────────────────────────────

window.confirmDeleteBlueprint = (id) => {
  const bp = getBlueprint(id);
  if (!bp) return;
  if (confirm(`Delete blueprint "${bp.name}"?`)) {
    deleteBlueprint(id);
    renderBlueprintList();
    // Clear selection if it was the deleted one
    if (_pendingBlueprintId === id) {
      clearSelectedBlueprint();
    }
  }
};

// ── Export to clipboard / download ──────────────────────────────────

window.exportBlueprintToFile = (id) => {
  const json = exportBlueprint(id);
  if (!json) return;

  const bp = getBlueprint(id);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `blueprint-${(bp?.name || "export").replace(/\s+/g, "_")}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  addInterventionWarning(`Blueprint "${bp?.name}" exported!`, "info", 2000);
};

window.importBlueprintFromFile = (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const result = importBlueprint(e.target.result);
    if (result.success) {
      addInterventionWarning(
        `Blueprint "${result.blueprint.name}" imported!`,
        "info",
        3000
      );
      STATE.sound?.playSuccess();
      // Refresh manager if open
      if (!document.getElementById("blueprint-modal")?.classList.contains("hidden")) {
        renderBlueprintList();
      }
    } else {
      addInterventionWarning("Import failed: " + result.error, "danger", 3000);
    }
  };
  reader.readAsText(file);
  event.target.value = ""; // allow re-importing same file
};

window.importBlueprintFromText = () => {
  const text = prompt("Paste blueprint JSON text here:");
  if (!text) return;

  const result = importBlueprint(text);
  if (result.success) {
    addInterventionWarning(
      `Blueprint "${result.blueprint.name}" imported!`,
      "info",
      3000
    );
    STATE.sound?.playSuccess();
    if (!document.getElementById("blueprint-modal")?.classList.contains("hidden")) {
      renderBlueprintList();
    }
  } else {
    addInterventionWarning("Import failed: " + result.error, "danger", 3000);
  }
};
