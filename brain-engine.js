require('./lib/load-env');

const client = require('./lib/feishu-client');
const { SPREADSHEET_TOKEN, ASSETS_SHEET_ID, TASKS_SHEET_ID } = require('./lib/feishu-config');
const { nonEmptyString, parseAssetCell } = require('./lib/feishu-cells');
const { buildBlacklistFromHistoryRows, pickUniqueCombo } = require('./lib/feishu-unique-combo');

async function startBrain() {
    console.log('🧠 [千川繁衍中枢 V2.0 5段式装甲版] 唤醒！正在同步飞书数据...');

    try {
        // 读取素材库范围 (假设你的分类、链接、权重都在 A-E 列以内)
        const assetRange = encodeURIComponent(`${ASSETS_SHEET_ID}!A2:E200`);
        const assetRes = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${assetRange}`,
            params: { valueRenderOption: 'FormattedValue' }
        });

        if (assetRes.code !== 0) throw new Error(assetRes.msg || '读取素材总库失败');

        const allAssets = assetRes.data?.valueRange?.values || [];

        // 5 大基因库初始化
        const hooks = [];
        const pains = [];
        const proofs = [];
        const benefits = [];
        const ctas = [];

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

            // 分拣 5 段素材
            if (type === 'Hook') hooks.push(assetData);
            if (type === 'Pain') pains.push(assetData);
            if (type === 'Proof') proofs.push(assetData);
            if (type === 'Benefit') benefits.push(assetData);
            if (type === 'CTA') ctas.push(assetData);
        });

        if (hooks.length === 0 || pains.length === 0 || proofs.length === 0 || benefits.length === 0 || ctas.length === 0) {
            return console.log('❌ 基因库空虚！【Hook/Pain/Proof/Benefit/CTA】五种必需素材缺一不可，请检查飞书总库。');
        }

        // 读取历史组合，范围扩大至 B 列到 F 列 (也就是那 5 个素材列)
        const historyRange = encodeURIComponent(`${TASKS_SHEET_ID}!B2:F2000`);
        const historyRes = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${historyRange}`,
            params: { valueRenderOption: 'FormattedValue' }
        });

        if (historyRes.code !== 0) throw new Error(historyRes.msg || '读取视频组合表历史失败');

        const historyRows = historyRes.data?.valueRange?.values || [];
        const blacklist = buildBlacklistFromHistoryRows(historyRows);

        console.log(`   📚 已加载 ${blacklist.size} 条历史配方，开启五维严密查重...`);

        // 调用升级后的 5 维抽卡函数
        const {
            selectedHook,
            selectedPain,
            selectedProof,
            selectedBenefit,
            selectedCta,
            isUnique,
            resolvedByExhaustive,
            attempts,
            maxCombos
        } = pickUniqueCombo(hooks, pains, proofs, benefits, ctas, blacklist);

        if (!isUnique) {
            console.log('\n❌ 严重警告：组合空间已用尽（随机 + 穷举均无空位）。');
            console.log(`   理论最大组合数约 ${maxCombos}，历史唯一配方约 ${blacklist.size} 条。`);
            console.log('🛠️ 请补充【素材总库】或清理【视频组合表】中过时行。');
            return;
        }

        // 千川防重命名规范：视频名必须带上独一无二的时间戳和基因标签，以便日后数据回流
        const batchId = `防晒矩阵_${Date.now().toString().slice(-6)}`;

        const how = resolvedByExhaustive ? `随机 ${attempts} 次未中，穷举补位` : `加权随机 ${attempts} 次`;
        console.log(`\n✅ [配方生成成功] ${how}：`);
        console.log(`   ├─ Hook:    ${selectedHook}`);
        console.log(`   ├─ Pain:    ${selectedPain}`);
        console.log(`   ├─ Proof:   ${selectedProof}`);
        console.log(`   ├─ Benefit: ${selectedBenefit}`);
        console.log(`   └─ CTA:     ${selectedCta}`);

        // 写入范围扩大至 H 列 (共8列：任务名, 5个素材, 状态, 链接)
        const taskRange = `${TASKS_SHEET_ID}!A:H`;
        const appendRes = await client.request({
            method: 'POST',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values_append`,
            params: { insertDataOption: 'INSERT_ROWS' },
            data: {
                valueRange: {
                    range: taskRange,
                    // 按照飞书表格顺序依次推入 8 个单元格的数据
                    values: [[batchId, selectedHook, selectedPain, selectedProof, selectedBenefit, selectedCta, '待生成', '']]
                }
            }
        });

        if (appendRes.code !== 0) throw new Error(appendRes.msg || '追加任务失败');

        console.log(`   📝 全新 5 段式任务 [${batchId}] 已安全写入飞书队列！`);
    } catch (error) {
        console.error('❌ 中枢神经崩溃:', error.message || error);
    }
}

startBrain();