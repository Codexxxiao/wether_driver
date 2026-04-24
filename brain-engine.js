require('./lib/load-env');

const client = require('./lib/feishu-client');
const { SPREADSHEET_TOKEN, ASSETS_SHEET_ID, TASKS_SHEET_ID } = require('./lib/feishu-config');
const { nonEmptyString, parseAssetCell } = require('./lib/feishu-cells');
const { buildBlacklistFromHistoryRows, pickUniqueCombo } = require('./lib/feishu-unique-combo');

async function startBrain() {
    console.log('🧠 [繁衍中枢 V1.1 防撞版] 唤醒！正在同步飞书数据...');

    try {
        const assetRange = encodeURIComponent(`${ASSETS_SHEET_ID}!A2:E100`);
        const assetRes = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${assetRange}`,
            params: { valueRenderOption: 'FormattedValue' }
        });

        if (assetRes.code !== 0) {
            throw new Error(assetRes.msg || '读取素材总库失败');
        }

        const allAssets = assetRes.data?.valueRange?.values || [];
        const hooks = [];
        const products = [];
        const scenes = [];

        allAssets.forEach((row) => {
            if (!row || row.length < 3) return;
            const type = nonEmptyString(row[1]);
            const fileName = parseAssetCell(row[2], nonEmptyString(row[0]));
            if (!fileName) return;

            const assetData = {
                fileName,
                baseWeight: row[3],
                evolvedWeight: row[4]
            };

            if (type === 'Hook') hooks.push(assetData);
            if (type === 'Product') products.push(assetData);
            if (type === 'Scene') scenes.push(assetData);
        });

        if (hooks.length === 0 || products.length === 0 || scenes.length === 0) {
            return console.log('❌ 基因库空虚！缺少某一种必需的素材片段。');
        }

        const historyRange = encodeURIComponent(`${TASKS_SHEET_ID}!B2:D2000`);
        const historyRes = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${historyRange}`,
            params: { valueRenderOption: 'FormattedValue' }
        });

        if (historyRes.code !== 0) {
            throw new Error(historyRes.msg || '读取视频组合表历史失败');
        }

        const historyRows = historyRes.data?.valueRange?.values || [];
        const blacklist = buildBlacklistFromHistoryRows(historyRows);

        console.log(`   📚 已加载 ${blacklist.size} 条历史配方，开启严密查重...`);

        const {
            selectedHook,
            selectedProduct,
            selectedScene,
            isUnique,
            resolvedByExhaustive,
            attempts,
            maxCombos
        } = pickUniqueCombo(hooks, products, scenes, blacklist);

        if (!isUnique) {
            console.log('\n❌ 严重警告：组合空间已用尽（随机 + 穷举均无空位）。');
            console.log(`   理论最大组合数约 ${maxCombos}，历史唯一配方约 ${blacklist.size} 条。`);
            console.log('🛠️ 请补充【素材总库】或清理【视频组合表】中过时行。');
            return;
        }

        const batchId = `矩阵批量_${Date.now().toString().slice(-6)}`;

        const how =
            resolvedByExhaustive
                ? `随机 ${attempts} 次未中，穷举补位`
                : `加权随机 ${attempts} 次`;
        console.log(`\n✅ [配方生成成功] ${how}：`);
        console.log(`   ├─ Hook: ${selectedHook}`);
        console.log(`   ├─ Product: ${selectedProduct}`);
        console.log(`   └─ Scene: ${selectedScene}`);

        const taskRange = `${TASKS_SHEET_ID}!A:F`;
        const appendRes = await client.request({
            method: 'POST',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values_append`,
            params: { insertDataOption: 'INSERT_ROWS' },
            data: {
                valueRange: {
                    range: taskRange,
                    values: [[batchId, selectedHook, selectedProduct, selectedScene, '待生成', '']]
                }
            }
        });

        if (appendRes.code !== 0) {
            throw new Error(appendRes.msg || '追加任务失败');
        }

        console.log(`   📝 全新任务 [${batchId}] 已安全写入飞书队列！`);
    } catch (error) {
        console.error('❌ 中枢神经崩溃:', error.message || error);
    }
}

startBrain();
