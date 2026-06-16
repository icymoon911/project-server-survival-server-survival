/**
 * SERVICE_VISUALS — Visual configuration for each service type.
 *
 * Each entry defines:
 *   geometry:    a factory function returning a THREE.BufferGeometry
 *   material:    props passed to THREE.MeshStandardMaterial (color resolved from CONFIG.colors)
 *   yOffset:     how far to raise the mesh above ground
 *
 * Adding a new service type only requires adding an entry here — no changes to Service.js.
 */

const SERVICE_VISUALS = {
  waf: {
    geometry: () => new THREE.BoxGeometry(3, 2, 0.5),
    material: { roughness: 0.2 },
    yOffset: 1,
  },
  alb: {
    geometry: () => new THREE.BoxGeometry(3, 1.5, 3),
    material: { roughness: 0.1 },
    yOffset: 0.75,
  },
  compute: {
    geometry: () => new THREE.CylinderGeometry(1.2, 1.2, 3, 16),
    material: { roughness: 0.2 },
    yOffset: 1.5,
  },
  db: {
    geometry: () => new THREE.CylinderGeometry(2, 2, 2, 6),
    material: { roughness: 0.3 },
    yOffset: 1,
  },
  s3: {
    geometry: () => new THREE.CylinderGeometry(1.8, 1.5, 1.5, 8),
    material: { roughness: 0.2 },
    yOffset: 0.75,
  },
  cache: {
    geometry: () => new THREE.BoxGeometry(2.5, 1.5, 2.5),
    material: { roughness: 0.2 },
    yOffset: 0.75,
  },
  sqs: {
    geometry: () => new THREE.BoxGeometry(4, 0.8, 2),
    material: { roughness: 0.2 },
    yOffset: 0.4,
  },
  cdn: {
    geometry: () => new THREE.SphereGeometry(1.5, 16, 16),
    material: { roughness: 0.2, wireframe: true, colorOverride: 0x4ade80 },
    yOffset: 1.5,
  },
  apigw: {
    geometry: () => new THREE.OctahedronGeometry(1.5, 0),
    material: { roughness: 0.2 },
    yOffset: 1.5,
  },
  nosql: {
    geometry: () => new THREE.CylinderGeometry(2, 2, 1.5, 16),
    material: { roughness: 0.3 },
    yOffset: 1,
  },
  search: {
    geometry: () => new THREE.DodecahedronGeometry(1.5, 0),
    material: { roughness: 0.2 },
    yOffset: 1.5,
  },
  replica: {
    geometry: () => new THREE.CylinderGeometry(1.8, 1.8, 1, 6),
    material: { roughness: 0.3 },
    yOffset: 1,
  },
  serverless: {
    geometry: () => new THREE.TetrahedronGeometry(1.8, 0),
    material: { roughness: 0.2 },
    yOffset: 1.5,
  },
};

/**
 * TIER_RING_CONFIG — ring size and color per service type for tier upgrades.
 * Shared by Service.upgrade() and Service.restore(). Adding a new upgradeable
 * type only requires adding an entry here.
 */
const TIER_RING_CONFIG = {
  db:       { ringSize: 2.2, ringColor: 0xff0000 },
  cache:    { ringSize: 1.5, ringColor: 0xdc382d },
  apigw:    { ringSize: 1.5, ringColor: 0xe879f9 },
  nosql:    { ringSize: 2.0, ringColor: 0x7c3aed },
  search:   { ringSize: 1.5, ringColor: 0x06b6d4 },
  replica:  { ringSize: 1.8, ringColor: 0xf472b6 },
  // fallback (compute and any unknown upgradeable type)
  _default: { ringSize: 1.3, ringColor: 0xffff00 },
};

/**
 * createServiceMesh — build the THREE.Mesh for a given service type.
 * Resolves color from CONFIG.colors[type] unless the visual entry specifies colorOverride.
 */
function createServiceMesh(type, pos) {
  const visual = SERVICE_VISUALS[type] || SERVICE_VISUALS.compute;
  const geo = visual.geometry();

  const color = visual.material.colorOverride || (CONFIG.colors[type] || 0xffffff);
  const matProps = { ...visual.material };
  delete matProps.colorOverride;
  matProps.color = color;

  const mat = new THREE.MeshStandardMaterial(matProps);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  mesh.position.y += visual.yOffset;

  return { mesh, mat, yOffset: visual.yOffset };
}

/**
 * createTierRing — build a torus ring for the given service type at a specific tier level.
 * tierLevel is the tier number being added (2 or 3).
 */
function createTierRing(type, tierLevel, meshYPosition) {
  const cfg = TIER_RING_CONFIG[type] || TIER_RING_CONFIG._default;
  const ringGeo = new THREE.TorusGeometry(cfg.ringSize, 0.1, 8, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: cfg.ringColor });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -meshYPosition + (tierLevel === 2 ? 0.5 : 1.0);
  return ring;
}
