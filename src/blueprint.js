// ==================== BLUEPRINT SYSTEM ====================
// Save, load, manage, export/import architecture blueprints.
// Blueprints capture service type, position, tier and connection topology.

const BLUEPRINT_STORAGE_KEY = 'serverSurvivalBlueprints';
const BLUEPRINT_VERSION = 1;

const BlueprintManager = {
  // ---- Persistence ----

  _loadAll() {
    try {
      const raw = localStorage.getItem(BLUEPRINT_STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      // Run migration on each blueprint
      return arr.map(bp => BlueprintManager._migrate(bp)).filter(Boolean);
    } catch (e) {
      console.error('BlueprintManager: failed to load blueprints', e);
      return [];
    }
  },

  _saveAll(blueprints) {
    try {
      localStorage.setItem(BLUEPRINT_STORAGE_KEY, JSON.stringify(blueprints));
    } catch (e) {
      console.error('BlueprintManager: failed to save blueprints', e);
    }
  },

  _migrate(bp) {
    if (!bp || !bp.services) return null;
    // Version 1 is current; future versions add migration steps here.
    if (!bp.version) bp.version = 1;
    // Filter out services whose type no longer exists in CONFIG
    bp.services = bp.services.filter(s => CONFIG.services[s.type]);
    // Ensure every service has a tier field
    bp.services.forEach(s => { if (!s.tier) s.tier = 1; });
    return bp;
  },

  // ---- Cost Calculation ----

  _calculateBlueprintCost(bp) {
    let total = 0;
    for (const svc of bp.services) {
      const cfg = CONFIG.services[svc.type];
      if (!cfg) continue;
      total += cfg.cost;
      // Add tier upgrade costs
      if (svc.tier && svc.tier > 1 && cfg.tiers) {
        for (let t = 1; t < svc.tier; t++) {
          const tierData = cfg.tiers[t]; // tiers[t] is tier level t+1
          if (tierData) total += tierData.cost;
        }
      }
    }
    return total;
  },

  // ---- Capture current architecture ----

  captureFromState(name) {
    const services = STATE.services.map((s, idx) => ({
      type: s.type,
      position: { x: s.position.x, y: s.position.y, z: s.position.z },
      tier: s.tier || 1,
      index: idx
    }));

    const connections = STATE.connections.map(c => ({
      fromIndex: c.from === 'internet' ? -1 : STATE.services.findIndex(s => s.id === c.from),
      toIndex: c.to === 'internet' ? -1 : STATE.services.findIndex(s => s.id === c.to)
    }));

    return {
      id: 'bp_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6),
      name: name || ('Blueprint ' + new Date().toLocaleDateString()),
      version: BLUEPRINT_VERSION,
      createdAt: Date.now(),
      services: services,
      connections: connections
    };
  },

  // ---- Save ----

  save(name) {
    if (!STATE.services.length) {
      return { ok: false, error: i18n.t('blueprint_no_services') || 'No services to save.' };
    }
    const bp = this.captureFromState(name);
    const all = this._loadAll();
    all.push(bp);
    this._saveAll(all);
    return { ok: true, blueprint: bp };
  },

  // ---- Delete ----

  delete(id) {
    const all = this._loadAll();
    const filtered = all.filter(bp => bp.id !== id);
    this._saveAll(filtered);
    return filtered.length < all.length;
  },

  // ---- List ----

  list() {
    return this._loadAll();
  },

  // ---- Validate for current game mode ----

  validate(blueprint, mode, campaignLevel) {
    const warnings = [];
    const errors = [];

    for (const svc of blueprint.services) {
      if (!CONFIG.services[svc.type]) {
        errors.push(i18n.t('blueprint_unknown_service', { type: svc.type }) || `Unknown service type: ${svc.type}`);
      }
    }

    // Campaign mode: check allowedServices / forbiddenServices
    if (mode === 'campaign' && campaignLevel) {
      const allowed = campaignLevel.allowedServices;
      const forbidden = campaignLevel.forbiddenServices || [];
      const allowSet = allowed && allowed.length ? new Set(allowed) : null;
      const blockSet = new Set(forbidden);

      const blockedServices = [];
      for (const svc of blueprint.services) {
        let isAllowed = true;
        if (allowSet) {
          isAllowed = allowSet.has(svc.type);
        }
        if (blockSet.has(svc.type)) {
          isAllowed = false;
        }
        if (!isAllowed) {
          blockedServices.push(svc.type);
        }
      }

      if (blockedServices.length) {
        const unique = [...new Set(blockedServices)];
        warnings.push(
          (i18n.t('blueprint_campaign_blocked') || 'Some services are not allowed in this level: ')
          + unique.map(t => CONFIG.services[t]?.name || t).join(', ')
        );
      }
    }

    return { warnings, errors, valid: errors.length === 0 };
  },

  // ---- Load blueprint into current game ----

  load(blueprintId, mode, campaignLevel) {
    const all = this._loadAll();
    const bp = all.find(b => b.id === blueprintId);
    if (!bp) return { ok: false, error: i18n.t('blueprint_not_found') || 'Blueprint not found.' };

    return this._applyBlueprint(bp, mode, campaignLevel);
  },

  _applyBlueprint(bp, mode, campaignLevel) {
    // Validate first
    const validation = this.validate(bp, mode, campaignLevel);
    if (!validation.valid) {
      return { ok: false, error: validation.errors.join('\n'), warnings: validation.warnings };
    }

    // Calculate cost
    const totalCost = this._calculateBlueprintCost(bp);

    // Check budget
    const availableMoney = STATE.money;
    if (availableMoney < totalCost) {
      return {
        ok: false,
        error: (i18n.t('blueprint_insufficient_budget') || 'Insufficient budget. Blueprint costs $${cost}, but you only have $${budget}.')
          .replace('${cost}', totalCost)
          .replace('${budget}', Math.floor(availableMoney))
      };
    }

    // Filter services based on campaign restrictions
    let servicesToLoad = bp.services;
    let connectionsToLoad = bp.connections;

    if (mode === 'campaign' && campaignLevel) {
      const allowed = campaignLevel.allowedServices;
      const forbidden = campaignLevel.forbiddenServices || [];
      const allowSet = allowed && allowed.length ? new Set(allowed) : null;
      const blockSet = new Set(forbidden);

      // Build a set of allowed indices
      const allowedIndices = new Set();
      const filteredServices = [];
      const indexMap = {}; // old index -> new index

      servicesToLoad.forEach((svc, oldIdx) => {
        let isAllowed = true;
        if (allowSet) isAllowed = allowSet.has(svc.type);
        if (blockSet.has(svc.type)) isAllowed = false;
        if (isAllowed) {
          indexMap[oldIdx] = filteredServices.length;
          filteredServices.push(svc);
          allowedIndices.add(oldIdx);
        }
      });

      servicesToLoad = filteredServices;
      // Remap connections, skip those referencing filtered-out services
      connectionsToLoad = bp.connections
        .filter(c => {
          if (c.fromIndex !== -1 && !allowedIndices.has(c.fromIndex)) return false;
          if (c.toIndex !== -1 && !allowedIndices.has(c.toIndex)) return false;
          return true;
        })
        .map(c => ({
          fromIndex: c.fromIndex === -1 ? -1 : indexMap[c.fromIndex],
          toIndex: c.toIndex === -1 ? -1 : indexMap[c.toIndex]
        }));
    }

    // Deduct cost from budget
    STATE.money -= totalCost;
    if (STATE.finances) {
      STATE.finances.expenses.services += totalCost;
    }

    // Create services
    const placedServices = [];
    for (const svc of servicesToLoad) {
      const pos = new THREE.Vector3(svc.position.x, 0, svc.position.z);
      const service = new Service(svc.type, pos);

      // Restore tier
      if (svc.tier && svc.tier > 1) {
        const tiers = CONFIG.services[svc.type]?.tiers;
        if (tiers) {
          service.tier = svc.tier;
          const tierData = tiers[svc.tier - 1];
          if (tierData) {
            service.config = { ...service.config, capacity: tierData.capacity };
            if (tierData.cacheHitRate) {
              service.config = { ...service.config, cacheHitRate: tierData.cacheHitRate };
            }
            if (tierData.rateLimit) {
              service.config = { ...service.config, rateLimit: tierData.rateLimit };
            }
          }
          // Add tier ring visuals
          for (let t = 2; t <= service.tier; t++) {
            let ringSize, ringColor;
            if (service.type === 'db') { ringSize = 2.2; ringColor = 0xff0000; }
            else if (service.type === 'cache') { ringSize = 1.5; ringColor = 0xdc382d; }
            else if (service.type === 'apigw') { ringSize = 1.5; ringColor = 0xe879f9; }
            else if (service.type === 'nosql') { ringSize = 2.0; ringColor = 0x7c3aed; }
            else if (service.type === 'search') { ringSize = 1.5; ringColor = 0x06b6d4; }
            else if (service.type === 'replica') { ringSize = 1.8; ringColor = 0xf472b6; }
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

      STATE.services.push(service);
      placedServices.push(service);

      // Track finance counts
      if (STATE.finances) {
        STATE.finances.expenses.countByService[svc.type] =
          (STATE.finances.expenses.countByService[svc.type] || 0) + 1;
      }
    }

    // Rebuild connections using index mapping
    for (const conn of connectionsToLoad) {
      const fromId = conn.fromIndex === -1 ? 'internet' : placedServices[conn.fromIndex]?.id;
      const toId = conn.toIndex === -1 ? 'internet' : placedServices[conn.toIndex]?.id;
      if (fromId && toId) {
        createConnection(fromId, toId);
      }
    }

    updateRepairCostTable();

    return {
      ok: true,
      warnings: validation.warnings,
      cost: totalCost,
      serviceCount: placedServices.length,
      connectionCount: connectionsToLoad.length
    };
  },

  // ---- Export ----

  exportBlueprint(id) {
    const all = this._loadAll();
    const bp = all.find(b => b.id === id);
    if (!bp) return null;
    // Export as a clean JSON object (no internal id needed for sharing)
    const exportData = {
      name: bp.name,
      version: bp.version,
      services: bp.services.map(s => ({
        type: s.type,
        position: s.position,
        tier: s.tier
      })),
      connections: bp.connections
    };
    return JSON.stringify(exportData, null, 2);
  },

  // ---- Import ----

  importBlueprint(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      if (!data.services || !Array.isArray(data.services)) {
        return { ok: false, error: i18n.t('blueprint_invalid_format') || 'Invalid blueprint format.' };
      }

      // Validate each service
      for (const svc of data.services) {
        if (!svc.type || !CONFIG.services[svc.type]) {
          return {
            ok: false,
            error: (i18n.t('blueprint_unknown_service') || 'Unknown service type: ${type}').replace('${type}', svc.type)
          };
        }
      }

      const bp = {
        id: 'bp_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6),
        name: data.name || (i18n.t('blueprint_imported') || 'Imported Blueprint'),
        version: data.version || BLUEPRINT_VERSION,
        createdAt: Date.now(),
        services: data.services.map((s, i) => ({
          type: s.type,
          position: s.position || { x: i * 8, y: 0, z: 0 },
          tier: s.tier || 1,
          index: i
        })),
        connections: (data.connections || []).map(c => ({
          fromIndex: c.fromIndex,
          toIndex: c.toIndex
        }))
      };

      const all = this._loadAll();
      all.push(bp);
      this._saveAll(all);
      return { ok: true, blueprint: bp };
    } catch (e) {
      return { ok: false, error: i18n.t('blueprint_import_error') || 'Failed to parse blueprint data.' };
    }
  }
};

// ==================== BLUEPRINT UI ====================

window.showBlueprintManager = () => {
  document.getElementById('blueprint-modal').classList.remove('hidden');
  renderBlueprintList();
};

window.closeBlueprintManager = () => {
  document.getElementById('blueprint-modal').classList.add('hidden');
};

function renderBlueprintList() {
  const list = document.getElementById('blueprint-list');
  if (!list) return;

  const blueprints = BlueprintManager.list();

  if (!blueprints.length) {
    list.innerHTML = `<div class="text-gray-500 text-center py-8 italic">${i18n.t('blueprint_empty') || 'No blueprints saved yet. Build an architecture and save it!'}</div>`;
    return;
  }

  list.innerHTML = blueprints.map(bp => {
    const cost = BlueprintManager._calculateBlueprintCost(bp);
    const date = new Date(bp.createdAt).toLocaleDateString();
    const svcCount = bp.services.length;
    const connCount = bp.connections.length;
    return `
      <div class="border border-gray-700 rounded-lg p-3 hover:bg-gray-800/60 transition" data-bp-id="${bp.id}">
        <div class="flex justify-between items-start mb-2">
          <div>
            <div class="text-white font-bold">${escapeHtml(bp.name)}</div>
            <div class="text-gray-500 text-xs">${date} · ${svcCount} ${i18n.t('blueprint_services_short') || 'services'} · ${connCount} ${i18n.t('blueprint_connections_short') || 'connections'}</div>
          </div>
          <div class="text-green-400 font-mono text-sm">$${cost}</div>
        </div>
        <div class="flex gap-2 mt-2">
          <button onclick="loadBlueprintById('${bp.id}')"
            class="flex-1 bg-green-800/50 hover:bg-green-700 text-green-300 text-xs py-1.5 rounded border border-green-700/50 font-mono uppercase">
            ${i18n.t('blueprint_load') || 'Load'}
          </button>
          <button onclick="exportBlueprintById('${bp.id}')"
            class="flex-1 bg-blue-800/50 hover:bg-blue-700 text-blue-300 text-xs py-1.5 rounded border border-blue-700/50 font-mono uppercase">
            ${i18n.t('blueprint_export') || 'Export'}
          </button>
          <button onclick="deleteBlueprintById('${bp.id}')"
            class="bg-red-900/50 hover:bg-red-800 text-red-300 text-xs py-1.5 px-3 rounded border border-red-700/50 font-mono uppercase">
            ${i18n.t('blueprint_delete') || 'Del'}
          </button>
        </div>
      </div>`;
  }).join('');
}

window.loadBlueprintById = (id) => {
  // Determine current mode and campaign level
  const mode = STATE.gameMode;
  let campaignLevel = null;
  if (mode === 'campaign' && STATE.campaign?.level) {
    campaignLevel = STATE.campaign.level;
  }

  const result = BlueprintManager.load(id, mode, campaignLevel);

  if (!result.ok) {
    showBlueprintMessage(result.error, 'danger');
    return;
  }

  if (result.warnings && result.warnings.length) {
    result.warnings.forEach(w => {
      addInterventionWarning(w, 'warning', 5000);
    });
  }

  showBlueprintMessage(
    (i18n.t('blueprint_loaded_msg') || 'Blueprint loaded! ${count} services, $${cost} spent.')
      .replace('${count}', result.serviceCount)
      .replace('${cost}', result.cost),
    'info'
  );
  STATE.sound?.playPlace();
  window.closeBlueprintManager();
};

window.deleteBlueprintById = (id) => {
  if (BlueprintManager.delete(id)) {
    renderBlueprintList();
  }
};

window.exportBlueprintById = (id) => {
  const json = BlueprintManager.exportBlueprint(id);
  if (!json) return;

  // Show export textarea
  document.getElementById('blueprint-export-area').classList.remove('hidden');
  document.getElementById('blueprint-export-text').value = json;
  document.getElementById('blueprint-export-text').select();
};

window.saveCurrentAsBlueprint = () => {
  const nameInput = document.getElementById('blueprint-name-input');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    showBlueprintMessage(i18n.t('blueprint_name_required') || 'Please enter a name for the blueprint.', 'warning');
    return;
  }
  const result = BlueprintManager.save(name);
  if (result.ok) {
    if (nameInput) nameInput.value = '';
    showBlueprintMessage(
      (i18n.t('blueprint_saved_msg') || 'Blueprint "${name}" saved!').replace('${name}', escapeHtml(name)),
      'info'
    );
    renderBlueprintList();
    STATE.sound?.playPlace();
  } else {
    showBlueprintMessage(result.error, 'danger');
  }
};

window.importBlueprintFromText = () => {
  const textarea = document.getElementById('blueprint-import-text');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) {
    showBlueprintMessage(i18n.t('blueprint_paste_first') || 'Paste blueprint data first.', 'warning');
    return;
  }
  const result = BlueprintManager.importBlueprint(text);
  if (result.ok) {
    textarea.value = '';
    document.getElementById('blueprint-import-area').classList.add('hidden');
    showBlueprintMessage(
      (i18n.t('blueprint_imported_msg') || 'Blueprint "${name}" imported!').replace('${name}', escapeHtml(result.blueprint.name)),
      'info'
    );
    renderBlueprintList();
    STATE.sound?.playPlace();
  } else {
    showBlueprintMessage(result.error, 'danger');
  }
};

window.toggleBlueprintImport = () => {
  const area = document.getElementById('blueprint-import-area');
  if (area) area.classList.toggle('hidden');
};

window.copyBlueprintExport = () => {
  const textarea = document.getElementById('blueprint-export-text');
  if (textarea) {
    textarea.select();
    navigator.clipboard.writeText(textarea.value).catch(() => {});
    showBlueprintMessage(i18n.t('blueprint_copied') || 'Copied to clipboard!', 'info');
  }
};

function showBlueprintMessage(msg, type) {
  const el = document.getElementById('blueprint-message');
  if (!el) return;
  el.textContent = msg;
  el.className = `text-xs px-3 py-2 rounded border mb-3 ${
    type === 'danger' ? 'bg-red-900/50 border-red-700 text-red-300' :
    type === 'warning' ? 'bg-yellow-900/50 border-yellow-700 text-yellow-300' :
    'bg-blue-900/50 border-blue-700 text-blue-300'
  }`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Close blueprint modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('blueprint-modal');
    if (modal && !modal.classList.contains('hidden')) {
      window.closeBlueprintManager();
      e.stopImmediatePropagation();
    }
  }
});
