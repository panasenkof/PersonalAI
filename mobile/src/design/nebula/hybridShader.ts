/**
 * Art direction: B (rich glass/plasma from the original REF-ORB-B)
 *              + C (independent organic membrane/refraction dynamics).
 * This is a Skia R&D shader, NOT a production visual sign-off.
 *
 * Mandatory original: docs/design/references/PersAI_Nebula_Approved_References.zip
 * Do not swap this for a single radial-gradient circle.
 *
 * Deliberately DOES NOT use makeImageFromView (Expo SDK 57 / Skia 2.6.2 issue).
 */
export const NEBULA_HYBRID_SKSL = `
uniform shader source;
uniform float uTime;
uniform float uSize;
uniform float uEnergy;
uniform float uOffline;
// Semantic-state filament inputs come from phaseFilament.ts. The filament
// follows the same organic deformation as the sphere, NOT a circular border.
uniform float uLineR;
uniform float uLineG;
uniform float uLineB;
uniform float uLineIntensity;
uniform float uLinePulseHz;
uniform float uLineWave;
uniform float uLineAnimate;

// One fully editable native shader: image-backed optics + three independent
// plasma caustic membranes + glass rim + a gently morphed sphere silhouette.
half4 main(float2 xy) {
  float2 center = float2(uSize * .5, uSize * .5);
  float radiusScale = uSize * .335;
  float2 q = (xy - center) / radiusScale;
  float angle = atan(q.y, q.x);
  float t = uTime;
  float deformation = 1.0 +
    .023 * sin(3.0 * angle + t * .37 * uEnergy) +
    .014 * sin(5.0 * angle - t * .28 * uEnergy) +
    .007 * sin(8.0 * angle + t * .22 * uEnergy);
  float d = length(q) / deformation;
  float mask = 1.0 - smoothstep(.967, 1.012, d);

  // The original art remains the primary source of detail. Underlying texture
  // bends differently near the center than near the boundary.
  float twist = .15 * sin(t * .26 * uEnergy + d * 3.7) * (1.0 - min(d, 1.0));
  float2 rotated = float2(q.x * cos(twist) - q.y * sin(twist),
                          q.x * sin(twist) + q.y * cos(twist));
  float2 uv = center + rotated * radiusScale;
  uv += float2(sin(q.y * 8.0 + t * .32 * uEnergy) * uSize * .009,
               cos(q.x * 7.0 - t * .23 * uEnergy) * uSize * .009);
  uv = clamp(uv, float2(1.0), float2(uSize - 1.0));
  float3 base = float3(source.eval(uv).rgb);

  // Distinct moving translucent light membranes: their independent timing
  // avoids the flat texture rotation characteristic of low-end substitutes.
  float a = q.y + .32 * sin(q.x * 2.6 + t * .42 * uEnergy) -
                 .08 * cos(q.x * 5.1 - t * .21 * uEnergy);
  float b = q.y - .21 * sin(q.x * 3.4 - t * .31 * uEnergy + 1.9) + .17;
  float c = q.y + .25 * cos(q.x * 2.9 + t * .23 * uEnergy + 2.7) - .29;
  float membraneA = exp(-17.0 * a * a) * .22;
  float membraneB = exp(-22.0 * b * b) * .19;
  float membraneC = exp(-28.0 * c * c) * .17;
  float membraneD = exp(-26.0 * (a + .27) * (a + .27)) * .08;
  float membraneE = exp(-37.0 * (c - .20) * (c - .20)) * .06;

  float3 plasma = base;
  plasma += membraneA * float3(.45, .26, .95);
  plasma += membraneB * float3(.16, .76, 1.0);
  plasma += membraneC * float3(.68, .40, 1.0);
  plasma += membraneD * float3(.22, .60, .90);
  plasma += membraneE * float3(.81, .59, .95);

  // The energy center moves *inside* the sphere, not the whole image.
  float2 lightCenter = float2(.13 * sin(t * .34 * uEnergy),
                              .12 * cos(t * .21 * uEnergy));
  float lightRadius = length(q - lightCenter);
  float caustic = exp(-32.0 * lightRadius * lightRadius) * .28;
  plasma += caustic * float3(.68, 1.0, 1.0);

  // Lens-like rim: cold cyan one side, violet on the other, plus an
  // anisotropic specular crescent, all clipped by deformed silhouette.
  float rim = exp(-140.0 * (d - .925) * (d - .925));
  float cold = .42 + .58 * sin(angle * 1.6 + 1.2);
  plasma += rim * .27 * mix(float3(.58, .31, .95),
                            float3(.27, .95, 1.0), cold);
  float highlight = exp(-65.0 * pow(q.y + .63 - .15 * q.x, 2.0)) *
                    smoothstep(-.55, -.15, q.y) *
                    (1.0 - smoothstep(.22, .82, q.x));
  plasma += highlight * float3(.35, .39, .50);
  plasma = min(plasma, float3(1.0));

  // Dark layered nebula, halo + sparse stable twinkling stars outside orb.
  float radial = length((xy - center) / uSize);
  float halo = exp(-11.0 * pow(max(0.0, d - .98), 2.0)) *
               (1.0 - mask) * .13;
  float3 bg = mix(float3(.021, .026, .074), float3(.030, .079, .157),
                  clamp(xy.y / uSize, 0.0, 1.0));
  bg += halo * float3(.33, .23, .78);
  float2 cell = floor(xy / (uSize * .082));
  float seed = fract(sin(dot(cell, float2(127.1, 311.7))) * 43758.5453);
  float2 starLocal = fract(xy / (uSize * .082));
  float2 starSpot = float2(fract(seed * 83.37), fract(seed * 19.73));
  float star = (1.0 - smoothstep(.013, .035, length(starLocal - starSpot))) *
               step(.90, seed) * (.27 + .08 * sin(t * .13 + seed * 9.0));
  bg += star * float3(.41, .66, 1.0);

  float3 outputColor = mix(bg, plasma, mask);
  outputColor = mix(outputColor, outputColor * .43, uOffline);

  // A fine electric filament hugging the EXACT organic silhouette d≈1.
  // Core and two increasingly diffuse halos never replace the B texture.
  // Widths are resolution-aware so a 44dp lab preview stays identifiable.
  // Unlike a circular RN view border, all filaments follow deformation(angle).
  if (uLineIntensity > .001) {
    float linePhase = uTime * 6.2831853 * uLinePulseHz * uLineAnimate;
    float contourWave = .0038 * uLineAnimate *
      sin(angle * uLineWave + linePhase) +
      .0017 * uLineAnimate * sin(angle * 8.0 - .61 * linePhase);
    float contourDistance = abs(d - (1.004 + contourWave));
    float coreWidth = max(.009, 1.0 / max(uSize * .335, 1.0));
    float core = exp(-2.0 * pow(contourDistance / coreWidth, 2.0));
    float haloNear = exp(-1.3 * pow(contourDistance / (coreWidth * 2.5), 2.0));
    float haloFar = exp(-1.2 * pow(contourDistance / (coreWidth * 4.6), 2.0));
    float pulse = mix(1.0, .86 + .14 *
      sin(linePhase + angle * (1.5 + uLineWave * .5)), uLineAnimate);
    // Unequal angular shimmer means it reads as a fine energy STRING,
    // not one featureless LED ring; no strobing/flash is generated.
    float localShimmer = mix(1.0, .9 + .1 *
      sin(angle * 5.0 - linePhase * .43), uLineAnimate);
    float brightness = uLineIntensity * pulse * localShimmer;
    float3 filamentColor = float3(uLineR, uLineG, uLineB);
    float filament = core * .87 + haloNear * .35 + haloFar * .115;
    outputColor += filamentColor * brightness * filament;
  }
  return half4(half3(clamp(outputColor, 0.0, 1.0)), 1.0);
}
`;

/** Symbolic semantic phase weights; audio volume must come from real recorder. */
export const NEBULA_ENERGY = {
  idle: 1,
  listening: 1.32,
  transcribing: 1.17,
  thinking: 1.55,
  responding: 1.21,
  offline: 0,
  error: 0,
} as const;

export function isSupportedSkiaPhase(value: string): value is keyof typeof NEBULA_ENERGY {
  return Object.prototype.hasOwnProperty.call(NEBULA_ENERGY, value);
}
