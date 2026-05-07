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
    historyRows.forEach(row => {
        // 确保能读到 5 个基因
        if (row && row.length >= 5) {
            blacklist.add(`${row[0]}_${row[1]}_${row[2]}_${row[3]}_${row[4]}`);
        }
    });
    return blacklist;
}

// 模拟加权随机抽取逻辑 (请保留你原有的抽取方式，或者用这个简单的示例替代)
function weightedRandomSelect(pool) {
    if (!pool || pool.length === 0) return '';
    // 假设你有基于 evolvedWeight 的权重逻辑，在这里进行抽卡
    // 这里做最简单的随机演示，请替换为你自己封装好的加权抽卡工具函数
    const randomIndex = Math.floor(Math.random() * pool.length);
    return pool[randomIndex].fileName;
}

/**
 * @param {{ fileName: string; baseWeight: unknown; evolvedWeight: unknown }[]} hooks
 * @param {{ fileName: string; baseWeight: unknown; evolvedWeight: unknown }[]} products
 * @param {{ fileName: string; baseWeight: unknown; evolvedWeight: unknown }[]} scenes
 * @param {Set<string>} blacklist comboKey = hook|product|scene
 */
function pickUniqueCombo(hooks, pains, proofs, benefits, ctas, blacklist) {
    const maxCombos = hooks.length * pains.length * proofs.length * benefits.length * ctas.length;
    let selectedHook = '', selectedPain = '', selectedProof = '', selectedBenefit = '', selectedCta = '';
    let isUnique = false;
    let attempts = 0;

    // 尝试最多 500 次加权随机碰撞 (对于5段式来说，组合空间极大，500次足够了)
    for (attempts = 1; attempts <= 500; attempts++) {
        selectedHook = weightedRandomSelect(hooks);
        selectedPain = weightedRandomSelect(pains);
        selectedProof = weightedRandomSelect(proofs);
        selectedBenefit = weightedRandomSelect(benefits);
        selectedCta = weightedRandomSelect(ctas);

        const comboId = `${selectedHook}_${selectedPain}_${selectedProof}_${selectedBenefit}_${selectedCta}`;

        if (!blacklist.has(comboId)) {
            isUnique = true;
            break;
        }
    }

    // （如果你之前有兜底的穷举法代码，可以继续放在这里补充）

    return {
        selectedHook,
        selectedPain,
        selectedProof,
        selectedBenefit,
        selectedCta,
        isUnique,
        resolvedByExhaustive: false, // 是否触发穷举
        attempts,
        maxCombos
    };
}

module.exports = {
    comboFingerprint,
    buildBlacklistFromHistoryRows,
    pickUniqueCombo
};
