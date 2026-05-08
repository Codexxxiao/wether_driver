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

/** full = 口播+BGM+字幕 | clips_only = 仅五段画面拼接，保留各段素材原声 */
const RENDER_MODE = (process.env.RENDER_MODE || 'full').trim().toLowerCase();
const IS_CLIPS_ONLY = RENDER_MODE === 'clips_only';

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

/** 是否含至少一路音频流（无音轨的片段在纯混剪模式下会补静音，避免 concat 失败） */
function fileHasAudioStream(filePath) {
    const r = spawnSync(
        ffmpegInstaller.path,
        ['-hide_banner', '-i', filePath],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    );
    return /Stream\s+#\d+:\d+.*Audio:/m.test(r.stderr || '');
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
async function mixFiveClipsAndAudio(hookPath, painPath, proofPath, benefitPath, ctaPath, audioName, bgmName, scriptText, outputName) {
    const hookPathF = toFfmpegPath(hookPath);
    const painPathF = toFfmpegPath(painPath);
    const proofPathF = toFfmpegPath(proofPath);
    const benefitPathF = toFfmpegPath(benefitPath);
    const ctaPathF = toFfmpegPath(ctaPath);

    const audioPath = path.join(AUDIO_DIR, audioName);
    const bgmPath = path.join(BGM_DIR, bgmName);
    const outputPath = path.join(OUTPUT_DIR, outputName);
    const tempSrtPath = path.join(OUTPUT_DIR, `temp_${Date.now()}.srt`);

    // 1. 获取 5 段视频的各自时长
    const durHook = getMediaDurationSeconds(hookPath);
    const durPain = getMediaDurationSeconds(painPath);
    const durProof = getMediaDurationSeconds(proofPath);
    const durBenefit = getMediaDurationSeconds(benefitPath);
    const durCta = getMediaDurationSeconds(ctaPath);
    const targetSec = durHook + durPain + durProof + durBenefit + durCta;

    const audioDur = getMediaDurationSeconds(audioPath) || targetSec;
    generateSrtFile(scriptText, audioDur, tempSrtPath);
    const srtPathF = toSubtitlePath(tempSrtPath);

    // 防去重隐形微调
    const contrast = (Math.random() * 0.1 + 0.95).toFixed(2);
    const brightness = (Math.random() * 0.04 - 0.02).toFixed(2);
    const saturation = (Math.random() * 0.2 + 0.9).toFixed(2);
    const zoom = (Math.random() * 0.04 + 1.01).toFixed(3);

    console.log(`   ⏳ 正在进行 5 段式高阶渲染 (黑闪转场 + BGM贯穿全片 + 动态字幕)...`);

    const subtitleStyle = "FontName=Microsoft YaHei,FontSize=22,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=150";

    // 构建极为复杂的 5 轨视音频混合网络 (Filter Complex)
    const filterComplex = [
        // 首段(Hook)不做片头 fade-in，避免成片第 1 帧纯黑导致平台封面黑屏；其余段保留黑场切入
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=out:st=${(durHook - 0.2).toFixed(2)}:d=0.2,format=yuv420p,fps=30[v0]`,
        `[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=in:st=0:d=0.2,fade=t=out:st=${(durPain - 0.2).toFixed(2)}:d=0.2,format=yuv420p,fps=30[v1]`,
        `[2:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=in:st=0:d=0.2,fade=t=out:st=${(durProof - 0.2).toFixed(2)}:d=0.2,format=yuv420p,fps=30[v2]`,
        `[3:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=in:st=0:d=0.2,fade=t=out:st=${(durBenefit - 0.2).toFixed(2)}:d=0.2,format=yuv420p,fps=30[v3]`,
        `[4:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fade=t=in:st=0:d=0.2,fade=t=out:st=${(durCta - 0.2).toFixed(2)}:d=0.2,format=yuv420p,fps=30[v4]`,

        // 拼接 5 段视频
        `[v0][v1][v2][v3][v4]concat=n=5:v=1:a=0[concat_v]`,

        // 视频后期微调与字幕烧录
        `[concat_v]eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation},scale=iw*${zoom}:ih*${zoom},crop=1080:1920,subtitles='${srtPathF}':force_style='${subtitleStyle}'[out_v]`,

        // 音频混音：主口播 [5:a] + 压低音量的 BGM [6:a]，以最长的轨(duration=longest)为准
        `[6:a]volume=0.15[bgm];[5:a][bgm]amix=inputs=2:duration=longest:dropout_transition=2[out_a]`
    ].join(';');

    try {
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(hookPathF)     // [0]
                .input(painPathF)     // [1]
                .input(proofPathF)    // [2]
                .input(benefitPathF)  // [3]
                .input(ctaPathF)      // [4]
                .input(audioPath)     // [5:a]
                .input(bgmPath)       // [6:a]
                .complexFilter(filterComplex)
                .outputOptions([
                    '-map [out_v]',
                    '-map [out_a]',
                    '-c:v libx264',
                    '-preset fast',
                    '-crf 23',
                    '-c:a aac',
                    '-shortest'        // 视频在画面结束时精准切断
                ])
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .save(outputPath);
        });
    } finally {
        if (fs.existsSync(tempSrtPath)) fs.unlinkSync(tempSrtPath);
    }

    return outputName;
}

/**
 * 纯混剪：五段视频与各自原声对齐拼接（无口播、无 BGM、无字幕），无音轨的片段补Stereo静音以兼容 concat
 */
async function mixFiveClipsNativeAudio(hookPath, painPath, proofPath, benefitPath, ctaPath, outputName) {
    const paths = [hookPath, painPath, proofPath, benefitPath, ctaPath];
    const pathsF = paths.map(toFfmpegPath);
    const durs = paths.map((p) => getMediaDurationSeconds(p));
    const hasAudio = paths.map(fileHasAudioStream);

    const contrast = (Math.random() * 0.1 + 0.95).toFixed(2);
    const brightness = (Math.random() * 0.04 - 0.02).toFixed(2);
    const saturation = (Math.random() * 0.2 + 0.9).toFixed(2);
    const zoom = (Math.random() * 0.04 + 1.01).toFixed(3);

    console.log('   ⏳ 纯混剪渲染（保留原声、无字幕口播BGM）...');
    const videoFilters = durs.map((d, i) => {
        const outSt = Math.max(0, d - 0.2).toFixed(2);
        const base = `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`;
        const tail = `fade=t=out:st=${outSt}:d=0.2,format=yuv420p,fps=30[v${i}]`;
        if (i === 0) {
            return `${base},${tail}`;
        }
        return `${base},fade=t=in:st=0:d=0.2,${tail}`;
    });

    const audioFilters = [];
    for (let i = 0; i < 5; i++) {
        const d = durs[i];
        const dStr = d.toFixed(3);
        const st = fadeOutStart(d);
        if (hasAudio[i]) {
            const afIn = i === 0 ? '' : 'afade=t=in:st=0:d=0.2,';
            audioFilters.push(
                `[${i}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,aresample=44100,${afIn}afade=t=out:st=${st}:d=0.2,atrim=0:${dStr},asetpts=PTS-STARTPTS[a${i}]`
            );
        } else {
            console.log(`   🔇 片段 [${i}] 无音频轨，本段将输出静音以对齐画面`);
            const afIn = i === 0 ? '' : 'afade=t=in:st=0:d=0.2,';
            audioFilters.push(
                `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${dStr},asetpts=PTS-STARTPTS,${afIn}afade=t=out:st=${st}:d=0.2,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
            );
        }
    }

    const filterComplex = [
        ...videoFilters,
        ...audioFilters,
        '[v0][v1][v2][v3][v4]concat=n=5:v=1:a=0[concat_v]',
        '[a0][a1][a2][a3][a4]concat=n=5:v=0:a=1[concat_a]',
        `[concat_v]eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation},scale=iw*${zoom}:ih*${zoom},crop=1080:1920[out_v]`
    ].join(';');

    const outputPath = path.join(OUTPUT_DIR, outputName);
    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(pathsF[0])
            .input(pathsF[1])
            .input(pathsF[2])
            .input(pathsF[3])
            .input(pathsF[4])
            .complexFilter(filterComplex)
            .outputOptions([
                '-map [out_v]',
                '-map [concat_a]',
                '-c:v libx264',
                '-preset fast',
                '-crf 23',
                '-c:a aac',
                '-b:a 192k'
            ])
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .save(outputPath);
    });

    return outputName;
}
/**
 * 飞书回传：E 列状态 + F 列（纯文本，或上传素材后的可点击链接：官方 v2 不支持直接写附件对象，用 type:url）
 */
async function updateFeishuStatus(rowIndex, status, fColumn) {
    const actualRow = rowIndex + 1;
    const rangeRaw = `${SHEET_ID}!G${actualRow}:H${actualRow}`;

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
    console.log(`   ⚙️ RENDER_MODE=${IS_CLIPS_ONLY ? 'clips_only（纯混剪·原声）' : 'full（口播+BGM+字幕）'}`);

    try {
        // 须含 G「状态」、H「成片」；仅 A–F 时读不到「待生成」，无法触发渲染
        const range = encodeURIComponent(`${SHEET_ID}!A1:H50`);
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

            const videoName = row[0];
            const hook = row[1];
            const pain = row[2];
            const proof = row[3];
            const benefit = row[4];
            const cta = row[5];
            const status = row[6];
            const statusStr = typeof status === 'string' ? status.trim() : String(status ?? '');

            if (statusStr === '待生成') {
                const runKey = `${String(videoName).replace(/[^\w\u4e00-\u9fa5-]/g, '_')}_${i}_${Date.now()}`;
                console.log(`\n===========================================`);
                console.log(`🎬 发现新任务: [${videoName}]`);

                const outputName = `${videoName}_成片.mp4`;

                try {
                    const hookPath = await resolveCellToVideoPath(hook, 'hook', runKey);
                    const painPath = await resolveCellToVideoPath(pain, 'pain', runKey);
                    const proofPath = await resolveCellToVideoPath(proof, 'proof', runKey);
                    const benefitPath = await resolveCellToVideoPath(benefit, 'benefit', runKey);
                    const ctaPath = await resolveCellToVideoPath(cta, 'cta', runKey);

                    if (IS_CLIPS_ONLY) {
                        await mixFiveClipsNativeAudio(hookPath, painPath, proofPath, benefitPath, ctaPath, outputName);
                    } else {
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
                                const scriptRow = data.find((r) => r.version === versionKey);
                                if (scriptRow) {
                                    scriptText = `${scriptRow.hook || ''}${scriptRow.content || ''}${scriptRow.callToAction || ''}`;
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

                        await mixFiveClipsAndAudio(hookPath, painPath, proofPath, benefitPath, ctaPath, audioName, bgmName, scriptText, outputName);
                    }
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
