const ffmpeg = require('fluent-ffmpeg');
// 👇 引入自带的 ffmpeg 引擎，完美绕过 Windows 环境变量配置
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const path = require('path');
const fs = require('fs');

// ================= 配置区 =================
// 与 audio-engine 输出一致：audio_assets/audio_A.mp3
const VIDEO_INPUT = path.join(__dirname, 'assets', 'mute_model.mp4');
const AUDIO_INPUT = path.join(__dirname, 'audio_assets', 'audio_A.mp3');

const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
const OUTPUT_FILE = path.join(__dirname, 'output', 'final_version_A.mp4');
// ==========================================

function mixVideoAndAudio() {
    console.log("🎬 [工业剪辑台] 启动！开始调用 FFmpeg 底层引擎...");
    console.log("⏳ 正在进行音视频轨道的像素级对齐...");

    ffmpeg()
        .input(VIDEO_INPUT)
        .input(AUDIO_INPUT)
        .outputOptions([
            '-map 0:v:0',    // 提取第一个输入的视频流
            '-map 1:a:0',    // 提取第二个输入的音频流
            '-c:v copy',     // ⚠️【核心杠杆】视频直接复制，不重新编码！速度提升百倍！
            '-c:a aac',      // 音频转码为短视频标准的 AAC 格式
            '-shortest'      // ⚠️【核心逻辑】以最短的那个流（即你的配音长度）为准，自动一刀切断视频
        ])
        .on('start', function (commandLine) {
            console.log('🔧 底层命令执行中...\n');
        })
        .on('error', function (err) {
            console.error('❌ 渲染失败: ' + err.message);
        })
        .on('end', function () {
            console.log(`\n🎉 [完美闭环] 视频渲染瞬间完成！`);
            console.log(`📂 成片已静默输出至: ${OUTPUT_FILE}`);
            console.log(`🚀 现在，你可以直接把这个视频上传抖音并开启千川计划了。`);
        })
        .save(OUTPUT_FILE);
}

// 运行前的严谨性检查
if (!fs.existsSync(VIDEO_INPUT)) {
    console.error(`\n⚠️ 致命错误: 找不到视频素材`);
    console.error(`👉 请将无声视频放到: ${path.join('assets', 'mute_model.mp4')}（相对项目根目录）`);
} else if (!fs.existsSync(AUDIO_INPUT)) {
    console.error(`\n⚠️ 致命错误: 找不到音频素材`);
    console.error(`👉 请先运行 audio-engine 生成配音，或确认存在: audio_assets/audio_A.mp3`);
} else {
    // 扣下扳机，开始合成
    mixVideoAndAudio();
}