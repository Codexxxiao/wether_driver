require('./lib/load-env');

const client = require('./lib/feishu-client');
const {
    SPREADSHEET_TOKEN,
    ASSETS_SHEET_ID,
    TASKS_SHEET_ID,
    ANALYTICS_SHEET_ID
} = require('./lib/feishu-config');
const { nonEmptyString, parseAssetCell } = require('./lib/feishu-cells');
const { buildBlacklistFromHistoryRows, pickUniqueCombo } = require('./lib/feishu-unique-combo');

/**
 * @param {{ tasks?: unknown[]; assets?: unknown[] } | null} cache 预取表数据，避免每条 S 重复 GET
 */
async function applySTierHookBoost(videoNameRaw, cache) {
    const videoKey = nonEmptyString(videoNameRaw);
    if (!videoKey) return;

    let tasks = cache?.tasks;
    let assets = cache?.assets;

    if (!tasks || !assets) {
        const taskRange = encodeURIComponent(`${TASKS_SHEET_ID}!A2:B100`);
        const taskRes = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${taskRange}`,
            params: { valueRenderOption: 'FormattedValue' }
        });
        if (taskRes.code !== 0) {
            throw new Error(taskRes.msg || '读取视频组合表失败');
        }
        tasks = taskRes.data?.valueRange?.values;

        const assetRange = encodeURIComponent(`${ASSETS_SHEET_ID}!A2:E100`);
        const assetRes = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${assetRange}`,
            params: { valueRenderOption: 'FormattedValue' }
        });
        if (assetRes.code !== 0) {
            throw new Error(assetRes.msg || '读取素材总库失败');
        }
        assets = assetRes.data?.valueRange?.values;
    }

    if (!tasks || !assets) return;

    let targetHook = null;
    for (const t of tasks) {
        if (!t || t[0] == null) continue;
        if (nonEmptyString(t[0]) !== videoKey) continue;
        targetHook = parseAssetCell(t[1], '');
        break;
    }
    if (!targetHook) {
        console.log(`   ⚠️ 未在视频组合表找到任务 [${videoKey}]，跳过基因飞升`);
        return;
    }

    for (let j = 0; j < assets.length; j++) {
        const ar = assets[j];
        if (!ar) continue;
        if (nonEmptyString(ar[1]) !== 'Hook') continue;
        const fileName = parseAssetCell(ar[2], nonEmptyString(ar[0]));
        if (fileName !== targetHook) continue;

        const updateRow = j + 2;
        const rangeRaw = `${ASSETS_SHEET_ID}!E${updateRow}:E${updateRow}`;
        const putRes = await client.request({
            method: 'PUT',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            data: {
                valueRange: {
                    range: rangeRaw,
                    values: [[9999]]
                }
            }
        });
        if (putRes.code !== 0) {
            console.error('   ⚠️ 更新进化权重失败:', putRes.msg || putRes);
        } else {
            console.log(`   👑 基因飞升！Hook [${targetHook}] 的进化权重已拉满至 9999！`);
        }
        return;
    }
    console.log(`   ⚠️ 素材总库未找到 Hook 素材 [${targetHook}]`);
}

async function processAnalytics() {
    console.log('🧬 [达尔文引擎] 启动！开始复盘昨日投放数据...');

    try {
        const analyticsRange = encodeURIComponent(`${ANALYTICS_SHEET_ID}!A2:D50`);
        const response = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${analyticsRange}`,
            params: { valueRenderOption: 'FormattedValue' }
        });

        if (response.code !== 0) {
            throw new Error(response.msg || '读取运营回流表失败');
        }

        const rows = response.data?.valueRange?.values;
        if (!rows || rows.length === 0) {
            return console.log('   🤷‍♂️ 还没有回流数据，等待投放反馈...');
        }

        console.log(`   📊 读取到 ${rows.length} 条投放反馈，开始进行基因审判...`);

        const taskRangeEnc = encodeURIComponent(`${TASKS_SHEET_ID}!A2:B100`);
        const assetRangeEnc = encodeURIComponent(`${ASSETS_SHEET_ID}!A2:E100`);
        const [taskRes, assetRes] = await Promise.all([
            client.request({
                method: 'GET',
                url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${taskRangeEnc}`,
                params: { valueRenderOption: 'FormattedValue' }
            }),
            client.request({
                method: 'GET',
                url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${assetRangeEnc}`,
                params: { valueRenderOption: 'FormattedValue' }
            })
        ]);
        const sTierTaskRows = taskRes.code === 0 ? taskRes.data?.valueRange?.values : null;
        const sTierAssetRows = assetRes.code === 0 ? assetRes.data?.valueRange?.values : null;
        if (taskRes.code !== 0) console.warn('   ⚠️ 预取视频组合表失败，S 级追溯将按需单独请求');
        if (assetRes.code !== 0) console.warn('   ⚠️ 预取素材总库失败，S 级追溯将按需单独请求');

        const hookBoostCache =
            sTierTaskRows && sTierAssetRows ? { tasks: sTierTaskRows, assets: sTierAssetRows } : null;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[0] || !row[1] || !row[2]) continue;

            const videoName = row[0];
            const playRate = parseFloat(row[1]) || 0;
            const cvr = parseFloat(row[2]) || 0;

            const totalScore = playRate * 0.4 + cvr * 0.6;

            let grade = 'C (淘汰)';
            if (totalScore >= 15) grade = 'S (神级爆款)';
            else if (totalScore >= 8) grade = 'A (优质)';
            else if (totalScore >= 3) grade = 'B (普通)';

            console.log(
                `   ├─ 视频 [${videoName}] | 完播:${playRate}% CVR:${cvr}% => 综合得分: ${totalScore.toFixed(2)} | 评级: ${grade}`
            );

            const actualRow = i + 2;
            const rangeRaw = `${ANALYTICS_SHEET_ID}!D${actualRow}:D${actualRow}`;
            const writeRes = await client.request({
                method: 'PUT',
                url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`,
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                data: {
                    valueRange: {
                        range: rangeRaw,
                        values: [[grade]]
                    }
                }
            });
            if (writeRes.code !== 0) {
                console.error(`   ⚠️ 写回 D${actualRow} 失败:`, writeRes.msg || writeRes);
            }

            if (grade.includes('S')) {
                console.log('   🌟 发现 S 级神作！正在追溯 Hook 并提升进化权重...');
                try {
                    await applySTierHookBoost(videoName, hookBoostCache);
                } catch (err) {
                    console.error('   ❌ 基因追溯失败:', err.message || err);
                }
            }
        }

        console.log('   ✅ 所有视频评级完毕！飞书 D 列已更新。');
    } catch (error) {
        console.error('   ❌ 读取回流数据失败:', error.message);
    }
}

async function breedNextGeneration() {
    console.log('\n🧪 [繁衍中枢 v2.0] 开始基于进化权重孵化新生命...');

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

        const allAssets = assetRes.data?.valueRange?.values;
        if (!allAssets || allAssets.length === 0) {
            return console.log('❌ 基因库空虚！');
        }

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
            return console.log('⚠️ Hook / Product / Scene 某一类为空，无法繁衍。');
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
        console.log(`   📚 已加载 ${blacklist.size} 条历史配方，进化繁衍查重中...`);

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
            console.log('\n❌ 组合空间已用尽（与矩阵中枢相同规则：随机 + 穷举均无空位）。');
            console.log(`   理论最大组合数约 ${maxCombos}，历史唯一配方约 ${blacklist.size} 条。`);
            console.log('🛠️ 请补充【素材总库】或清理【视频组合表】中过时行。');
            return;
        }

        const batchId = `超级变异_${Date.now().toString().slice(-6)}`;

        const how =
            resolvedByExhaustive
                ? `随机 ${attempts} 次未中，穷举补位`
                : `加权随机 ${attempts} 次`;
        console.log(`   🏆 抽卡结果 (爆款概率提升版，${how})：`);
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
            throw new Error(appendRes.msg || '追加任务行失败');
        }

        console.log(
            `\n✅ [下达指令] 新任务 [${batchId}] 已加入队列。请运行 auto-director.js 开始生产。`
        );
    } catch (error) {
        console.error('❌ 繁衍失败:', error.message || error);
    }
}

async function startEvolution() {
    await processAnalytics();
    await breedNextGeneration();
}

startEvolution();
