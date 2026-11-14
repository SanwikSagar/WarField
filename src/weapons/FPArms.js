import * as THREE from '/node_modules/three/build/three.module.js';
import { createFPArmsModel } from '../core/CharacterFactory.js';

/**
 * First-person arms driven by analytic two-bone IK.
 *
 * The rigged soldier body is attached to the camera with its head/legs
 * collapsed (bone scale ~0) so only sleeves, gloves and hands are seen. Each
 * frame the WeaponManager gives a world-space target per hand:
 *    { pos, fingerDir, palmNormal, curl, trigger }
 * Wrist position is solved with law-of-cosines IK + an elbow pole vector, the
 * hand is oriented by mapping its bind-pose (finger-direction, palm-normal)
 * basis onto the requested one, and fingers curl about each joint's own
 * palm-side axis - no per-skeleton magic numbers.
 */
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

export class FPArms {
    static create(camera) {
        const m = createFPArmsModel();
        return m ? new FPArms(camera, m) : null;
    }

    constructor(camera, m) {
        this.camera = camera;
        this.root = m.root;
        this.b = m.bones;
        // collapse everything the player should not see
        for (const n of ['Head', 'HeadTop_End', 'LeftUpLeg', 'RightUpLeg']) if (this.b[n]) this.b[n].scale.setScalar(1e-4);
        // Only ONE visible body: every vertex mostly skinned to the torso, neck,
        // shoulders (clavicles) or legs is discarded, so just sleeves + hands remain.
        this._maskBody(m.model);

        // bind-pose measurements in root space
        this.root.updateMatrixWorld(true);
        const pos = (n) => this.b[n] ? this.b[n].getWorldPosition(new THREE.Vector3()) : null;
        this.side = {};
        for (const s of ['Left', 'Right']) {
            const S = pos(s + 'Arm'), E = pos(s + 'ForeArm'), W = pos(s + 'Hand');
            const M1 = pos(s + 'HandMiddle1') || W.clone().add(new THREE.Vector3(s === 'Left' ? 0.08 : -0.08, 0, 0));
            const fingers = {};
            for (const f of FINGERS) {
                fingers[f] = [1, 2, 3].map(i => this.b[`${s}Hand${f}${i}`]).filter(Boolean).map(bone => {
                    const wq = bone.getWorldQuaternion(new THREE.Quaternion());
                    return { bone, bindQ: bone.quaternion.clone(), wqInv: wq.invert() };
                });
            }
            this.side[s] = {
                arm: this.b[s + 'Arm'], fore: this.b[s + 'ForeArm'], hand: this.b[s + 'Hand'],
                a: S.distanceTo(E), c: E.distanceTo(W),
                fBind: M1.clone().sub(W).normalize(),
                nBind: new THREE.Vector3(0, -1, 0),                       // Mixamo T-pose: palms face down
                handBindQ: this.b[s + 'Hand'].getWorldQuaternion(new THREE.Quaternion()),
                fingers
            };
        }
        // Viewmodel cheat: slightly longer arms with shoulders pulled under the eye so
        // the support hand reaches the handguard instead of hanging at full stretch.
        const S = 1.14;
        this.scale = S;
        for (const s of ['Left', 'Right']) { this.side[s].a *= S; this.side[s].c *= S; }
        const mid = pos('LeftArm').add(pos('RightArm')).multiplyScalar(0.5 * S);
        this.root.scale.setScalar(S);
        this.root.rotation.y = Math.PI;                                    // face camera forward (-Z)
        mid.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        this.root.position.set(-mid.x, -0.27 - mid.y, -0.07 - mid.z);
        camera.add(this.root);
        this.visible = true;
    }

    setVisible(v) { this.root.visible = v; this.visible = v; }

    shoulderWorld(s, out = new THREE.Vector3()) { return this.side[s].arm.getWorldPosition(out); }
    reach(s) { return this.side[s].a + this.side[s].c; }

    _maskBody(model) {
        const keep = /(Left|Right)(Arm|ForeArm|Hand)/;
        model.traverse(o => {
            if (!o.isSkinnedMesh) return;
            const bones = o.skeleton.bones;
            const mask = bones.map(b => {
                const n = b.name.replace(/^.*?(?=(Hips|Spine|Neck|Head|Left|Right))/, '');
                return keep.test(n) ? 0 : 1;
            });
            while (mask.length < 80) mask.push(1);
            const mat = o.material.clone();
            mat.onBeforeCompile = (shader) => {
                shader.uniforms.uHide = { value: mask };
                shader.vertexShader = 'uniform float uHide[80]; varying float vHide;\n' + shader.vertexShader.replace('#include <skinning_vertex>', `#include <skinning_vertex>
                    vHide = skinWeight.x * uHide[int(skinIndex.x)] + skinWeight.y * uHide[int(skinIndex.y)]
                          + skinWeight.z * uHide[int(skinIndex.z)] + skinWeight.w * uHide[int(skinIndex.w)];`);
                shader.fragmentShader = 'varying float vHide;\n' + shader.fragmentShader.replace('void main() {', 'void main() {\n if (vHide > 0.45) discard;');
            };
            mat.customProgramCacheKey = () => 'fpBodyMask';
            o.material = mat;
        });
    }

    /** targets in WORLD space; pole hints which way each elbow should point. */
    solve(right, left) {
        this.root.updateWorldMatrix(true, true);
        const camQ = this.camera.getWorldQuaternion(_q2);
        const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
        if (right) this._arm('Right', right, new THREE.Vector3(0.7, -1.4, 0.2).applyQuaternion(camQ), rootQ);
        if (left) this._arm('Left', left, new THREE.Vector3(-0.45, -1.6, 0.1).applyQuaternion(camQ), rootQ);
    }

    _arm(s, t, pole, rootQ) {
        const d = this.side[s];
        const S = d.arm.getWorldPosition(new THREE.Vector3());
        // wrist target: hold point minus the palm centre offset
        const f = t.fingerDir.clone().normalize(), n = t.palmNormal.clone().normalize();
        const T = t.pos.clone().addScaledVector(f, -0.075 * this.scale).addScaledVector(n, -0.03 * this.scale);
        const toT = T.clone().sub(S);
        let dist = toT.length();
        const a = d.a, c = d.c;
        dist = THREE.MathUtils.clamp(dist, Math.abs(a - c) + 1e-3, a + c - 1e-3);
        const dir = toT.normalize();
        const cosA = (a * a + dist * dist - c * c) / (2 * a * dist);
        const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
        const perp = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
        const Edes = S.clone().addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
        const Tdes = S.clone().addScaledVector(dir, dist);

        // upper arm: swing so the elbow lands on Edes
        this._aim(d.arm, S, d.fore.getWorldPosition(_v1), Edes);
        // forearm: swing so the wrist lands on Tdes
        const E = d.fore.getWorldPosition(new THREE.Vector3());
        this._aim(d.fore, E, d.hand.getWorldPosition(_v1), Tdes);

        // hand orientation: bind basis (f,n) -> requested basis
        const fb = d.fBind.clone().applyQuaternion(rootQ), nb = d.nBind.clone().applyQuaternion(rootQ);
        const R = basisRot(fb, nb, f, n);
        const handBindWorld = rootQ.clone().multiply(d.handBindQ);
        const want = R.multiply(handBindWorld);
        setWorldQuat(d.hand, want);

        // fingers: curl around each joint's palm-side axis
        const curl = t.curl ?? 1;
        for (const name of FINGERS) {
            const joints = d.fingers[name];
            let amt = curl * (name === 'Thumb' ? 0.45 : 1.05);
            if (name === 'Index' && t.trigger !== undefined) amt = 0.28 + 0.4 * t.trigger;
            else if (name !== 'Thumb') amt *= 1 + (FINGERS.indexOf(name) - 2) * 0.06;   // pinky wraps tighter than index
            const axisBind = d.fBind.clone().cross(d.nBind).normalize();    // in root space
            for (let i = 0; i < joints.length; i++) {
                const j = joints[i];
                // axis in this bone's bind-local frame (root space -> bone local)
                const ax = axisBind.clone().applyQuaternion(j.wqInv.clone().premultiply(new THREE.Quaternion())).normalize();
                const ang = amt * (i === 0 ? 0.9 : i === 1 ? 1.1 : 0.8) * (name === 'Thumb' ? 0.6 : 1);
                j.bone.quaternion.copy(j.bindQ).multiply(_q.setFromAxisAngle(ax, ang));
            }
        }
        d.hand.updateMatrixWorld(true);
    }

    /** rotate `bone` (world) so that its child at `childPos` moves to `target`. */
    _aim(bone, from, childPos, target) {
        const v1 = _v2.copy(childPos).sub(from).normalize();
        const v2 = _v3.copy(target).sub(from).normalize();
        _q.setFromUnitVectors(v1, v2);
        const wq = bone.getWorldQuaternion(new THREE.Quaternion());
        setWorldQuat(bone, _q.clone().multiply(wq));
        bone.updateMatrixWorld(true);
    }
}

function setWorldQuat(bone, wq) {
    const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.copy(pq.invert().multiply(wq));
}

/** rotation taking orthonormalised basis (f1,n1) onto (f2,n2) */
function basisRot(f1, n1, f2, n2) {
    const b1 = ortho(f1, n1), b2 = ortho(f2, n2);
    _m.makeBasis(b2[0], b2[1], b2[2]).multiply(new THREE.Matrix4().makeBasis(b1[0], b1[1], b1[2]).transpose());
    return new THREE.Quaternion().setFromRotationMatrix(_m);
}
function ortho(f, n) {
    const F = f.clone().normalize();
    const N = n.clone().addScaledVector(F, -n.dot(F)).normalize();
    return [F, N, F.clone().cross(N)];
}
