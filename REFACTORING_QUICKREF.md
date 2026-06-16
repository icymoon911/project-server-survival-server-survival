# Service Refactoring - Quick Reference

## What Changed

### Before
- `Service.js`: 981 lines with 400+ line `update()` method
- Massive if/else chain for 11 service types
- Duplicated tier ring code in 2 places
- 108-line switch/case in constructor

### After
- `Service.js`: 522 lines with 52-line `update()` method
- Strategy pattern with isolated type handlers
- Single source of truth for visuals and tier rings
- Config-driven visual setup

## File Structure

```
src/entities/
├── Service.js              (522 lines - main class)
├── ServiceStrategies.js    (272 lines - processing logic)
├── ServiceVisuals.js       (85 lines - visual configs)
└── Request.js              (unchanged)

test/
├── test-strategies.html    (browser tests)
└── validate-refactoring.js (Node validation)
```

## Key Components

### SERVICE_STRATEGIES (ServiceStrategies.js)
```javascript
{
  db: { processJob(service, job) { ... } },
  cache: { processJob(service, job) { ... } },
  compute: { processJob(service, job) { ... } },
  serverless: { processJob(service, job) { ... } },
  // ... all 11 types
}
```

### SERVICE_VISUALS (ServiceVisuals.js)
```javascript
{
  db: {
    geometry: () => new THREE.CylinderGeometry(2, 2, 2, 6),
    material: () => new THREE.MeshStandardMaterial({ ... }),
    yOffset: 1
  },
  // ... all 13 types
}
```

### TIER_RING_CONFIG (ServiceVisuals.js)
```javascript
{
  db: { ringColor: 0xff0000, ringSize: 2.2 },
  cache: { ringColor: 0xdc382d, ringSize: 1.5 },
  // ... all upgradeable types
}
```

## Shared Functions

### applyComputeRouting(service, job)
Shared routing logic for compute and serverless:
- Check cache first (if cacheable)
- Route by destination type (db, s3, etc.)
- Prefer specialized services (search, replica, nosql)

### chargePerRequest(service)
Serverless billing: deducts `perRequestCost` from money

### applyComputePullLogic(service)
Pull model: compute/serverless pull from upstream SQS when local queue is low

### applyRoundRobin(service, job)
Fallback for types without explicit strategies (WAF, ALB)

## Common Patterns

### Routing to Connected Service
```javascript
const target = service.findConnectedService("cache");
if (target) {
  job.req.flyTo(target);
  return;
}
```

### Cache Hit Check
```javascript
if (job.req.isCacheable && Math.random() < job.req.cacheHitRate) {
  job.req.cached = true;
  finishRequest(job.req, service.type);
  return;
}
```

### Rate Limiting (API Gateway)
```javascript
service.rateCounter++;
if (service.rateCounter > service.config.rateLimit) {
  throttleRequest(job.req);
  return;
}
```

### SQS Backpressure
```javascript
if (target.queue.length + target.incomingCount < target.config.maxQueueSize) {
  job.req.flyTo(target);
} else {
  // Downstream busy - signal to stop processing
  return { stop: true };
}
```

## Testing

### Quick Validation
```bash
node test/validate-refactoring.js
```

### Full Test Suite
```bash
open test/test-strategies.html
```

### Manual Testing
1. Start game in Sandbox mode
2. Place each service type
3. Verify connections work
4. Test upgrades (tier rings appear)
5. Save and reload (tier rings restored)
6. Watch request routing in action

## Debugging Tips

### Finding Type Logic
- **Processing**: Look in `SERVICE_STRATEGIES[type].processJob()`
- **Visuals**: Look in `SERVICE_VISUALS[type]`
- **Tier rings**: Look in `TIER_RING_CONFIG[type]`
- **Config values**: Look in `CONFIG.services[type]`

### Common Issues

**Issue**: Service not processing requests  
**Check**: Strategy exists in `SERVICE_STRATEGIES` and has `processJob` method

**Issue**: Wrong geometry/material  
**Check**: `SERVICE_VISUALS[type]` has correct `geometry()` and `material()` factories

**Issue**: Tier rings wrong color/size  
**Check**: `TIER_RING_CONFIG[type]` has correct `ringColor` and `ringSize`

**Issue**: Compute/Serverless not routing correctly  
**Check**: `applyComputeRouting()` logic matches original if/else chain

## Performance Notes

- Strategy lookup is O(1) object property access
- No performance impact from refactoring
- Slightly faster due to reduced code size
- Easier to optimize individual strategies

## Next Steps

### Optional Improvements

1. **Move upgradeable flag to config**
   ```javascript
   // In CONFIG.services
   db: { upgradeable: true, ... }
   ```

2. **Add JSDoc type hints**
   ```javascript
   /**
    * @param {Service} service
    * @param {{req: Request, timer: number}} job
    */
   processJob(service, job) { ... }
   ```

3. **Strategy inheritance**
   ```javascript
   serverless: {
     ...computeStrategy,
     processJob(service, job) {
       chargePerRequest(service);
       computeStrategy.processJob(service, job);
     }
   }
   ```

4. **Event hooks**
   ```javascript
   compute: {
     onBeforeProcess(service) { ... },
     processJob(service, job) { ... },
     onAfterProcess(service) { ... }
   }
   ```

## Cheat Sheet

### Add New Service Type (3 steps)

**1. config.js**
```javascript
CONFIG.services.newtype = {
  name: "New Type",
  cost: 100,
  processingTime: 200,
  capacity: 10,
  upkeep: 8
};
```

**2. ServiceVisuals.js**
```javascript
SERVICE_VISUALS.newtype = {
  geometry: () => new THREE.BoxGeometry(2, 2, 2),
  material: () => new THREE.MeshStandardMaterial({
    color: 0xff00ff,
    roughness: 0.2
  }),
  yOffset: 1
};
```

**3. ServiceStrategies.js**
```javascript
SERVICE_STRATEGIES.newtype = {
  processJob(service, job) {
    // Your logic here
    finishRequest(job.req, service.type);
  }
};
```

Done! No changes to Service.js needed.

## Support

- **Questions**: Check `REFACTORING.md` for detailed explanation
- **Tests**: Run `test/test-strategies.html` in browser
- **Validation**: Run `node test/validate-refactoring.js`
- **Issues**: Compare strategy logic with original Service.js (git history)

---

**Status**: ✅ Complete and validated  
**Date**: 2026-06-16  
**Lines Changed**: ~1500 (added + modified + removed)  
**Test Coverage**: 30 automated tests + manual checklist
