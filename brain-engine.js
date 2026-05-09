require('./lib/load-env');
const client = require('./lib/feishu-client');
const { SPREADSHEET_TOKEN, ASSETS_SHEET_ID, TASKS_SHEET_ID } = require('./lib/feishu-config');
const { nonEmptyString, parseAssetCell } = require('./lib/feishu-cells');
const { buildBlacklistFromHistoryRows, pickUniqueCombo } = require('./lib/feishu-unique-combo');

/** start:all 时只跑指定大类/款式；不配置则行为与原先一致（全部款式） */
function parseOnlyStylesFromEnv(key) {
    const raw = (process.env[key] || '').trim();
    if (!raw) return new Set();
    return new Set(raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
}

async function startBrain() {
    console.log('🧠 [SPU+SKU 终极繁衍中枢 V4.0] 唤醒！正在同步二维飞书数据...');

    const brainOnlyCategory = (process.env.BRAIN_ONLY_CATEGORY || '').trim() || null;
    const brainOnlyStyleSet = parseOnlyStylesFromEnv('BRAIN_ONLY_STYLE');
    if (brainOnlyCategory || brainOnlyStyleSet.size > 0) {
        console.log(
            `   🎯 BRAIN_ONLY：大类=${brainOnlyCategory || '（未限定）'} 款式=${brainOnlyStyleSet.size ? [...brainOnlyStyleSet].join(' | ') : '（未限定）'}`
        );
    }

    try {
        // 读取 A-G 列 (A 大类, B 款式, C 类型, D 素材文件, E 链接/附件, F/G 权重)
        const assetRange = encodeURIComponent(`${ASSETS_SHEET_ID}!A2:G500`);
        const assetRes = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${assetRange}`,
            params: { valueRenderOption: 'FormattedValue' }
        });

        const allAssets = assetRes.data?.valueRange?.values || [];
        const catalog = {};

        allAssets.forEach((row) => {
            if (!row || row.length < 5) return;
            const category = nonEmptyString(row[0]); // A: 产品大类
            const style = nonEmptyString(row[1]);    // B: 具体款式 / 通用
            const type = nonEmptyString(row[2]);     // C: 素材类型 Hook/Pain/...
            // D=素材文件名 E=链接/附件：E 常为空，需回落到 D（与飞书「素材文件在 D」表头一致）
            const eCell = row[4];
            const hasE = eCell != null && String(eCell).trim() !== '';
            const primaryCell = hasE ? eCell : row[3];
            const fileNameRaw = parseAssetCell(primaryCell, nonEmptyString(row[3]));

            if (!category || !style || !fileNameRaw) return;

            // 🌟 核心：给本地素材打上物理路径的 GPS 标签
            let finalPath = fileNameRaw;
            if (!fileNameRaw.startsWith('http') && !fileNameRaw.includes('/')) {
                finalPath = `${category}/${style}/${fileNameRaw}`;
            }

            if (!catalog[category]) catalog[category] = {};
            if (!catalog[category][style]) {
                catalog[category][style] = { hooks: [], pains: [], proofs: [], benefits: [], ctas: [] };
            }

            const assetData = { fileName: finalPath, baseWeight: row[5], evolvedWeight: row[6] };
            const pool = catalog[category][style];

            if (type === 'Hook') pool.hooks.push(assetData);
            if (type === 'Pain') pool.pains.push(assetData);
            if (type === 'Proof') pool.proofs.push(assetData);
            if (type === 'Benefit') pool.benefits.push(assetData);
            if (type === 'CTA') pool.ctas.push(assetData);
        });

        // 读取历史查重黑名单 (注意：D到H列正好是5个素材)
        const historyRange = encodeURIComponent(`${TASKS_SHEET_ID}!D2:H2000`);
        const historyRes = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${historyRange}`,
            params: { valueRenderOption: 'FormattedValue' }
        });
        const blacklist = buildBlacklistFromHistoryRows(historyRes.data?.valueRange?.values || []);

        const newTasks = [];

        for (const [category, stylesObj] of Object.entries(catalog)) {
            if (brainOnlyCategory && String(category).trim() !== brainOnlyCategory) {
                continue;
            }

            const genericPool = stylesObj['通用'] || { hooks: [], pains: [], proofs: [], benefits: [], ctas: [] };

            for (const [style, specificPool] of Object.entries(stylesObj)) {
                if (style === '通用') continue; // 专属防守：通用本身不单独生成视频

                if (brainOnlyStyleSet.size > 0 && !brainOnlyStyleSet.has(String(style).trim())) {
                    continue;
                }

                console.log(`\n📦 正在处理款式: [${category}] -> [${style}]`);

                // 基因混合：通用的开头+痛点，配合专属的展示+逼单
                const mergedHooks = [...specificPool.hooks, ...genericPool.hooks];
                const mergedPains = [...specificPool.pains, ...genericPool.pains];
                const mergedProofs = [...specificPool.proofs, ...genericPool.proofs];
                const mergedBenefits = [...specificPool.benefits, ...genericPool.benefits];
                const mergedCtas = [...specificPool.ctas, ...genericPool.ctas];

                if (mergedHooks.length === 0 || mergedCtas.length === 0) {
                    console.log(`   ⚠️ 该款式基因不全，跳过生成。`);
                    continue;
                }

                // 5维防撞抽卡
                const { selectedHook, selectedPain, selectedProof, selectedBenefit, selectedCta, isUnique } =
                    pickUniqueCombo(mergedHooks, mergedPains, mergedProofs, mergedBenefits, mergedCtas, blacklist);

                if (isUnique) {
                    const batchId = `${category}_${style}_${Date.now().toString().slice(-4)}`;
                    console.log(`   ✅ 成功生成组合：${batchId}`);

                    // 追加到飞书新任务数组
                    newTasks.push([
                        category, style, batchId,
                        selectedHook, selectedPain, selectedProof, selectedBenefit, selectedCta,
                        '待生成', ''
                    ]);
                } else {
                    console.log(`   ⚠️ 该款式的所有组合已耗尽！`);
                }
            }
        }

        if (newTasks.length > 0) {
            const taskRange = `${TASKS_SHEET_ID}!A:J`; // 范围 A-J 共10列
            await client.request({
                method: 'POST',
                url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values_append`,
                params: { insertDataOption: 'INSERT_ROWS' },
                data: { valueRange: { range: taskRange, values: newTasks } }
            });
            console.log(`\n🚀 抽卡完毕！共写入 ${newTasks.length} 条新任务到飞书。`);
        }

    } catch (error) {
        console.error('❌ 中枢神经崩溃:', error);
    }
}
startBrain();