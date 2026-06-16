/**
 * SERVICE_HANDLERS — per-type request-processing strategies.
 *
 * Each handler may define:
 *   preProcess(service, dt)       Called once per frame before processQueue().
 *   getProcessingTime(service, job)  Return the processing duration in ms for this job.
 *   onJobFail(service, job)       Called when the random-fail check triggers (before failRequest).
 *   processJob(service, job)      Called when the job timer expires (job already spliced out).
 *                                 Return { break: true } to break the processing loop.
 *   postUpdate(service)           Called once per frame at the very end of update().
 *
 * Types without an entry fall through to DEFAULT_HANDLER (round-robin forwarding).
 * Adding a new service type = adding an entry here. No changes to Service.js needed.
 */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function _connectedCandidates(service, filterFn) {
  return service.connections
    .map((id) => STATE.services.find((s) => s.id === id))
    .filter((s) => s && !s.isDisabled && (!filterFn || filterFn(s)));
}

function _roundRobinForward(service, candidates, req) {
  if (candidates.length === 0) return false;
  const target = candidates[service.rrIndex % candidates.length];
  service.rrIndex++;
  req.flyTo(target);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Default handler (WAF, ALB, and any unregistered type)              */
/* ------------------------------------------------------------------ */

const DEFAULT_HANDLER = {
  processJob(service, job) {
    const candidates = _connectedCandidates(service);
    if (!_roundRobinForward(service, candidates, job.req)) {
      failRequest(job.req);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  DB                                                                 */
/* ------------------------------------------------------------------ */

const DB_HANDLER = {
  processJob(service, job) {
    if (job.req.destination === "db") {
      finishRequest(job.req, service.type);
    } else {
      failRequest(job.req);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  NoSQL                                                              */
/* ------------------------------------------------------------------ */

const NOSQL_HANDLER = {
  processJob(service, job) {
    if (job.req.type === "SEARCH") {
      failRequest(job.req);
    } else if (job.req.destination === "db") {
      finishRequest(job.req, service.type);
    } else {
      failRequest(job.req);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  Search Engine                                                      */
/* ------------------------------------------------------------------ */

const SEARCH_HANDLER = {
  processJob(service, job) {
    if (job.req.type === "SEARCH") {
      finishRequest(job.req, service.type);
    } else {
      failRequest(job.req);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  Read Replica                                                       */
/* ------------------------------------------------------------------ */

const REPLICA_HANDLER = {
  processJob(service, job) {
    const hasMaster = service.connections.some((id) => {
      const s = STATE.services.find((svc) => svc.id === id);
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
  },
};

/* ------------------------------------------------------------------ */
/*  S3                                                                 */
/* ------------------------------------------------------------------ */

const S3_HANDLER = {
  processJob(service, job) {
    if (job.req.destination === "s3" || job.req.destination === "cdn") {
      finishRequest(job.req, service.type);
    } else {
      failRequest(job.req);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  Cache                                                              */
/* ------------------------------------------------------------------ */

const CACHE_HANDLER = {
  processJob(service, job) {
    // Cache hit check
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

    // Cache miss — route to specialized services
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
  },
};

/* ------------------------------------------------------------------ */
/*  CDN                                                                */
/* ------------------------------------------------------------------ */

const CDN_HANDLER = {
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

    // Cache miss — forward to origin
    const connectedServices = service.connections
      .map((id) => STATE.services.find((s) => s.id === id))
      .filter((s) => s && s.type !== "internet");

    if (connectedServices.length > 0) {
      const target = connectedServices[0];
      job.req.flyTo(target);
    } else {
      failRequest(job.req);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  SQS                                                                */
/* ------------------------------------------------------------------ */

const SQS_HANDLER = {
  processJob(service, job) {
    // SQS forwards only to non-compute downstream (compute pulls from SQS instead)
    const downstreamTypes = ["alb"];
    const candidates = service.connections
      .map((id) => STATE.services.find((s) => s.id === id))
      .filter((s) => s && downstreamTypes.includes(s.type) && !s.isDisabled);

    // No push candidates — keep job so compute can pop it
    if (candidates.length === 0) {
      // Re-insert at the same index so it isn't lost
      service.processing.splice(service._currentJobIndex, 0, job);
      return;
    }

    // Round-robin with backpressure
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
      // Downstream busy — re-insert and stop processing this frame
      service.processing.splice(service._currentJobIndex, 0, job);
      return { break: true };
    }
  },

  postUpdate(service) {
    if (!service.queueFill) return;
    const maxQ = service.config.maxQueueSize || 200;
    const fillPercent = service.queue.length / maxQ;
    service.queueFill.scale.x = fillPercent;
    service.queueFill.position.x = (fillPercent - 1) * 1.9;

    if (fillPercent > 0.8) {
      service.queueFill.material.color.setHex(0xff0000);
    } else if (fillPercent > 0.5) {
      service.queueFill.material.color.setHex(0xffaa00);
    } else {
      service.queueFill.material.color.setHex(0x00ff00);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  API Gateway                                                        */
/* ------------------------------------------------------------------ */

const APIGW_HANDLER = {
  preProcess(service, dt) {
    service.rateTimer = (service.rateTimer || 0) + dt;
    if (service.rateTimer >= 1.0) {
      service.rateCounter = 0;
      service.rateTimer -= 1.0;
    }
  },

  processJob(service, job) {
    service.rateCounter = (service.rateCounter || 0) + 1;
    const rateLimit = service.config.rateLimit || 20;

    if (service.rateCounter > rateLimit) {
      throttleRequest(job.req);
      return;
    }

    const candidates = _connectedCandidates(service);
    if (!_roundRobinForward(service, candidates, job.req)) {
      failRequest(job.req);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  Compute (shared routing with serverless)                           */
/* ------------------------------------------------------------------ */

/**
 * Shared routing strategy for compute and serverless.
 * Serverless overlays per-request billing on top.
 */
const COMPUTE_ROUTING = {
  preProcess(service, dt) {
    // Pull model: compute nodes actively pull from upstream SQS
    const pullThreshold = 1;
    const pendingWork = service.queue.length + service.incomingCount;

    if (pendingWork <= pullThreshold) {
      const upstreamSQS = STATE.services.filter(
        (s) => s.type === "sqs" && s.connections.includes(service.id) && !s.isDisabled
      );

      if (upstreamSQS.length > 0) {
        if (typeof service.upstreamRR === "undefined") service.upstreamRR = 0;

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
  },

  getProcessingTime(service, job) {
    return service.config.processingTime * job.req.processingWeight;
  },

  onJobFail(service, job) {
    // Serverless pays per invocation even on failure
    if (service.type !== "serverless") return;
    const cost = service.config.perRequestCost || 0;
    STATE.money -= cost;
    if (STATE.finances) {
      STATE.finances.expenses.upkeep += cost;
      STATE.finances.expenses.byService.serverless =
        (STATE.finances.expenses.byService.serverless || 0) + cost;
    }
  },

  processJob(service, job) {
    const chargePerRequest = () => {
      if (service.type !== "serverless") return;
      const cost = service.config.perRequestCost || 0;
      STATE.money -= cost;
      if (STATE.finances) {
        STATE.finances.expenses.upkeep += cost;
        STATE.finances.expenses.byService.serverless =
          (STATE.finances.expenses.byService.serverless || 0) + cost;
      }
    };

    const destType = job.req.destination;

    if (destType === "blocked") {
      chargePerRequest();
      failRequest(job.req);
      return;
    }

    if (job.req.isCacheable) {
      const cacheTarget = service.findConnectedService("cache");
      if (cacheTarget) {
        chargePerRequest();
        job.req.flyTo(cacheTarget);
        return;
      }
    }

    // Routing: prefer specialized services, fallback to general
    if (destType === "db") {
      if (job.req.type === "SEARCH") {
        const searchTarget = service.findConnectedService("search");
        if (searchTarget) { chargePerRequest(); job.req.flyTo(searchTarget); return; }
        const sqlTarget = service.findConnectedService("db");
        if (sqlTarget) { chargePerRequest(); job.req.flyTo(sqlTarget); return; }
      } else if (job.req.type === "READ") {
        const replicaTarget = service.findConnectedService("replica");
        if (replicaTarget) { chargePerRequest(); job.req.flyTo(replicaTarget); return; }
        const nosqlTarget = service.findConnectedService("nosql");
        if (nosqlTarget) { chargePerRequest(); job.req.flyTo(nosqlTarget); return; }
        const sqlTarget = service.findConnectedService("db");
        if (sqlTarget) { chargePerRequest(); job.req.flyTo(sqlTarget); return; }
      } else {
        const nosqlTarget = service.findConnectedService("nosql");
        if (nosqlTarget) { chargePerRequest(); job.req.flyTo(nosqlTarget); return; }
        const sqlTarget = service.findConnectedService("db");
        if (sqlTarget) { chargePerRequest(); job.req.flyTo(sqlTarget); return; }
      }
      chargePerRequest();
      failRequest(job.req);
      return;
    }

    const directTarget = service.findConnectedService(destType);
    if (directTarget) {
      chargePerRequest();
      job.req.flyTo(directTarget);
    } else {
      chargePerRequest();
      failRequest(job.req);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

const SERVICE_HANDLERS = {
  db:         DB_HANDLER,
  nosql:      NOSQL_HANDLER,
  search:     SEARCH_HANDLER,
  replica:    REPLICA_HANDLER,
  s3:         S3_HANDLER,
  cache:      CACHE_HANDLER,
  cdn:        CDN_HANDLER,
  sqs:        SQS_HANDLER,
  apigw:      APIGW_HANDLER,
  compute:    COMPUTE_ROUTING,
  serverless: COMPUTE_ROUTING,
};

/**
 * getHandler — resolve the handler for a service type.
 * Falls back to DEFAULT_HANDLER (round-robin forwarding) for unregistered types.
 */
function getHandler(type) {
  return SERVICE_HANDLERS[type] || DEFAULT_HANDLER;
}
