import * as THREE from 'three';
import { PARTICLE_BLOOM_LAYER } from './dissolve.js';

// ─── Particles for the dissolve ──────────────────────────────────────────────
// Where each particle starts (a random point on the model's surface) and which
// way it flies. Used by the table and every object; the particle shader itself
// is makeParticleMaterial in dissolve.js.

// Builds particle positions/velocities sampled from a mesh's geometry, in
// the mesh's own local space, so particles stay attached correctly as it floats.
export function buildParticlesFromGeometry(root, count, { radial = false, velocityCompensation = 1.0 } = {}) {
    root.updateWorldMatrix(true, true);
    const worldInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();

    // Collect every triangle with a running total of area, so particles can be
    // spread evenly over the surface. Sampling the vertices instead clustered
    // them wherever the mesh has few triangles (e.g. rings on a cylinder).
    const tris  = [];   // flat [ax,ay,az, bx,by,bz, cx,cy,cz] per triangle
    const cumul = [];   // cumulative area up to and including each triangle
    let totalArea = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();

    root.traverse((child) => {
        if (!child.isMesh || !child.geometry?.getAttribute('position')) return;
        const geom    = child.geometry;
        const posAttr = geom.getAttribute('position');
        const index   = geom.getIndex();
        const toLocal = new THREE.Matrix4().multiplyMatrices(worldInverse, child.matrixWorld);
        const triCount = (index ? index.count : posAttr.count) / 3;
        for (let t = 0; t < triCount; t++) {
            const i0 = index ? index.getX(t * 3)     : t * 3;
            const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
            const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
            a.fromBufferAttribute(posAttr, i0).applyMatrix4(toLocal);
            b.fromBufferAttribute(posAttr, i1).applyMatrix4(toLocal);
            c.fromBufferAttribute(posAttr, i2).applyMatrix4(toLocal);
            const area = e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() * 0.5;
            if (area <= 0) continue;
            totalArea += area;
            tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            cumul.push(totalArea);
        }
    });

    if (tris.length === 0) return null; // guard: geometry had no triangles

    const positions  = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
        // Area-weighted triangle pick (binary search the cumulative areas),
        // then a uniformly random barycentric point within that triangle.
        const target = Math.random() * totalArea;
        let lo = 0, hi = cumul.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cumul[mid] < target) lo = mid + 1; else hi = mid; }
        const o = lo * 9;
        let u = Math.random(), w = Math.random();
        if (u + w > 1) { u = 1 - u; w = 1 - w; } // reflect into the triangle
        const px = tris[o]     + u * (tris[o + 3] - tris[o])     + w * (tris[o + 6] - tris[o]);
        const py = tris[o + 1] + u * (tris[o + 4] - tris[o + 1]) + w * (tris[o + 7] - tris[o + 1]);
        const pz = tris[o + 2] + u * (tris[o + 5] - tris[o + 2]) + w * (tris[o + 8] - tris[o + 2]);
        positions[i * 3] = px; positions[i * 3 + 1] = py; positions[i * 3 + 2] = pz;

        if (radial) {
            // Table: particles burst outward from the centre and scatter.
            // (`|| 1` avoids dividing by zero at the exact centre.)
            const r = Math.sqrt(px * px + pz * pz) || 1;
            const spread = Math.random() * 4.0 + 2.5; // 2.5–6.5
            velocities[i * 3]     = (px / r) * spread;
            velocities[i * 3 + 1] = Math.random() * 3.0 + 0.5;
            velocities[i * 3 + 2] = (pz / r) * spread;
        } else {
            // Random spread angle instead of radial — avoids thin objects (tulip stem) clustering
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 1.5 + 0.5;
            velocities[i * 3]     = Math.cos(angle) * speed * velocityCompensation;
            velocities[i * 3 + 1] = (Math.random() * 2.5 + 0.5) * velocityCompensation;
            velocities[i * 3 + 2] = Math.sin(angle) * speed * velocityCompensation;
        }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aVelocity', new THREE.BufferAttribute(velocities, 3));
    return geom;
}

// Creates a particle Points object on the bloom layer. Always use this, or the
// glow pass won't see the particles.
export function makeParticlePoints(geometry, material) {
    const points = new THREE.Points(geometry, material);
    points.layers.set(PARTICLE_BLOOM_LAYER);
    return points;
}
