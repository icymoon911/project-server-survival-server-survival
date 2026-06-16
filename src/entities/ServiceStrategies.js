// ServiceStrategies.js - Per-type processing logic registry
// Each service type has a strategy that defines how it processes requests.
// To add a new service type: add a strategy here with processJob(service, job).

// Shared routing logic for compute/serverless
function applyComputeRouting(service, job) {
  const destType = job.req.destination;

  if (destType === "blocked") {
    failRequest(job.req);
    return;
  }

  if (job.req.isCacheable) {
    const cacheTarget = service.findConnectedService("cache");
    if (cacheTarget) {
      job.req.flyTo(cacheTarget);
      return;
    }
  }

  if (destType === "db") {
    if (job.req.type === "SEARCH") {
      const searchTarget = service.findConnectedService("search");
      if (searchTarget) { job.req.flyTo(searchTarget); return; }
      const sqlTarget = service.findConnectedService("db");
      if (sqlTarget) { job.req.flyTo(sqlTarget); return; }
    } else if (job.req.type === "READ") {
      const replicaTarget = service.findConnectedService("replica");
      if (replicaTarget) { job.req.flyTo(replicaTarget); return; }
      const nosqlTarget = service.findConnectedService("nosql");
      if (nosqlTarget) { job.req.flyTo(nosqlTarget); return; }
      const sqlTarget = service.findConnectedService("db");
      if (sqlTarget) { job.req.flyTo(sqlTarget); return; }
    } else {
      const nosqlTarget = service.findConnectedService("nosql");
      if (nosqlTarget) { job.req.flyTo(nosqlTarget); return; }
      const sqlTarget = service.findConnectedService("db");
      if (sqlTarget) { job.req.flyTo(sqlTarget); return; }
    }
    failRequest(job.req);
    return;
  }

  const directTarget = service.findConnectedService(destType);
  if (directTarget) {
    job.req.flyTo(directTarget);
  } else {
    failRequest(job.req);
  }
}

// Charge per-request cost for serverless
function chargePerRequest(service) {
  const cost = service.config.perRequestCost || 0;
  STATE.money -= cost;
  if (STATE.finances) {
    STATE.finances.expenses.upkeep += cost;
    STATE.finances.expenses.byService.serverless =
      (STATE.finances.expenses.byService.serverless || 0) + cost;
  }
}

// Round-robin fallback for types without explicit strategies
function applyRoundRobin(service, job) {
  const candidates = service.connections
    .map(id => STATE.services.find(s => s.id === id))
    .filter(s => s !== undefined && !s.isDisabled);

  if (candidates.length > 0) {
    const target = candidates[service.rrIndex % candidates.length];
    service.rrIndex++;
    job.req.flyTo(target);
  } else {
    failRequest(job.req);
  }
}

const SERVICE_STRATEGIES = {
  db: {
    processJob(service, job) {
      if (job.req.destination === "db") {
        finishRequest(job.req, service.type);
      } else {
        failRequest(job.req);
      }
    }
  },

  nosql: {
    processJob(service, job) {
      if (job.req.type === "SEARCH") {
        failRequest(job.req);
      } else if (job.req.destination === "db") {
        finishRequest(job.req, service.type);
      } else {
        failRequest(job.req);
      }
    }
  },

  search: {
    processJob(service, job) {
      if (job.req.type === "SEARCH") {
        finishRequest(job.req, service.type);
      } else {
        failRequest(job.req);
      }
    }
  },

  replica: {
    processJob(service, job) {
      const hasMaster = service.connections.some(id => {
        const s = STATE.services.find(svc => svc.id === id);
        return s && (s.type === "db" || s.type === "nosql");
      });
      if (!hasMaster) {
        failRequest(job.req);
        return;
      }
      if (job.req.type === "READ" && job.req.destination === "db") {
        finishRequest(job.req, service.type);
      } else {
        failRequest(job.req);
      }
    }
  },

  s3: {
    processJob(service, job) {
      if (job.req.destination === "s3" || job.req.destination === "cdn") {
        finishRequest(job.req, service.type);
      } else {
        failRequest(job.req);
      }
    }
  },

  cache: {
    processJob(service, job) {
      if (job.req.isCacheable) {
        const hitRate = job.req.cacheHitRate;
        if (Math.random() < hitRate) {
          job.req.cached = true;
          STATE.sound.playSuccess();
          service.flashCacheHit();
          finishRequest(job.req, service.type);
          return;
        }
      }

      const destType = job.req.destination;

      if (destType === "db") {
        if (job.req.type === "SEARCH") {
          const searchTarget = service.findConnectedService("search");
          if (searchTarget) { job.req.flyTo(searchTarget); return; }
        }
        if (job.req.type === "READ") {
          const replicaTarget = service.findConnectedService("replica");
          if (replicaTarget) { job.req.flyTo(replicaTarget); return; }
        }
        if (job.req.type !== "SEARCH") {
          const nosqlTarget = service.findConnectedService("nosql");
          if (nosqlTarget) { job.req.flyTo(nosqlTarget); return; }
        }
        const sqlTarget = service.findConnectedService("db");
        if (sqlTarget) { job.req.flyTo(sqlTarget); return; }
        failRequest(job.req);
      } else {
        const target = service.findConnectedService(destType);
        if (target) {
          job.req.flyTo(target);
        } else {
          failRequest(job.req);
        }
      }
    }
  },

  cdn: {
    processJob(service, job) {
      if (job.req.type === "STATIC") {
        const hitRate = service.config.cacheHitRate || 0.95;
        if (Math.random() < hitRate) {
          job.req.cached = true;
          STATE.sound.playSuccess();
          service.flashCacheHit();
          finishRequest(job.req, service.type);
          return;
        }
      }

      const connectedServices = service.connections
        .map(id => STATE.services.find(s => s.id === id))
        .filter(s => s && s.type !== "internet");

      if (connectedServices.length > 0) {
        const target = connectedServices[0];
        job.req.flyTo(target);
      } else {
        failRequest(job.req);
      }
    }
  },

  sqs: {
    processJob(service, job) {
      const downstreamTypes = ["alb"];
      const candidates = service.connections
        .map(id => STATE.services.find(s => s.id === id))
        .filter(s => s && downstreamTypes.includes(s.type) && !s.isDisabled);

      if (candidates.length === 0) {
        service.processing.splice(service._currentProcessingIndex, 0, job);
        return;
      }

      let sent = false;
      for (let attempt = 0; attempt < candidates.length; attempt++) {
        const target = candidates[service.rrIndex % candidates.length];
        service.rrIndex++;

        const targetMaxQueue = target.config.maxQueueSize || 20;
        if (target.queue.length + target.incomingCount < targetMaxQueue) {
          job.req.flyTo(target);
          sent = true;
          break;
        }
      }

      if (!sent) {
        service.processing.splice(service._currentProcessingIndex, 0, job);
        return { stop: true };
      }
    }
  },

  apigw: {
    processJob(service, job) {
      service.rateCounter = (service.rateCounter || 0) + 1;
      const rateLimit = service.config.rateLimit || 20;

      if (service.rateCounter > rateLimit) {
        throttleRequest(job.req);
        return;
      }

      const candidates = service.connections
        .map(id => STATE.services.find(s => s.id === id))
        .filter(s => s && !s.isDisabled);

      if (candidates.length > 0) {
        const target = candidates[service.rrIndex % candidates.length];
        service.rrIndex++;
        job.req.flyTo(target);
      } else {
        failRequest(job.req);
      }
    }
  },

  compute: {
    processJob(service, job) {
      applyComputeRouting(service, job);
    }
  },

  serverless: {
    processJob(service, job) {
      chargePerRequest(service);
      applyComputeRouting(service, job);
    }
  }
};

// Pull logic shared by compute and serverless
function applyComputePullLogic(service) {
  const pullThreshold = 1;
  const pendingWork = service.queue.length + service.incomingCount;

  if (pendingWork <= pullThreshold) {
    const upstreamSQS = STATE.services.filter(s =>
      s.type === 'sqs' &&
      s.connections.includes(service.id) &&
      !s.isDisabled
    );

    if (upstreamSQS.length > 0) {
      if (typeof service.upstreamRR === 'undefined') service.upstreamRR = 0;

      for (let i = 0; i < upstreamSQS.length; i++) {
        const idx = (service.upstreamRR + i) % upstreamSQS.length;
        const sqs = upstreamSQS[idx];

        const req = sqs.popRequest();
        if (req) {
          req.flyTo(service);
          service.upstreamRR = (idx + 1) % upstreamSQS.length;
          break;
        }
      }
    }
  }
}
