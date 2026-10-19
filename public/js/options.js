// Options merged into .minecraft/options.txt before each launch.
// Keys differ between game versions; every client ignores keys it does not know and
// parses options line by line, so era-specific values are chosen per version.

const ERA_1_6 = Date.parse('2013-06-25T00:00:00Z'); // 1.6: ambient occlusion became a level, not a flag
// 22w11a (1.19): options.txt values became JSON (quoted strings, boolean ambient occlusion).
const ERA_JSON_VALUES = Date.parse('2022-03-16T00:00:00Z');
// 26.1-snapshot-1: graphics presets, the OpenGL/Vulkan choice and new quality settings.
const ERA_26 = Date.parse('2025-12-16T00:00:00Z');

const VALUES = {
  smooth: { chunks: 4, legacyDistance: 3, fancy: false, ao: 0, particles: 2, clouds: false, maxFps: 60, mipmap: 0, shadows: false, biomeBlend: 0, entityDistance: 0.5 },
  balanced: { chunks: 6, legacyDistance: 2, fancy: false, ao: 1, particles: 1, clouds: false, maxFps: 60, mipmap: 0, shadows: true, biomeBlend: 1, entityDistance: 0.75 },
  quality: { chunks: 8, legacyDistance: 1, fancy: true, ao: 2, particles: 0, clouds: true, maxFps: 120, mipmap: 2, shadows: true, biomeBlend: 2, entityDistance: 1 },
};

// Always applied: settings the browser runtime needs regardless of the chosen preset.
const REQUIRED = {
  // The WebGL-backed GL driver (gl4es) can't create framebuffer objects, so 1.8+ must
  // render straight to the screen.
  fboEnable: false,
  // There is no audio backend (OpenAL) in the browser; with the volume at zero the game
  // skips sound lookups instead of logging a warning for every sound it would play.
  soundCategory_master: 0,
  sound: 0,
  music: 0,
  // No network access: avoid background requests that can only fail.
  snooperEnabled: false,
  realmsNotifications: false,
  useNativeTransport: false,
  fullscreen: false,
  // Window focus is emulated in the browser; the pause menu still opens with Esc.
  pauseOnLostFocus: false,
};

// Always applied to 1.13+ (LWJGL 3) clients, which render through WebGL 2 instead of gl4es.
const REQUIRED_LWJGL3 = {
  soundCategory_master: 0,
  realmsNotifications: false,
  useNativeTransport: false,
  fullscreen: false,
  pauseOnLostFocus: false,
  snooperEnabled: false,
  telemetryOptInExtra: false,
  // No speech synthesis library in the browser.
  narrator: 0,
  // OpenGL debug output does not exist on WebGL.
  glDebugVerbosity: 0,
  // Saves go through the browser's storage; don't stall the game on every chunk write.
  syncChunkWrites: false,
  // First-launch screens for the narrator and for online play.
  onboardAccessibility: false,
  skipMultiplayerWarning: true,
};

// 26.x: the browser has no Vulkan, and settings the presets would overwrite are kept by "custom".
function options26(v) {
  return {
    preferredGraphicsBackend: '"opengl"',
    graphicsPreset: '"custom"',
    // 0 none, 1 RGSS (supersampled texture lookups in the terrain shader), 2 anisotropic.
    textureFiltering: v.fancy ? 1 : 0,
    maxAnisotropyBit: 1,
    improvedTransparency: false,
    cutoutLeaves: v.fancy,
    cloudRange: v.clouds ? 32 : 8,
    weatherRadius: v.fancy ? 10 : 5,
    // The menu background blur is a full-screen post effect.
    menuBackgroundBlurriness: v.fancy ? 3 : 0,
    chunkSectionFadeInTime: v.fancy ? 0.75 : 0,
    inactivityFpsLimit: '"minimized"',
  };
}

function lwjgl3Options(v, plan) {
  const json = Date.parse(plan.releaseTime) >= ERA_JSON_VALUES;
  const clouds = v.clouds ? 'true' : 'false';
  return {
    ...(Date.parse(plan.releaseTime) >= ERA_26 ? options26(v) : {}),
    renderDistance: v.chunks,
    simulationDistance: Math.max(5, v.chunks),
    // 1.16+: 0 fast, 1 fancy (2, fabulous, is never chosen); 1.13 - 1.15 read fancyGraphics.
    graphicsMode: v.fancy ? 1 : 0,
    fancyGraphics: v.fancy,
    ao: json ? v.ao > 0 : v.ao,
    biomeBlendRadius: v.biomeBlend,
    entityDistanceScaling: v.entityDistance,
    particles: v.particles,
    renderClouds: json ? `"${clouds}"` : clouds,
    maxFps: v.maxFps,
    enableVsync: false,
    mipmapLevels: v.mipmap,
    entityShadows: v.shadows,
    prioritizeChunkUpdates: 0,
    tutorialStep: 'none',
    ...REQUIRED_LWJGL3,
  };
}

/** Option lines to enforce for a preset and version. */
export function launchOptions(preset, plan) {
  const v = VALUES[preset];
  if (plan.mode === 'lwjgl3') {
    if (v) return lwjgl3Options(v, plan);
    return Date.parse(plan.releaseTime) >= ERA_26 ? { ...REQUIRED_LWJGL3, preferredGraphicsBackend: '"opengl"' } : { ...REQUIRED_LWJGL3 };
  }
  if (!v) return { ...REQUIRED };
  const legacyAo = Date.parse(plan.releaseTime) < ERA_1_6;
  return {
    // Pre-1.7 uses viewDistance (0 = far ... 3 = tiny); 1.7+ uses renderDistance in chunks.
    viewDistance: v.legacyDistance,
    renderDistance: v.chunks,
    fancyGraphics: v.fancy,
    ao: legacyAo ? v.ao > 0 : v.ao,
    particles: v.particles,
    clouds: v.clouds,
    renderClouds: v.clouds,
    // 1.2.5 - 1.6: 0 = max, 1 = balanced (120), 2 = power saver (35).
    fpsLimit: 1,
    maxFps: v.maxFps,
    enableVsync: false,
    mipmapLevels: v.mipmap,
    entityShadows: v.shadows,
    useVbo: true,
    advancedOpengl: false,
    anaglyph3d: false,
    tutorialStep: 'none',
    ...REQUIRED,
  };
}

export function mergeOptions(text, values) {
  const lines = (text || '').split(/\r?\n/).filter((line) => line.length > 0);
  const seen = new Set();
  const merged = lines.map((line) => {
    const index = line.indexOf(':');
    if (index < 0) return line;
    const key = line.slice(0, index);
    if (!(key in values)) return line;
    seen.add(key);
    return `${key}:${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) merged.push(`${key}:${value}`);
  }
  return `${merged.join('\n')}\n`;
}
