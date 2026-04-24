require('./lib/load-env');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const client = require('./lib/feishu-client');
const { SPREADSHEET_TOKEN, TASKS_SHEET_ID } = require('./lib/feishu-config');
const { uploadVideoToSheetMedia } = require('./lib/feishu-drive');
const { getMediaTmpDownloadUrl } = require('./lib/feishu-media');

const SHEET_ID = TASKS_SHEET_ID;

const ASSETS_DIR = path.join(__dirname, 'assets');
const AUDIO_DIR = path.join(__dirname, 'audio_assets');
const OUTPUT_DIR = path.join(__dirname, 'output');
const FEISHU_DL_DIR = path.join(OUTPUT_DIR, '_feishu_attachments');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(FEISHU_DL_DIR)) fs.mkdirSync(FEISHU_DL_DIR, { recursive: true });

/**
 * 解析单元格：纯字符串视为 assets 下文件名；飞书附件数组则取 fileToken 下载
 */
function firstAttachment(cell) {
    if (Array.isArray(cell) && cell.length > 0 && cell[0] && cell[0].fileToken) {
        return cell[0];
    }
    return null;
}

/**
 * 获取素材临时下载链接并下载到本地（见 drive medias API）
 */
async function downloadAttachmentToFile(attachment, destPath) {
    const res = await client.request({
        method: 'GET',
        url: '/open-apis/drive/v1/medias/batch_get_tmp_download_url',
        params: { file_tokens: attachment.fileToken }
    });
    if (res.code !== 0) {
        throw new Error(res.msg || 'batch_get_tmp_download_url failed');
    }
    const list = res.data?.tmp_download_urls;
    if (!list || !list[0] || !list[0].tmp_download_url) {
        throw new Error('未返回 tmp_download_url');
    }
    const tmpUrl = list[0].tmp_download_url;
    const fileRes = await axios.get(tmpUrl, { responseType: 'arraybuffer', maxRedirects: 5 });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.from(fileRes.data));
    return destPath;
}

async function resolveCellToVideoPath(cell, role, runKey) {
    const att = firstAttachment(cell);
    if (att) {
        const safeName = `${runKey}_${role}_${att.fileToken}.mp4`;
        const dest = path.join(FEISHU_DL_DIR, runKey, safeName);
        console.log(`   ⬇️ 正在下载飞书附件 [${role}] → ${safeName}`);
        return downloadAttachmentToFile(att, dest);
    }
    if (typeof cell === 'string' && cell.trim()) {
        return path.join(ASSETS_DIR, cell.trim());
    }
    throw new Error(`单元格 ${role} 无有效附件或文件名`);
}

function toFfmpegPath(absPath) {
    return absPath.replace(/\\/g, '/');
}

/**
 * 三段视频绝对路径 + 配音文件名 → 输出成片
 */
function mixThreeClipsAndAudio(hookPath, productPath, scenePath, audioName, outputName) {
    return new Promise((resolve, reject) => {
        const hookPathF = toFfmpegPath(hookPath);
        const prodPathF = toFfmpegPath(productPath);
        const scenePathF = toFfmpegPath(scenePath);
        const audioPath = path.join(AUDIO_DIR, audioName);
        const outputPath = path.join(OUTPUT_DIR, outputName);

        const tempTxtPath = path.join(OUTPUT_DIR, `concat_${Date.now()}.txt`);
        const txtContent = `file '${hookPathF}'\nfile '${prodPathF}'\nfile '${scenePathF}'`;
        fs.writeFileSync(tempTxtPath, txtContent);

        console.log(`   ⏳ 正在进行底层拼接轨道的像素级对齐...`);

        ffmpeg()
            .input(tempTxtPath)
            .inputOptions(['-f concat', '-safe 0'])
            .input(audioPath)
            .outputOptions([
                '-map 0:v:0',
                '-map 1:a:0',
                '-c:v copy',
                '-c:a aac',
                '-shortest'
            ])
            .on('end', () => {
                if (fs.existsSync(tempTxtPath)) fs.unlinkSync(tempTxtPath);
                resolve(outputName);
            })
            .on('error', (err) => {
                if (fs.existsSync(tempTxtPath)) fs.unlinkSync(tempTxtPath);
                reject(err);
            })
            .save(outputPath);
    });
}

/**
 * 飞书回传：E 列状态 + F 列（纯文本，或上传素材后的可点击链接：官方 v2 不支持直接写附件对象，用 type:url）
 */
async function updateFeishuStatus(rowIndex, status, fColumn) {
    const actualRow = rowIndex + 1;
    const rangeRaw = `${SHEET_ID}!E${actualRow}:F${actualRow}`;

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
            fCell = fColumn.displayText != null ? String(fColumn.displayText) : String(fColumn.fileToken);
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
            console.error('   ❌ 飞书状态更新 API 返回:', res.msg || res);
            return;
        }
        console.log(`   📝 飞书表格回传成功: 状态更新为 [${status}]`);
    } catch (err) {
        console.error('   ❌ 飞书状态更新失败:', err.message);
    }
}

async function startV3Engine() {
    console.log('🏭 [气象矩阵中枢 V3.0] 启动！开始接管飞书流水线...');

    try {
        const range = encodeURIComponent(`${SHEET_ID}!A1:F50`);
        const response = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${range}`
        });

        if (response.code !== 0) {
            throw new Error(response.msg || '读取表格失败');
        }
        const tableRows = response.data?.valueRange?.values;
        if (!tableRows || tableRows.length <= 1) {
            return console.log('🤷‍♂️ 飞书表格里没有任务，今日停工休息。');
        }

        for (let i = 1; i < tableRows.length; i++) {
            const row = tableRows[i];
            if (!row || !row[0]) continue;

            const [videoName, hook, product, scene, status] = row;
            const statusStr = typeof status === 'string' ? status.trim() : String(status ?? '');

            if (statusStr === '待生成') {
                const runKey = `${String(videoName).replace(/[^\w\u4e00-\u9fa5-]/g, '_')}_${i}_${Date.now()}`;
                console.log(`\n===========================================`);
                console.log(`🎬 发现新任务: [${videoName}]`);

                const outputName = `${videoName}_成片.mp4`;

                try {
                    const availableAudios = fs.readdirSync(AUDIO_DIR).filter((file) => file.endsWith('.mp3'));
                    if (availableAudios.length === 0) {
                        throw new Error('⚠️ audio_assets 文件夹中没有任何 mp3 配音，无法渲染！');
                    }
                    const randomIndex = Math.floor(Math.random() * availableAudios.length);
                    const audioName = availableAudios[randomIndex];
                    console.log(`   🎤 本次混剪随机抽取的音频剧本为: [${audioName}]`);

                    const hookPath = await resolveCellToVideoPath(hook, 'hook', runKey);
                    const prodPath = await resolveCellToVideoPath(product, 'product', runKey);
                    const scenePath = await resolveCellToVideoPath(scene, 'scene', runKey);

                    await mixThreeClipsAndAudio(hookPath, prodPath, scenePath, audioName, outputName);
                    console.log(`   ✅ 视频 [${outputName}] 渲染完成！`);

                    const outAbs = path.join(OUTPUT_DIR, outputName);
                    let mediaToken = null;
                    try {
                        mediaToken = await uploadVideoToSheetMedia(outAbs, outputName);
                        console.log('   ☁️ 已上传飞书素材，file_token 已就绪');
                    } catch (upErr) {
                        console.error(`   ⚠️ 上传飞书附件失败，F列将写入文件名文本: ${upErr.message}`);
                    }
                    await updateFeishuStatus(
                        i,
                        '✅ 已生成',
                        mediaToken ? { fileToken: mediaToken, displayText: outputName } : outputName
                    );
                } catch (err) {
                    console.error(`   ❌ 视频生成失败: ${err.message}`);
                    await updateFeishuStatus(i, '❌ 渲染失败', String(err.message).slice(0, 200));
                }
            }
        }

        console.log(`\n🎉 [流水线停机] 所有飞书任务处理完毕！`);
    } catch (error) {
        console.error('❌ 系统崩溃:', error.message || error);
    }
}

startV3Engine();
