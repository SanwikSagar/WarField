export function environmentPolicy(detail = {}) {
    const extent = detail.shadowExtent ?? 55;
    const scale = Math.max(0.7, Math.min(1.5, extent / 60));
    const renderDistance = Math.min(detail.renderDistance ?? 100 * scale, detail.maxRenderDistance ?? 120);
    const trees = detail.treeLod ?? [38, 80, 150];
    const grassDistance = detail.foliageDistance ?? Math.min(detail.grassDist ?? 70, 62 * scale);
    return {
        renderDistance,
        fogDensity: detail.fogDensity ?? 1.65 / renderDistance,
        treeLod: [Math.min(trees[0], 18 * scale), Math.min(trees[1], 38 * scale), renderDistance],
        grassDist: grassDistance,
        fieldArea: Math.min(detail.fieldArea ?? 44, 50 * scale),
        bushNear: Math.min(detail.bushNear ?? 18, 16 * scale),
        foliageDensity: detail.foliageDensity ?? 1.65,
        treeDensity: detail.treeDensity ?? 1.75,
        textureDetailDistance: detail.textureDetailDistance ?? 20 * scale,
        groundDensity: detail.groundDensity ?? 0.95,
        plantDensity: detail.plantDensity ?? 1.15,
        shadowDistance: detail.shadowDistance ?? 24 * scale,
        shadowInterval: detail.shadowInterval ?? (detail.fieldMul < 0.6 ? 0.1 : 0.066),
        propLod: detail.propLod ?? [16 * scale, 32 * scale, 55 * scale, renderDistance],
        plantLod: detail.plantLod ?? [9 * scale, 18 * scale, grassDistance],
        terrainLod: detail.terrainLod ?? [28 * scale, 55 * scale],
        weatherDistance: detail.weatherDistance ?? 18 * scale,
        reflectionDistance: detail.reflectionDistance ?? 36 * scale,
        impostorResolution: detail.impostorResolution ?? (detail.fieldMul >= 1 ? 256 : 128)
    };
}