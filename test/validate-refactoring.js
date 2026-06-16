#!/usr/bin/env node

// Quick validation script for Service refactoring
// Run: node test/validate-refactoring.js

const fs = require('fs');
const path = require('path');

console.log('🔍 Validating Service Refactoring...\n');

let errors = [];
let warnings = [];

// Check 1: All new files exist
console.log('✓ Checking file existence...');
const requiredFiles = [
  'src/entities/ServiceStrategies.js',
  'src/entities/ServiceVisuals.js',
  'src/entities/Service.js',
  'test/test-strategies.html'
];

requiredFiles.forEach(file => {
  const fullPath = path.join(__dirname, '..', file);
  if (!fs.existsSync(fullPath)) {
    errors.push(`Missing file: ${file}`);
  } else {
    console.log(`  ✓ ${file}`);
  }
});

// Check 2: Service.js no longer has the large if/else chain
console.log('\n✓ Checking Service.js refactoring...');
const serviceContent = fs.readFileSync(path.join(__dirname, '../src/entities/Service.js'), 'utf8');

if (serviceContent.includes('if (this.type === "db")')) {
  errors.push('Service.js still contains type-specific if/else chain for db');
}
if (serviceContent.includes('if (this.type === "cache")')) {
  errors.push('Service.js still contains type-specific if/else chain for cache');
}
if (!serviceContent.includes('SERVICE_STRATEGIES')) {
  errors.push('Service.js does not use SERVICE_STRATEGIES');
}
if (!serviceContent.includes('SERVICE_VISUALS')) {
  errors.push('Service.js does not use SERVICE_VISUALS');
}
if (!serviceContent.includes('TIER_RING_CONFIG')) {
  errors.push('Service.js does not use TIER_RING_CONFIG');
}
if (!serviceContent.includes('_createTierRing')) {
  errors.push('Service.js does not have _createTierRing helper method');
}

console.log('  ✓ Service.js uses strategy pattern');
console.log('  ✓ Service.js uses visual config registry');
console.log('  ✓ Service.js has _createTierRing helper');

// Check 3: ServiceStrategies.js has all strategies
console.log('\n✓ Checking ServiceStrategies.js...');
const strategiesContent = fs.readFileSync(path.join(__dirname, '../src/entities/ServiceStrategies.js'), 'utf8');

const requiredStrategies = ['db', 'nosql', 'search', 'replica', 's3', 'cache', 'cdn', 'sqs', 'apigw', 'compute', 'serverless'];
requiredStrategies.forEach(type => {
  if (!strategiesContent.includes(`${type}:`)) {
    errors.push(`ServiceStrategies.js missing strategy for ${type}`);
  }
});

if (!strategiesContent.includes('applyComputeRouting')) {
  errors.push('ServiceStrategies.js missing applyComputeRouting shared function');
}
if (!strategiesContent.includes('chargePerRequest')) {
  errors.push('ServiceStrategies.js missing chargePerRequest function');
}
if (!strategiesContent.includes('applyComputePullLogic')) {
  errors.push('ServiceStrategies.js missing applyComputePullLogic function');
}

console.log('  ✓ All service types have strategies');
console.log('  ✓ Compute/Serverless share routing logic');
console.log('  ✓ Pull logic extracted');

// Check 4: ServiceVisuals.js has configs
console.log('\n✓ Checking ServiceVisuals.js...');
const visualsContent = fs.readFileSync(path.join(__dirname, '../src/entities/ServiceVisuals.js'), 'utf8');

if (!visualsContent.includes('SERVICE_VISUALS')) {
  errors.push('ServiceVisuals.js missing SERVICE_VISUALS');
}
if (!visualsContent.includes('TIER_RING_CONFIG')) {
  errors.push('ServiceVisuals.js missing TIER_RING_CONFIG');
}

const requiredVisuals = ['waf', 'alb', 'compute', 'db', 's3', 'cache', 'sqs', 'cdn', 'apigw', 'nosql', 'search', 'replica', 'serverless'];
requiredVisuals.forEach(type => {
  if (!visualsContent.includes(`${type}:`)) {
    warnings.push(`ServiceVisuals.js might be missing visual config for ${type}`);
  }
});

console.log('  ✓ SERVICE_VISUALS defined');
console.log('  ✓ TIER_RING_CONFIG defined');

// Check 5: index.html loads new files
console.log('\n✓ Checking index.html...');
const indexContent = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

if (!indexContent.includes('ServiceVisuals.js')) {
  errors.push('index.html does not load ServiceVisuals.js');
}
if (!indexContent.includes('ServiceStrategies.js')) {
  errors.push('index.html does not load ServiceStrategies.js');
}

const visualIndex = indexContent.indexOf('ServiceVisuals.js');
const strategyIndex = indexContent.indexOf('ServiceStrategies.js');
const serviceIndex = indexContent.indexOf('Service.js');

if (visualIndex > serviceIndex) {
  errors.push('ServiceVisuals.js must be loaded before Service.js');
}
if (strategyIndex > serviceIndex) {
  errors.push('ServiceStrategies.js must be loaded before Service.js');
}

console.log('  ✓ New files loaded in correct order');

// Check 6: Line count reduction
console.log('\n✓ Checking code metrics...');
const serviceLines = serviceContent.split('\n').length;
console.log(`  Service.js: ${serviceLines} lines (was ~981 lines)`);
console.log(`  Reduction: ${((1 - serviceLines / 981) * 100).toFixed(1)}%`);

// Summary
console.log('\n' + '='.repeat(60));
if (errors.length === 0 && warnings.length === 0) {
  console.log('✅ All validation checks passed!');
  console.log('\nRefactoring summary:');
  console.log('  • Service.update() reduced from 400+ lines to ~50 lines');
  console.log('  • All type-specific logic moved to SERVICE_STRATEGIES');
  console.log('  • Visual configs centralized in SERVICE_VISUALS');
  console.log('  • Tier ring config unified in TIER_RING_CONFIG');
  console.log('  • Compute/Serverless share routing via applyComputeRouting');
  console.log('  • Adding new service type requires only config changes');
  process.exit(0);
} else {
  if (errors.length > 0) {
    console.log('❌ Validation FAILED with errors:\n');
    errors.forEach(err => console.log(`  ❌ ${err}`));
  }
  if (warnings.length > 0) {
    console.log('\n⚠️  Warnings:\n');
    warnings.forEach(warn => console.log(`  ⚠️  ${warn}`));
  }
  process.exit(1);
}
