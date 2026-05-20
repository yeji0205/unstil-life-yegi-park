# unstil life — architecture

## concept

A scene transition driven by mouse scroll: an empty room with warm lighting gradually dissolves into cosmos/universe space using an ink bleed effect.

## scenes

### room
- empty room geometry
- warm lighting (point lights / spot lights)

### cosmos
- universe skybox (6-face cube textures, adapted from [first-universe](https://github.com/yeji0205/first-universe-src))
- particle system for stars (`BufferGeometry` + `Points`, additive blending, ~2000–5000 stars)


## transition

**trigger:** mouse scroll (maps `deltaY` to a `progress` value 0.0 → 1.0)

**technique:** ink bleed shader applied directly to the room's `ShaderMaterial`

- single scene: universe skybox always present in the background
- room is a `BoxGeometry` with a custom `ShaderMaterial` (`transparent: true`)
- scroll increases `progress` → noise threshold sweeps across room walls → alpha drops → skybox revealed
- no `WebGLRenderTarget` or `EffectComposer` needed

```glsl
float noise = fbm(vUv * 4.0);
float alpha = 1.0 - smoothstep(progress - 0.15, progress + 0.15, noise);
gl_FragColor = vec4(roomColor, alpha);
```

## tech stack

- **Vite** — local dev server + bundler (`npm run dev`)
- **Three.js** — 3D rendering
- **GLSL / ShaderMaterial** — custom ink bleed shader on room geometry
- **FBM / Simplex noise** — organic ink spread shape

## open questions / todo

- [ ] decide room geometry (walls only, furniture, abstract?)
- [ ] decide cosmos style (realistic stars, abstract nebula, stylized?)
- [ ] ink bleed color — black ink, white, or match scene colors?
- [ ] scroll behavior — snap back, one-way only, or freely reversible?
