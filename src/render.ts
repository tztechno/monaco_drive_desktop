// Draws the MuJoCo scene with three.js, plus the visual-only parts of Monaco
// (distant terrain with satellite imagery, sea, buildings, trees, road surface, tunnel).
// Everything stays in MuJoCo's Z-up world frame; cameras use up = +Z.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';
import type { MonacoData } from './monaco.ts';

// MuJoCo does no color management: rgba values go straight to the framebuffer.
THREE.ColorManagement.enabled = false;

const GEOM_HFIELD = 1;
const GEOM_SPHERE = 2;
const GEOM_CAPSULE = 3;
const GEOM_CYLINDER = 5;
const GEOM_BOX = 6;

const HEADLIGHT_AMBIENT = 0.12;
const HEADLIGHT_DIFFUSE = 0.25;
const FREE_CAMERA_FOVY = 45;
// three.js lights are physically based (Lambert BRDF = albedo / π); MuJoCo shades with rgba × light directly.
const LIGHT_SCALE = Math.PI;
const SHININESS = 64;
const SPECULAR = (0.5 * 0.3) / ((SHININESS / 2 + 1) * LIGHT_SCALE);

const SKY = 0xa9cff0;
const WATER_Z = 0.3;

export interface MonacoTextures {
  ground: THREE.Texture; // near terrain (public/monaco/ground.jpg)
  satellite: THREE.Texture; // Sentinel-2 mosaic (public/monaco/s2.jpg)
}

export class SceneView {
  readonly scene = new THREE.Scene();
  private meshes: (THREE.Object3D | undefined)[] = [];
  private model: MjModel;
  private data: MjData;
  private headlight = new THREE.DirectionalLight(0xffffff, HEADLIGHT_DIFFUSE * LIGHT_SCALE);
  private tmpMat = new THREE.Matrix4();

  constructor(mj: MainModule, model: MjModel, data: MjData, monaco: MonacoData, tex: MonacoTextures) {
    this.model = model;
    this.data = data;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 900, 9000);
    this.scene.add(new THREE.AmbientLight(0xffffff, HEADLIGHT_AMBIENT * LIGHT_SCALE));
    this.scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x6a6050, 0.25 * LIGHT_SCALE));
    this.scene.add(this.headlight, this.headlight.target);
    this.addModelLights();

    // Static world geoms (barriers) are merged per colour; moving geoms (the car) get their own mesh.
    const staticParts = new Map<string, THREE.BufferGeometry[]>();
    const size = model.geom_size;
    const rgba = model.geom_rgba;
    const type = model.geom_type;
    const bodyOf = model.geom_bodyid;
    for (let i = 0; i < model.ngeom; i++) {
      const a = rgba[4 * i + 3];
      if (a === 0) continue; // invisible (walls, wheel contact spheres)
      const s = [size[3 * i], size[3 * i + 1], size[3 * i + 2]];
      let geo: THREE.BufferGeometry;
      switch (type[i]) {
        case GEOM_HFIELD:
          this.scene.add(nearTerrainMesh(monaco, tex.ground));
          continue;
        case GEOM_BOX:
          geo = new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
          break;
        case GEOM_CYLINDER:
          // three.js cylinders run along Y; MuJoCo cylinders run along local Z.
          geo = new THREE.CylinderGeometry(s[0], s[0], 2 * s[1], 32).rotateX(Math.PI / 2);
          break;
        case GEOM_CAPSULE:
          geo = new THREE.CapsuleGeometry(s[0], 2 * s[1], 6, 12).rotateX(Math.PI / 2);
          break;
        case GEOM_SPHERE:
          geo = new THREE.SphereGeometry(s[0], 24, 16);
          break;
        default:
          console.warn(`Unsupported geom type ${type[i]} (${mj.mj_id2name(model, mj.mjtObj.mjOBJ_GEOM.value, i)})`);
          continue;
      }
      const color = new THREE.Color(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
      if (bodyOf[i] === 0) {
        geo.applyMatrix4(this.geomMatrix(i, new THREE.Matrix4()));
        const key = color.getHexString();
        (staticParts.get(key) ?? staticParts.set(key, []).get(key)!).push(geo);
        continue;
      }
      const mesh = new THREE.Mesh(geo, phong(color, a));
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.meshes[i] = mesh;
    }
    for (const [hex, parts] of staticParts) {
      this.scene.add(new THREE.Mesh(mergeGeometries(parts), phong(new THREE.Color(`#${hex}`), 1)));
    }

    this.scene.add(farTerrainMesh(monaco, tex.satellite));
    this.scene.add(waterMesh());
    this.scene.add(roadMeshes(monaco));
    this.scene.add(tunnelMeshes(monaco));
    this.scene.add(buildingMeshes(monaco));
    this.scene.add(treeMeshes(monaco));
    this.sync();
  }

  private addModelLights() {
    const m = this.model;
    for (let i = 0; i < m.nlight; i++) {
      const d = m.light_diffuse;
      const dir = m.light_dir;
      const light = new THREE.DirectionalLight(new THREE.Color(d[3 * i], d[3 * i + 1], d[3 * i + 2]), LIGHT_SCALE);
      light.position.set(-dir[3 * i], -dir[3 * i + 1], -dir[3 * i + 2]);
      this.scene.add(light, light.target);
    }
  }

  private geomMatrix(i: number, out: THREE.Matrix4) {
    const xpos = this.data.geom_xpos;
    const xmat = this.data.geom_xmat;
    const r = 9 * i, p = 3 * i;
    return out.set(
      xmat[r], xmat[r + 1], xmat[r + 2], xpos[p],
      xmat[r + 3], xmat[r + 4], xmat[r + 5], xpos[p + 1],
      xmat[r + 6], xmat[r + 7], xmat[r + 8], xpos[p + 2],
      0, 0, 0, 1,
    );
  }

  /** Copy moving geom poses from MjData into the three.js meshes. */
  sync() {
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      if (mesh) this.geomMatrix(i, mesh.matrix);
    }
  }

  /** MuJoCo's headlight follows whichever camera is rendering. */
  aimHeadlight(cam: THREE.Camera) {
    cam.getWorldDirection(this.headlight.position).negate().add(cam.position);
    this.headlight.target.position.copy(cam.position);
    this.headlight.target.updateMatrixWorld();
  }

  /** Place a three.js camera at a MuJoCo model camera (cam_xpos / cam_xmat). */
  setFromModelCamera(cam: THREE.PerspectiveCamera, camId: number) {
    const p = this.data.cam_xpos;
    const r = this.data.cam_xmat;
    const i = 9 * camId;
    const j = 3 * camId;
    // MuJoCo cameras look along -Z with +Y up, same as three.js.
    this.tmpMat.set(
      r[i], r[i + 1], r[i + 2], p[j],
      r[i + 3], r[i + 4], r[i + 5], p[j + 1],
      r[i + 6], r[i + 7], r[i + 8], p[j + 2],
      0, 0, 0, 1,
    );
    this.tmpMat.decompose(cam.position, cam.quaternion, cam.scale);
    cam.up.set(0, 0, 1);
    cam.fov = this.model.cam_fovy[camId];
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}

/** Equivalent of an mjCAMERA_FREE camera (lookat / distance / azimuth / elevation in degrees). */
export function setFreeCamera(
  cam: THREE.PerspectiveCamera, lookat: THREE.Vector3, distance: number,
  azimuthDeg: number, elevationDeg: number,
) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const fwd = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
  cam.position.copy(lookat).addScaledVector(fwd, -distance);
  cam.up.set(0, 0, 1);
  cam.lookAt(lookat);
  cam.fov = FREE_CAMERA_FOVY;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
}

// ── Materials and procedural textures ───────────────────────

function phong(color: THREE.Color, opacity = 1, extra: THREE.MeshPhongMaterialParameters = {}) {
  return new THREE.MeshPhongMaterial({
    color,
    specular: new THREE.Color(SPECULAR, SPECULAR, SPECULAR),
    shininess: SHININESS,
    transparent: opacity < 1,
    opacity,
    ...extra,
  });
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, amp: number) {
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * amp;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

// ── Terrain ─────────────────────────────────────────────────

function nearTerrainMesh(monaco: MonacoData, texture: THREE.Texture) {
  const { e0, n0, cell, nx, ny } = monaco.world.near;
  const pos = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = j * nx + i;
      pos[3 * v] = e0 + i * cell;
      pos[3 * v + 1] = n0 + j * cell;
      pos[3 * v + 2] = monaco.near[v];
      uv[2 * v] = i / (nx - 1);
      uv[2 * v + 1] = j / (ny - 1);
    }
  }
  const geo = gridGeometry(nx, ny, pos, uv);
  texture.anisotropy = 8;
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: texture }));
}

function farTerrainMesh(monaco: MonacoData, texture: THREE.Texture) {
  const f = monaco.world.far;
  const s2 = monaco.world.s2;
  const near = monaco.world.near;
  const nearE1 = near.e0 + (near.nx - 1) * near.cell, nearN1 = near.n0 + (near.ny - 1) * near.cell;
  const Z = 2 ** s2.zoom;
  const pos = new Float32Array(f.nx * f.ny * 3);
  const uv = new Float32Array(f.nx * f.ny * 2);
  // Build with row 0 = south so the grid winding matches the near terrain.
  for (let j = 0; j < f.ny; j++) {
    const r = f.ny - 1 - j;
    const lat = f.lat0 + (r + 0.5) * f.dlat;
    const n = f.n1 - ((r + 0.5) / f.ny) * (f.n1 - f.n0);
    const ty = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * Z;
    for (let c = 0; c < f.nx; c++) {
      const lon = f.lon0 + (c + 0.5) * f.dlon;
      const e = f.e0 + ((c + 0.5) / f.nx) * (f.e1 - f.e0);
      const v = j * f.nx + c;
      let h = monaco.far[r * f.nx + c];
      // Tuck under the detailed terrain where the two overlap.
      if (e > near.e0 + 30 && e < nearE1 - 30 && n > near.n0 + 30 && n < nearN1 - 30) h -= 12;
      pos[3 * v] = e;
      pos[3 * v + 1] = n;
      pos[3 * v + 2] = h;
      uv[2 * v] = (((lon + 180) / 360) * Z - s2.tx0) * 256 / s2.width;
      uv[2 * v + 1] = 1 - ((ty - s2.ty0) * 256) / s2.height;
    }
  }
  const geo = gridGeometry(f.nx, f.ny, pos, uv);
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: texture }));
}

function gridGeometry(nx: number, ny: number, pos: Float32Array, uv: Float32Array) {
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let o = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = d;
      idx[o++] = a; idx[o++] = d; idx[o++] = c;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  return geo;
}

function waterMesh() {
  const geo = new THREE.PlaneGeometry(80000, 80000);
  const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
    color: 0x1f4f78, specular: 0x5a7a90, shininess: 90,
  }));
  mesh.position.z = WATER_Z;
  return mesh;
}

// ── Road surface: asphalt ribbon, kerbs in corners, start line ─

function ribbon(
  monaco: MonacoData, from: number, to: number, inner: number, outer: number, dz: number, vScale: number,
) {
  const t = monaco.track;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = from; i <= to; i++) {
    const k = t.wrap(i);
    const h = t.heading[k];
    const nx = -Math.sin(h), ny = Math.cos(h);
    for (const [off, u] of [[inner, 0], [outer, 1]]) {
      pos.push(t.x[k] + nx * off, t.y[k] + ny * off, t.z[k] + dz);
      uv.push(u, (i * t.step) / vScale);
    }
    if (i > from) {
      const b = 2 * (i - from);
      idx.push(b - 2, b + 1, b - 1, b - 2, b, b + 1); // counter-clockwise seen from above
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function roadMeshes(monaco: MonacoData) {
  const t = monaco.track;
  const hw = t.halfWidth;
  const group = new THREE.Group();
  const asphalt = canvasTexture(128, 256, (g) => {
    g.fillStyle = '#3b3c40';
    g.fillRect(0, 0, 128, 256);
    noise(g, 128, 256, 18);
    g.fillStyle = '#e8e8e8';
    g.fillRect(3, 0, 3, 256);
    g.fillRect(122, 0, 3, 256);
  });
  const roadMat = new THREE.MeshLambertMaterial({
    map: asphalt, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  group.add(new THREE.Mesh(ribbon(monaco, 0, t.n, -hw - 0.3, hw + 0.3, 0.05, 20), roadMat));

  // Kerbs on both sides wherever the track bends
  const kerbTex = canvasTexture(8, 64, (g) => {
    g.fillStyle = '#d42020'; g.fillRect(0, 0, 8, 32);
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 32, 8, 32);
  });
  const kerbMat = new THREE.MeshLambertMaterial({
    map: kerbTex, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const kerbGeos: THREE.BufferGeometry[] = [];
  let start = -1;
  for (let i = 0; i <= t.n; i++) {
    const bend = i < t.n && Math.abs(t.curvature[i]) > 0.018;
    if (bend && start < 0) start = i;
    if (!bend && start >= 0) {
      const a = start - 3, b = i + 3;
      kerbGeos.push(ribbon(monaco, a, b, hw - 0.2, hw + 0.9, 0.07, 2));
      kerbGeos.push(ribbon(monaco, a, b, -hw - 0.9, -hw + 0.2, 0.07, 2));
      start = -1;
    }
  }
  if (kerbGeos.length) group.add(new THREE.Mesh(mergeGeometries(kerbGeos), kerbMat));

  // Chequered start / finish line
  const checker = canvasTexture(80, 16, (g) => {
    for (let y = 0; y < 2; y++) for (let x = 0; x < 10; x++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
      g.fillRect(x * 8, y * 8, 8, 8);
    }
  });
  checker.wrapS = checker.wrapT = THREE.ClampToEdgeWrapping;
  // Plane x runs across the road (10 squares), y along it (2 squares).
  const line = new THREE.Mesh(new THREE.PlaneGeometry(2 * hw, 1.6), new THREE.MeshLambertMaterial({
    map: checker, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  line.position.set(t.x[0], t.y[0], t.z[0] + 0.09);
  line.rotation.z = t.heading[0] + Math.PI / 2;
  group.add(line);
  return group;
}

// ── Tunnel: walls, roof and ceiling lights over the tunnel samples ─

function tunnelMeshes(monaco: MonacoData) {
  const t = monaco.track;
  const group = new THREE.Group();
  const hw = t.halfWidth + 1.6;
  const H = 6.5;
  const geos: THREE.BufferGeometry[] = [];
  const lights: THREE.Vector3[] = [];
  let a = -1;
  for (let i = 0; i <= t.n; i++) {
    const inT = i < t.n && t.tunnel[i] === 1;
    if (inT && a < 0) a = i;
    if (!inT && a >= 0) {
      const b = i;
      const pos: number[] = [], idx: number[] = [];
      for (let s = a; s <= b; s++) {
        const k = t.wrap(s);
        const h = t.heading[k], nx = -Math.sin(h), ny = Math.cos(h);
        const x = t.x[k], y = t.y[k], z = t.z[k];
        // Cross-section: left floor, left top, right top, right floor (+ thick roof top)
        pos.push(
          x + nx * hw, y + ny * hw, z - 1,
          x + nx * hw, y + ny * hw, z + H,
          x - nx * hw, y - ny * hw, z + H,
          x - nx * hw, y - ny * hw, z - 1,
          x + nx * (hw + 2), y + ny * (hw + 2), z + H + 3,
          x - nx * (hw + 2), y - ny * (hw + 2), z + H + 3,
        );
        if (s > a) {
          const p = 6 * (s - a - 1), q = p + 6;
          for (const [u, v] of [[0, 1], [1, 2], [2, 3], [4, 5], [1, 4], [5, 2]]) {
            idx.push(p + u, q + u, q + v, p + u, q + v, p + v);
          }
        }
        if ((s - a) % 5 === 0) lights.push(new THREE.Vector3(x, y, z + H - 0.15));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      geos.push(g);
      a = -1;
    }
  }
  if (!geos.length) return group;
  group.add(new THREE.Mesh(mergeGeometries(geos), new THREE.MeshLambertMaterial({
    color: 0x6d6a66, side: THREE.DoubleSide,
  })));
  const lamp = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.2, 0.35, 0.1), new THREE.MeshBasicMaterial({ color: 0xffe2a0 }), lights.length,
  );
  const m = new THREE.Matrix4();
  lights.forEach((p, i) => lamp.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
  group.add(lamp);
  return group;
}

// ── Buildings: extruded footprints with a window texture ────

const FACADE_COLORS = [
  [0.93, 0.86, 0.7], // landmark (casino, hotels)
  [0.95, 0.93, 0.87],
  [0.92, 0.79, 0.62],
  [0.93, 0.76, 0.71],
  [0.86, 0.83, 0.79],
  [0.96, 0.87, 0.74],
];
const ROOF_COLORS = [[0.6, 0.44, 0.36], [0.55, 0.55, 0.55], [0.66, 0.5, 0.4]];

function buildingMeshes(monaco: MonacoData) {
  const wallPos: number[] = [], wallUv: number[] = [], wallCol: number[] = [];
  const roofPos: number[] = [], roofCol: number[] = [];
  const WIN_W = 4, WIN_H = 3.3;
  monaco.world.buildings.forEach((b, bi) => {
    const p = b.poly;
    const n = p.length / 2;
    const col = FACADE_COLORS[b.color];
    let u = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = p[2 * i], y0 = p[2 * i + 1], x1 = p[2 * j], y1 = p[2 * j + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const u1 = u + len / WIN_W, vTop = (b.z1 - b.z0) / WIN_H;
      wallPos.push(
        x0, y0, b.z0, x1, y1, b.z0, x1, y1, b.z1,
        x0, y0, b.z0, x1, y1, b.z1, x0, y0, b.z1,
      );
      wallUv.push(u, 0, u1, 0, u1, vTop, u, 0, u1, vTop, u, vTop);
      for (let k = 0; k < 6; k++) wallCol.push(...col);
      u = u1;
    }
    const contour = Array.from({ length: n }, (_, i) => new THREE.Vector2(p[2 * i], p[2 * i + 1]));
    const rc = ROOF_COLORS[bi % ROOF_COLORS.length];
    for (const [a, c, d] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      for (const v of [a, c, d]) {
        roofPos.push(contour[v].x, contour[v].y, b.z1);
        roofCol.push(...rc);
      }
    }
  });
  const facade = canvasTexture(64, 64, (g) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#5b6570'; g.fillRect(14, 16, 36, 30); // window
    g.fillStyle = '#8b96a0'; g.fillRect(14, 16, 36, 4); // lintel shade
    g.fillStyle = '#d8d2c8'; g.fillRect(8, 46, 48, 4); // balcony
  });
  const walls = new THREE.BufferGeometry();
  walls.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
  walls.setAttribute('uv', new THREE.Float32BufferAttribute(wallUv, 2));
  walls.setAttribute('color', new THREE.Float32BufferAttribute(wallCol, 3));
  walls.computeVertexNormals();
  const roofs = new THREE.BufferGeometry();
  roofs.setAttribute('position', new THREE.Float32BufferAttribute(roofPos, 3));
  roofs.setAttribute('color', new THREE.Float32BufferAttribute(roofCol, 3));
  roofs.computeVertexNormals();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(walls, new THREE.MeshLambertMaterial({
    map: facade, vertexColors: true, side: THREE.DoubleSide,
  })));
  group.add(new THREE.Mesh(roofs, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  return group;
}

// ── Trees in parks ──────────────────────────────────────────

function treeMeshes(monaco: MonacoData) {
  const tr = monaco.world.trees;
  const count = tr.length / 4;
  const group = new THREE.Group();
  const crown = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(2.6, 1), new THREE.MeshLambertMaterial({ color: 0x3f6b35 }), count,
  );
  const trunk = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.25, 0.35, 4, 6).rotateX(Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x5a4632 }), count,
  );
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const [x, y, z, s] = tr.slice(4 * i, 4 * i + 4);
    trunk.setMatrixAt(i, m.compose(p.set(x, y, z + 2 * s), q.identity(), sc.set(s, s, s)));
    crown.setMatrixAt(i, m.compose(p.set(x, y, z + 5 * s), q.identity(), sc.set(s, s, s * 0.85)));
    crown.setColorAt(i, tint.setHSL(0.27 + (i % 7) * 0.01, 0.35, 0.28 + (i % 5) * 0.02));
  }
  group.add(crown, trunk);
  return group;
}
