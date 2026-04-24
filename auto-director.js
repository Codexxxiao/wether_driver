require('./lib/load-env');

const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

const client = require('./lib/feishu-client');
const { SPREADSHEET_TOKEN, TASKS_SHEET_ID } = require('./lib/feishu-config');
const { nonEmptyString, parseAssetCell } = require('./lib/feishu-cells');
const { uploadVideoToSheetMedia } = require('./lib/feishu-drive');
const { getMediaTmpDownloadUrl } = require('./lib/feishu-media');

const execPromise = util.promisify(exec);
const RENDER_ENGINE_DIR = path.join(__dirname, 'render-engine');

function sanitizeFileBase(name) {
    const s = String(name ?? 'task').trim() || 'task';
    return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 120);
}

async function triggerRemotionRender(taskName, hook, product, scene) {
    const safeBase = sanitizeFileBase(taskName);
    const propsData = { hook, product, scene };
    const propsFileName = `${safeBase}_props.json`;
    const propsPath = path.join(RENDER_ENGINE_DIR, propsFileName);
    const outputFileName = `${safeBase}_成片.mp4`;

    try {
        fs.writeFileSync(propsPath, JSON.stringify(propsData, null, 2), 'utf8');

        const cmd = `npx remotion render src/index.ts MatrixVideo out/${outputFileName} --props=./${propsFileName}`;

        console.log(`   ⏳ 正在调动底层算力渲染 [${outputFileName}]，请稍候...`);

        await execPromise(cmd, {
            cwd: RENDER_ENGINE_DIR,
            maxBuffer: 50 * 1024 * 1024
        });

        return outputFileName;
    } finally {
        if (fs.existsSync(propsPath)) {
            try {
                fs.unlinkSync(propsPath);
            } catch (_) {
                /* ignore */
            }
        }
    }
}

async function updateFeishuStatus(rowIndex, status, fColumn) {
    const rangeRaw = `${TASKS_SHEET_ID}!E${rowIndex + 1}:F${rowIndex + 1}`;

    let fCell;
    if (fColumn && typeof fColumn === 'object' && fColumn.fileToken) {
        try {
            const link = await getMediaTmpDownloadUrl(fColumn.fileToken);
            fCell = {
                type: 'url',
                text: fColumn.displayText != null ? String(fColumn.displayText) : '下载成片',
                link
            };
        } catch (e) {
            console.error(`   ⚠️ 无法写入链接单元格，改为纯文本: ${e.message}`);
            fCell =
                fColumn.displayText != null ? String(fColumn.displayText) : String(fColumn.fileToken);
        }
    } else {
        fCell = String(fColumn ?? '');
    }

    try {
        const res = await client.request({
            method: 'PUT',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            data: {
                valueRange: {
                    range: rangeRaw,
                    values: [[status, fCell]]
                }
            }
        });
        if (res.code !== 0) {
            console.error('   ❌ 飞书回传 API 返回:', res.msg || res);
        }
    } catch (err) {
        console.error('   ❌ 飞书回传失败:', err.message || err);
    }
}

function normalizeStatus(cell) {
    if (cell == null || cell === '') return '';
    if (typeof cell === 'string') return cell.trim();
    return String(cell).trim();
}

async function startFactory() {
    console.log('🏭 [全自动黑灯工厂] 总闸开启！正在读取制片单...');

    try {
        const range = encodeURIComponent(`${TASKS_SHEET_ID}!A1:F50`);
        const response = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${range}`,
            params: { valueRenderOption: 'FormattedValue' }
        });

        if (response.code !== 0) {
            throw new Error(response.msg || '读取表格失败');
        }

        const rows = response.data?.valueRange?.values;
        if (!rows || rows.length <= 1) return console.log('🤷‍♂️ 任务列表为空，机器停转。');

        let taskCount = 0;

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[0]) continue;

            const videoName = row[0];
            const status = normalizeStatus(row[4]);

            if (status !== '待生成') continue;

            taskCount++;
            console.log('\n===========================================');
            console.log(`🎬 锁定任务: [${videoName}]`);

            const hook = parseAssetCell(row[1], '');
            const product = parseAssetCell(row[2], '');
            const scene = parseAssetCell(row[3], '');

            if (!hook || !product || !scene) {
                console.error('   ❌ Hook/Product/Scene 解析为空，跳过（请检查飞书单元格）');
                await updateFeishuStatus(i, '❌ 生成失败', '素材列解析为空');
                continue;
            }

            try {
                const outName = await triggerRemotionRender(videoName, hook, product, scene);
                const outAbs = path.join(RENDER_ENGINE_DIR, 'out', outName);
                console.log(`   ✅ 渲染完毕！成片已存入 render-engine/out/${outName}`);

                let fPayload = outName;
                try {
                    const fileToken = await uploadVideoToSheetMedia(outAbs, outName);
                    fPayload = { fileToken, displayText: outName };
                    console.log('   ☁️ 已上传飞书表格素材，F 列将写入可点击链接');
                } catch (upErr) {
                    console.error(`   ⚠️ 上传飞书失败，F 列仅写入文件名文本: ${upErr.message}`);
                }

                await updateFeishuStatus(i, '✅ 已生成', fPayload);
                console.log('   📝 飞书打卡成功！');
            } catch (err) {
                console.error('   ❌ 渲染或回传崩溃:', err);
                await updateFeishuStatus(i, '❌ 生成失败', String(err.message || err).slice(0, 200));
            }
        }

        if (taskCount === 0) {
            console.log('🍵 当前没有【待生成】的任务，去喝杯咖啡吧。');
        } else {
            console.log(`\n🎉 [本轮生产结束] 共扫描 ${taskCount} 个待生成任务并已尝试处理。`);
        }
    } catch (error) {
        console.error('❌ 系统崩溃:', error.message || error);
    }
}

startFactory();
