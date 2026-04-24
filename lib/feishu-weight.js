/**
 * 素材行需含 { fileName, baseWeight, evolvedWeight }，与 evolution-engine / brain-engine 一致
 */
function pickWeight(evolvedRaw, baseRaw) {
    const tryNum = (v) => {
        if (v === '' || v == null) return null;
        const n = parseInt(String(v).trim(), 10);
        return Number.isNaN(n) ? null : n;
    };
    const e = tryNum(evolvedRaw);
    if (e !== null && e >= 0) return e;
    const b = tryNum(baseRaw);
    if (b !== null && b >= 0) return b;
    return 100;
}

function getWeightedRandomElement(arr) {
    if (arr.length === 0) return null;

    const weights = arr.map((item) => pickWeight(item.evolvedWeight, item.baseWeight));
    let totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight <= 0) {
        totalWeight = arr.length;
        weights.fill(1);
    }

    let randomNum = Math.random() * totalWeight;
    for (let i = 0; i < arr.length; i++) {
        randomNum -= weights[i];
        if (randomNum <= 0) {
            return arr[i].fileName;
        }
    }
    return arr[arr.length - 1].fileName;
}

module.exports = {
    pickWeight,
    getWeightedRandomElement
};
