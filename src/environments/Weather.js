import * as THREE from 'three';

/**
 * Ultra-light GPU weather. All particle motion happens in the vertex shader
 * from a single time uniform, so there is ZERO per-frame JS work and no buffer
 * uploads (the old system rewrote thousands of positions on the CPU every
 * frame and drew them as large alpha-blended sprites = heavy overdraw).
 *
 *  - rain : thin line streaks (1 draw call, ~900 streaks), world-anchored and
 *           wrapped around the camera so it never pops or drifts away.
 *  - snow / dust : tiny soft points with sway.
 */
const VERT_COMMON = /* glsl */`
    attribute vec3 aSeed;
    uniform float uTime, uSpeed, uHeight, uArea, uOpacity, uMaxDist;
    uniform vec3 uCam;
    uniform vec2 uWind;
    varying float vAlpha;

    vec3 anchor(out float fall) {
        float spd = 0.85 + 0.3 * fract(aSeed.z * 7.13);
        fall = fract(aSeed.y - uTime * uSpeed * spd / uHeight);
        vec3 p;
        p.y = uCam.y + (fall - 0.35) * uHeight;
        // Wrap horizontally around the camera (torus) -> stable world positions
        p.xz = uCam.xz + (fract(aSeed.xz - uCam.xz / uArea) - 0.5) * uArea;
        return p;
    }
`;

const RAIN_VERT = VERT_COMMON + /* glsl */`
    attribute float aEnd;
    uniform float uStreak;
    void main() {
        float fall;
        vec3 p = anchor(fall);
        p.xz += uWind * (1.0 - fall) * uHeight * 0.04;
        vec3 vel = normalize(vec3(uWind.x, -uSpeed, uWind.y));
        p -= vel * uStreak * aEnd;                  // tail trails behind the head
        float d = length(p - uCam);
        vAlpha = uOpacity * mix(1.0, 0.0, aEnd) * (1.0 - smoothstep(uMaxDist * 0.6, uMaxDist, d))
               * smoothstep(0.0, 0.8, d);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }
`;

const POINT_VERT = VERT_COMMON + /* glsl */`
    uniform float uSize, uSway, uScale;
    void main() {
        float fall;
        vec3 p = anchor(fall);
        float ph = aSeed.z * 40.0;
        p.x += sin(uTime * 0.6 + ph) * uSway + uWind.x * (uTime * 0.5);
        p.z += cos(uTime * 0.5 + ph * 1.3) * uSway;
        p.xz = uCam.xz + mod(p.xz - uCam.xz + uArea * 0.5, uArea) - uArea * 0.5;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float d = -mv.z;
        vAlpha = uOpacity * (1.0 - smoothstep(uMaxDist * 0.6, uMaxDist, length(p - uCam))) * smoothstep(0.2, 1.5, d);
        gl_PointSize = clamp(uSize * uScale / max(d, 0.5), 1.0, 14.0);
        gl_Position = projectionMatrix * mv;
    }
`;

const FRAG_LINE = /* glsl */`
    uniform vec3 uColor;
    varying float vAlpha;
    void main() { if (vAlpha < 0.002) discard; gl_FragColor = vec4(uColor, vAlpha); }
`;
const FRAG_POINT = /* glsl */`
    uniform vec3 uColor;
    varying float vAlpha;
    void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = 1.0 - smoothstep(0.1, 0.5, length(c));
        if (a * vAlpha < 0.002) discard;
        gl_FragColor = vec4(uColor, a * vAlpha);
    }
`;

export class Weather {
    /** cfg: { kind:'rain'|'snow'|'dust', count, speed, color, size, opacity, drift } */
    constructor(cfg) {
        this.kind = cfg.kind;
        const isRain = cfg.kind === 'rain';
        const area = cfg.area ?? (isRain ? 44 : 60);
        const height = cfg.height ?? (isRain ? 26 : 22);
        const count = cfg.count;

        const seeds = new Float32Array(count * (isRain ? 6 : 3));
        const ends = isRain ? new Float32Array(count * 2) : null;
        for (let i = 0; i < count; i++) {
            const sx = Math.random(), sy = Math.random(), sz = Math.random();
            if (isRain) {
                for (let v = 0; v < 2; v++) {
                    const o = (i * 2 + v) * 3;
                    seeds[o] = sx; seeds[o + 1] = sy; seeds[o + 2] = sz;
                    ends[i * 2 + v] = v;
                }
            } else {
                seeds[i * 3] = sx; seeds[i * 3 + 1] = sy; seeds[i * 3 + 2] = sz;
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
        if (isRain) geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
        // dummy position attribute (three needs one to know the vertex count)
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * (isRain ? 6 : 3)), 3));

        const wind = cfg.wind || (isRain ? [1.2, 0.4] : [cfg.drift ? cfg.drift * 0.15 : 0, 0.2]);
        this.uniforms = {
            uTime: { value: 0 },
            uSpeed: { value: cfg.speed },
            uHeight: { value: height },
            uArea: { value: area },
            uMaxDist: { value: cfg.range ?? area * 0.5 },
            uOpacity: { value: cfg.opacity },
            uCam: { value: new THREE.Vector3() },
            uWind: { value: new THREE.Vector2(wind[0], wind[1]) },
            uColor: { value: new THREE.Color(cfg.color) },
            uStreak: { value: cfg.streak ?? 0.85 },
            uSize: { value: cfg.size ?? 0.15 },
            uSway: { value: cfg.kind === 'snow' ? 0.9 : 0.6 },
            uScale: { value: 520 }
        };
        const mat = new THREE.ShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: isRain ? RAIN_VERT : POINT_VERT,
            fragmentShader: isRain ? FRAG_LINE : FRAG_POINT,
            transparent: true,
            depthWrite: false,
            fog: false
        });
        this.object = isRain ? new THREE.LineSegments(geo, mat) : new THREE.Points(geo, mat);
        this.object.frustumCulled = false;
        this.object.renderOrder = 10;
    }

    update(dt, camPos) {
        this.uniforms.uTime.value += dt;
        if (camPos) this.uniforms.uCam.value.copy(camPos);
    }

    dispose() {
        this.object.geometry.dispose();
        this.object.material.dispose();
    }
}
