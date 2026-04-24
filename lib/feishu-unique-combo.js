const { parseAssetCell } = require('./feishu-cells');
const { getWeightedRandomElement } = require('./feishu-weight');

function comboFingerprint(hookCell, productCell, sceneCell) {
    const h = parseAssetCell(hookCell, '');
    const p = parseAssetCell(productCell, '');
    const s = parseAssetCell(sceneCell, '');
    if (!h || !p || !s) return null;
    return `${h}|${p}|${s}`;
}

/**
 * @param {unknown[][]} historyRows 视频组合表 B:D 行（每行 Hook / Product / Scene）
 */
function buildBlacklistFromHistoryRows(historyRows) {
    const blacklist = new Set();
    historyRows.forEach((row) => {
        if (!row || row.length < 3) return;
        const fp = comboFingerprint(row[0], row[1], row[2]);
        if (fp) blacklist.add(fp);
    });
    return blacklist;
}

/**
 * @param {{ fileName: string; baseWeight: unknown; evolvedWeight: unknown }[]} hooks
 * @param {{ fileName: string; baseWeight: unknown; evolvedWeight: unknown }[]} products
 * @param {{ fileName: string; baseWeight: unknown; evolvedWeight: unknown }[]} scenes
 * @param {Set<string>} blacklist comboKey = hook|product|scene
 */
function pickUniqueCombo(hooks, products, scenes, blacklist) {
    const maxCombos = hooks.length * products.length * scenes.length;
    let selectedHook;
    let selectedProduct;
    let selectedScene;
    let isUnique = false;
    let resolvedByExhaustive = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 100;

    while (!isUnique && attempts < MAX_ATTEMPTS) {
        attempts++;
        selectedHook = getWeightedRandomElement(hooks);
        selectedProduct = getWeightedRandomElement(products);
        selectedScene = getWeightedRandomElement(scenes);
        const comboKey = `${selectedHook}|${selectedProduct}|${selectedScene}`;
        if (!blacklist.has(comboKey)) {
            isUnique = true;
        }
    }

    if (!isUnique) {
        const hookNames = [...new Set(hooks.map((h) => h.fileName))];
        const productNames = [...new Set(products.map((p) => p.fileName))];
        const sceneNames = [...new Set(scenes.map((s) => s.fileName))];
        outer: for (const h of hookNames) {
            for (const p of productNames) {
                for (const s of sceneNames) {
                    const key = `${h}|${p}|${s}`;
                    if (!blacklist.has(key)) {
                        selectedHook = h;
                        selectedProduct = p;
                        selectedScene = s;
                        isUnique = true;
                        resolvedByExhaustive = true;
                        break outer;
                    }
                }
            }
        }
    }

    return {
        selectedHook,
        selectedProduct,
        selectedScene,
        isUnique,
        resolvedByExhaustive,
        attempts,
        maxCombos
    };
}

module.exports = {
    comboFingerprint,
    buildBlacklistFromHistoryRows,
    pickUniqueCombo
};
