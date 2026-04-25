require('./lib/load-env');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { spawnSync } = require('child_process');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const xlsx = require('xlsx');

const client = require('./lib/feishu-client');
const { SPREADSHEET_TOKEN, TASKS_SHEET_ID } = require('./lib/feishu-config');
const { uploadVideoToSheetMedia } = require('./lib/feishu-drive');
const { getMediaTmpDownloadUrl } = require('./lib/feishu-media');

const SHEET_ID = TASKS_SHEET_ID;

const ASSETS_DIR = path.join(__dirname, 'assets');
const AUDIO_DIR = path.join(__dirname, 'audio_assets');
const OUTPUT_DIR = path.join(__dirname, 'output');
const EXCEL_PATH = path.join(__dirname, 'generated_scripts.xlsx');
const FEISHU_DL_DIR = path.join(OUTPUT_DIR, '_feishu_attachments');
const BGM_DIR = path.join(__dirname, 'bgm_assets');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(FEISHU_DL_DIR)) fs.mkdirSync(FEISHU_DL_DIR, { recursive: true });
if (!fs.existsSync(BGM_DIR)) fs.mkdirSync(BGM_DIR, { recursive: true });

/** BGM 在混音前的相对音量（0~1）；老版本 FFmpeg 的 amix 无 normalize 选项，靠增益补偿 */
const BGM_MIX_VOLUME = Number(process.env.BGM_MIX_VOLUME) || 0.38;

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

/** Windows 下 FFmpeg subtitles 滤镜对路径的解析：/ 与盘符冒号转义 */
function toSubtitlePath(absPath) {
    let p = absPath.replace(/\\/g, '/');
    return p.replace(':', '\\:');
}

function formatSrtTime(seconds) {
    const d = new Date(seconds * 1000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss},${ms}`;
}

/** 按标点切句并按字长比例铺到 totalDuration，生成 SRT */
function generateSrtFile(text, totalDuration, outputPath) {
    const segments = text.split(/([，。！？、])/).filter(Boolean);
    let phrases = [];
    for (let i = 0; i < segments.length; i += 2) {
        phrases.push(segments[i] + (segments[i + 1] || ''));
    }
    phrases = phrases.filter((p) => p.trim().length > 0);
    if (phrases.length === 0) {
        const one = (text && String(text).trim()) || ' ';
        phrases = [one];
    }
    const totalChars = phrases.reduce((sum, p) => sum + p.length, 0) || 1;
    let currentTime = 0;
    let srtContent = '';
    phrases.forEach((phrase, index) => {
        const duration = (phrase.length / totalChars) * totalDuration;
        const startTime = formatSrtTime(currentTime);
        currentTime += duration;
        const endTime = formatSrtTime(currentTime);
        srtContent += `${index + 1}\n${startTime} --> ${endTime}\n${phrase.trim()}\n\n`;
    });
    fs.writeFileSync(outputPath, srtContent, 'utf8');
}

/** 用 ffmpeg -i 解析媒体时长（秒），不依赖 ffprobe */
function getMediaDurationSeconds(filePath) {
    const r = spawnSync(
        ffmpegInstaller.path,
        ['-hide_banner', '-i', filePath, '-f', 'null', '-'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    );
    const stderr = r.stderr || '';
    const m = /Duration:\s*(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(stderr);
    if (!m) {
        throw new Error(`无法解析媒体时长: ${filePath}`);
    }
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const sec = m[4] != null && m[4] !== '' ? parseFloat(`${m[3]}.${m[4]}`) : parseFloat(m[3]);
    return h * 3600 + min * 60 + sec;
}

function getMediaDurationSecondsOr(filePath, fallbackSec) {
    try {
        return getMediaDurationSeconds(filePath);
    } catch {
        return fallbackSec;
    }
}

/**
 * 使 atempo 链的乘积等于 r（输出时长 = 输入 / 乘积），从而把 D 秒口播缩放到 T 秒需 r = D/T
 */
function atempoFactorsForRatio(r) {
    const factors = [];
    const EPS = 1e-5;
    while (r > 2 + EPS) {
        factors.push(2);
        r /= 2;
    }
    while (r < 0.5 - EPS) {
        factors.push(0.5);
        r /= 0.5;
    }
    if (r < 1 - EPS || r > 1 + EPS) {
        factors.push(Number(Math.min(2, Math.max(0.5, r)).toFixed(5)));
    }
    return factors;
}

function buildAudioFitFilter(audioDur, targetSec) {
    if (targetSec <= 0) {
        throw new Error('目标视频时长无效');
    }
    if (audioDur <= 0) {
        throw new Error('口播时长无效');
    }
    const r = audioDur / targetSec;
    const parts = [];
    if (Math.abs(r - 1) > 0.005) {
        for (const f of atempoFactorsForRatio(r)) {
            parts.push(`atempo=${f}`);
        }
    }
    parts.push(`atrim=0:${targetSec.toFixed(3)}`);
    parts.push('asetpts=PTS-STARTPTS');
    return parts.join(',');
}

function adjustAudioDurationToFile(audioPath, targetSec, outPath) {
    const audioDur = getMediaDurationSeconds(audioPath);
    const filter = buildAudioFitFilter(audioDur, targetSec);
    return new Promise((resolve, reject) => {
        ffmpeg(audioPath)
            .audioFilters(filter)
            .audioCodec('aac')
            .noVideo()
            .format('ipod')
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .save(outPath);
    });
}

/** 淡出起点：避免片段短于 0.2s 时 st 为负 */
function fadeOutStart(segDurSec) {
    return Math.max(0, segDurSec - 0.2).toFixed(2);
}

/**
 * 高阶渲染（成片时长=画面总长 + 口播/BGM 与画面对齐 + 动态字幕）
 * 口播不拉伸：atrim 到 target；短于画面时 anullsrc+concat 补静音（避免旧 FFmpeg 的 apad=pad_dur 不兼容）。长口播截断。
 * BGM 短于画面则 aloop+atrim 铺满。输出 -t targetSec 固定成片时长。
 */
async function mixThreeClipsAndAudio(hookPath, productPath, scenePath, audioName, bgmName, scriptText, outputName) {
    const hookPathF = toFfmpegPath(hookPath);
    const prodPathF = toFfmpegPath(productPath);
    const scenePathF = toFfmpegPath(scenePath);
    const audioPath = path.join(AUDIO_DIR, audioName);
    const bgmPath = path.join(BGM_DIR, bgmName);
    const outputPath = path.join(OUTPUT_DIR, outputName);
    const tempSrtPath = path.join(OUTPUT_DIR, `temp_${Date.now()}.srt`);

    const hookDur = getMediaDurationSeconds(hookPath);
    const prodDur = getMediaDurationSeconds(productPath);
    const sceneDur = getMediaDurationSeconds(scenePath);
    const targetSec = hookDur + prodDur + sceneDur;
    const tStr = Math.max(0.01, targetSec).toFixed(3);
    const audioDur = getMediaDurationSecondsOr(audioPath, targetSec);
    const bgmDur = getMediaDurationSecondsOr(bgmPath, 9999);

    // 字幕只在成片可见区间内铺：口播与画面等长取 min(口播, 画面)
    const srtVisibleSec = Math.max(0.1, Math.min(audioDur, targetSec));
    generateSrtFile(scriptText, srtVisibleSec, tempSrtPath);
    const srtPathF = toSubtitlePath(tempSrtPath);

    const contrast = (Math.random() * 0.1 + 0.95).toFixed(2);
    const brightness = (Math.random() * 0.04 - 0.02).toFixed(2);
    const saturation = (Math.random() * 0.2 + 0.9).toFixed(2);
    const zoom = (Math.random() * 0.04 + 1.01).toFixed(3);

    const subtitleStyle =
        'FontName=Microsoft YaHei,FontSize=14,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=72';

    const effectiveVoice = Math.min(audioDur, targetSec);
    const voicePadSec = Math.max(0, targetSec - effectiveVoice);
    const needBgmLoop = bgmDur < targetSec - 0.02;

    console.log(
        `   📐 成片以画面为准: ${targetSec.toFixed(2)}s | 口播原长 ${audioDur.toFixed(2)}s` +
            (audioDur > targetSec ? '（超长部分截断）' : voicePadSec > 0.01 ? ` | 口播后垫 BGM ${voicePadSec.toFixed(2)}s` : '')
    );
    console.log(
        `   🎵 BGM ${bgmDur.toFixed(1)}s → ${targetSec.toFixed(1)}s` + (needBgmLoop ? '（循环接满）' : '（直接截断）') + ` 混音增益 ${BGM_MIX_VOLUME}`
    );
    console.log(`   🛡️ 防去重 -> 缩放: ${zoom}x | 对比度: ${contrast} | 亮度: ${brightness} | 饱和度: ${saturation}`);
    console.log('   ⏳ 高阶渲染 (口播+BGM 同长混音 + 动态字幕 + x264) 进行中…');

    const pStr = voicePadSec.toFixed(3);
    // 用 anullsrc+concat 补静音，兼容无 apad=pad_dur 的旧版 FFmpeg
    const voiceGraph =
        voicePadSec >= 0.001
            ? [
                  `[3:a]aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${tStr},aresample=48000[v_c]`,
                  `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${pStr},aformat=sample_fmts=fltp:channel_layouts=stereo[s_pad]`,
                  `[v_c][s_pad]concat=n=2:v=0:a=1[voice_t]`
              ].join(';')
            : `[3:a]aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${tStr},aresample=48000[voice_t]`;

    let bgmChain = `[4:a]aformat=sample_fmts=fltp:channel_layouts=stereo`;
    if (needBgmLoop) {
        bgmChain += ',aloop=loop=-1';
    }
    bgmChain += `,atrim=0:${tStr},aresample=48000,volume=${BGM_MIX_VOLUME}[bgm_t]`;

    const filterComplex = [
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=in:st=0:d=0.2,fade=t=out:st=${fadeOutStart(hookDur)}:d=0.2,format=yuv420p,fps=30[v0]`,
        `[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=in:st=0:d=0.2,fade=t=out:st=${fadeOutStart(prodDur)}:d=0.2,format=yuv420p,fps=30[v1]`,
        `[2:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=in:st=0:d=0.2,fade=t=out:st=${fadeOutStart(sceneDur)}:d=0.2,format=yuv420p,fps=30[v2]`,
        `[v0][v1][v2]concat=n=3:v=1:a=0[concat_v]`,
        `[concat_v]eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation},scale=iw*${zoom}:ih*${zoom},crop=1080:1920,subtitles='${srtPathF}':force_style='${subtitleStyle}'[out_v]`,
        `${voiceGraph};${bgmChain};[voice_t][bgm_t]amix=inputs=2:duration=first[out_a]`
    ].join(';');

    try {
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(hookPathF)
                .input(prodPathF)
                .input(scenePathF)
                .input(audioPath)
                .input(bgmPath)
                .complexFilter(filterComplex)
                .outputOptions([
                    '-map',
                    '[out_v]',
                    '-map',
                    '[out_a]',
                    '-t',
                    tStr,
                    '-c:v',
                    'libx264',
                    '-preset',
                    'fast',
                    '-crf',
                    '23',
                    '-c:a',
                    'aac'
                ])
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .save(outputPath);
        });
    } finally {
        if (fs.existsSync(tempSrtPath)) {
            try {
                fs.unlinkSync(tempSrtPath);
            } catch { /* ignore */ }
        }
    }

    return outputName;
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
                    let scriptText = '夏日出行，防晒神器。';
                    if (fs.existsSync(EXCEL_PATH)) {
                        try {
                            const wb = xlsx.readFile(EXCEL_PATH);
                            const data = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
                            const versionKey = audioName.replace(/\.mp3$/i, '');
                            const row = data.find((r) => r.version === versionKey);
                            if (row) {
                                scriptText = `${row.hook || ''}${row.content || ''}${row.callToAction || ''}`;
                            }
                        } catch (e) {
                            console.error(`   ⚠️ 读取 ${path.basename(EXCEL_PATH)} 失败，使用默认文案: ${e.message}`);
                        }
                    }
                    if (!String(scriptText).trim()) {
                        scriptText = '夏日出行，防晒神器。';
                    }
                    const preview = scriptText.length > 20 ? `${scriptText.slice(0, 20)}...` : scriptText;
                    console.log(`   🎤 匹配音频: [${audioName}]`);
                    console.log(`   📜 提取文案: [${preview}]`);

                    const availableBgms = fs.readdirSync(BGM_DIR).filter((file) => file.endsWith('.mp3'));
                    if (availableBgms.length === 0) {
                        throw new Error('⚠️ bgm_assets 文件夹是空的，请至少放入一首背景音乐！');
                    }
                    const bgmName = availableBgms[Math.floor(Math.random() * availableBgms.length)];
                    console.log(`   🎵 匹配背景音乐: [${bgmName}]`);

                    const hookPath = await resolveCellToVideoPath(hook, 'hook', runKey);
                    const prodPath = await resolveCellToVideoPath(product, 'product', runKey);
                    const scenePath = await resolveCellToVideoPath(scene, 'scene', runKey);

                    await mixThreeClipsAndAudio(hookPath, prodPath, scenePath, audioName, bgmName, scriptText, outputName);
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
