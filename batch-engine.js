const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const path = require('path');
const fs = require('fs');

// ================= 配置区 =================
const ASSETS_DIR = path.join(__dirname, 'assets');
const AUDIO_DIR = path.join(__dirname, 'audio_assets');
const OUTPUT_DIR = path.join(__dirname, 'output');

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}
// ==========================================

// 将 FFmpeg 的回调地狱封装成 Promise，为了让电脑能“排队”渲染，不至于瞬间卡死
function renderVideo(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoPath)
            .input(audioPath)
            .outputOptions([
                '-map 0:v:0',
                '-map 1:a:0',
                '-c:v copy',  // 依然是核心杠杆：不重新编码画面，光速出片
                '-c:a aac',
                '-shortest'
            ])
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}

async function startBatchProcess() {
    console.log("🏭 [黑灯工厂 V2.0] 启动！开始扫描物料仓库...\n");

    // 1. 自动读取并过滤所有的视频和音频素材
    // 只认 .mp4 和 .mp3，自动忽略隐藏文件或其他杂音文件
    const videos = fs.readdirSync(ASSETS_DIR).filter(file => file.endsWith('.mp4'));
    const audios = fs.readdirSync(AUDIO_DIR).filter(file => file.endsWith('.mp3'));

    if (videos.length === 0) return console.error("❌ 错误：assets 文件夹里没有任何 .mp4 视频！");
    if (audios.length === 0) return console.error("❌ 错误：audio_assets 文件夹里没有任何 .mp3 配音！");

    console.log(`📊 资源清点完毕: 发现 ${videos.length} 个视频画面, ${audios.length} 个配音剧本。`);
    console.log(`⚙️ 即将开始矩阵裂变生成...\n`);

    // 2. 遍历所有配音，给每个配音随机匹配一个画面
    for (let i = 0; i < audios.length; i++) {
        const audioFileName = audios[i];

        // 随机抽取一个视频素材的魔法逻辑
        const randomVideoIndex = Math.floor(Math.random() * videos.length);
        const videoFileName = videos[randomVideoIndex];

        const audioPath = path.join(AUDIO_DIR, audioFileName);
        const videoPath = path.join(ASSETS_DIR, videoFileName);

        // 动态生成成片名字：例如 "成片_audio_A.mp4"
        const outputFileName = `成片_${audioFileName.replace('.mp3', '')}.mp4`;
        const outputPath = path.join(OUTPUT_DIR, outputFileName);

        console.log(`[${i + 1}/${audios.length}] 正在合成: ${outputFileName}`);
        console.log(`   ├─ 选用画面: ${videoFileName}`);
        console.log(`   └─ 选用配音: ${audioFileName}`);

        try {
            // await 会让代码乖乖等这条视频渲染完，再进行下一条
            await renderVideo(videoPath, audioPath, outputPath);
            console.log(`   ✅ 渲染完成！\n`);
        } catch (error) {
            console.error(`   ❌ 渲染失败: ${error.message}\n`);
        }
    }

    console.log("🎉 [流水线停机] 所有任务执行完毕！请前往 output 文件夹查收你的视频矩阵。");
}

// 扣下扳机
startBatchProcess();