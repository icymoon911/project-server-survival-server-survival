// ServiceVisuals.js - Visual configuration registry
// Single source of truth for geometry, material, positioning, and tier ring visuals.
// To add a new service type: add an entry to SERVICE_VISUALS and TIER_RING_CONFIG.

const SERVICE_VISUALS = {
  waf: {
    geometry: () => new THREE.BoxGeometry(3, 2, 0.5),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.waf, roughness: 0.2 }),
    yOffset: 1
  },

  alb: {
    geometry: () => new THREE.BoxGeometry(3, 1.5, 3),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.alb, roughness: 0.1 }),
    yOffset: 0.75
  },

  compute: {
    geometry: () => new THREE.CylinderGeometry(1.2, 1.2, 3, 16),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.compute, roughness: 0.2 }),
    yOffset: 1.5
  },

  db: {
    geometry: () => new THREE.CylinderGeometry(2, 2, 2, 6),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.db, roughness: 0.3 }),
    yOffset: 1
  },

  s3: {
    geometry: () => new THREE.CylinderGeometry(1.8, 1.5, 1.5, 8),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.s3, roughness: 0.2 }),
    yOffset: 0.75
  },

  cache: {
    geometry: () => new THREE.BoxGeometry(2.5, 1.5, 2.5),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.cache, roughness: 0.2 }),
    yOffset: 0.75
  },

  sqs: {
    geometry: () => new THREE.BoxGeometry(4, 0.8, 2),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.sqs, roughness: 0.2 }),
    yOffset: 0.4
  },

  cdn: {
    geometry: () => new THREE.SphereGeometry(1.5, 16, 16),
    material: () => new THREE.MeshStandardMaterial({ color: 0x4ade80, roughness: 0.2, wireframe: true }),
    yOffset: 1.5
  },

  apigw: {
    geometry: () => new THREE.OctahedronGeometry(1.5, 0),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.apigw, roughness: 0.2 }),
    yOffset: 1.5
  },

  nosql: {
    geometry: () => new THREE.CylinderGeometry(2, 2, 1.5, 16),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.nosql, roughness: 0.3 }),
    yOffset: 1
  },

  search: {
    geometry: () => new THREE.DodecahedronGeometry(1.5, 0),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.search, roughness: 0.2 }),
    yOffset: 1.5
  },

  replica: {
    geometry: () => new THREE.CylinderGeometry(1.8, 1.8, 1, 6),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.replica, roughness: 0.3 }),
    yOffset: 1
  },

  serverless: {
    geometry: () => new THREE.TetrahedronGeometry(1.8, 0),
    material: () => new THREE.MeshStandardMaterial({ color: CONFIG.colors.serverless, roughness: 0.2 }),
    yOffset: 1.5
  }
};

// Tier ring colors and sizes - single source of truth for upgrade() and restore()
const TIER_RING_CONFIG = {
  db:       { ringColor: 0xff0000, ringSize: 2.2 },
  cache:    { ringColor: 0xdc382d, ringSize: 1.5 },
  apigw:    { ringColor: 0xe879f9, ringSize: 1.5 },
  nosql:    { ringColor: 0x7c3aed, ringSize: 2.0 },
  search:   { ringColor: 0x06b6d4, ringSize: 1.5 },
  replica:  { ringColor: 0xf472b6, ringSize: 1.8 },
  compute:  { ringColor: 0xffff00, ringSize: 1.3 },
  serverless: { ringColor: 0xffff00, ringSize: 1.3 }
};
