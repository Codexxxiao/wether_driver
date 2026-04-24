const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

// ================= 配置区 =================
// 抖音带货最爱用的两个声音：
// 女声：zh-CN-XiaoxiaoNeural (温柔清晰，适合防晒/颜值类)
// 男声：zh-CN-YunxiNeural (阳光活力，适合剧情/极客类)
const VOICE_NAME = "zh-CN-XiaoxiaoNeural";

// 模拟上一步 AI 生成的文案数据 (实际业务中你可以从 JSON 或 Excel 中读取)
const scriptsData = [
    { version: "audio_A", content: "千万别怪我没提醒你！这几天的紫外线简直能把人烤脱皮！不想被晒出红血丝和光老化，出门必须把脸给我捂严实了..." },
    { version: "audio_B", content: "每天早起骑小电驴通勤的姐妹看过来！迎着刺骨的冷风，普通口罩根本不顶用，冷风直往脖子里灌。直到我换了这款..." },
    { version: "audio_C", content: "你去美容院做一次光电项目要多少钱？起码大几千吧！但是今天，一杯奶茶的钱，就能买到硬核的物理防晒屏障..." }
];

// 创建音频存放目录
const AUDIO_DIR = path.join(__dirname, 'audio_assets');
if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
}
// ==========================================

async function generateBatchAudio() {
    console.log("🎙️ [发声器官] 启动！准备合成带货音频...");
    const tts = new MsEdgeTTS();
    try {
        // 设置音频格式和声音模型
        await tts.setMetadata(VOICE_NAME, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

        for (let i = 0; i < scriptsData.length; i++) {
            const item = scriptsData[i];
            const fileName = `${item.version}.mp3`;
            const filePath = path.join(AUDIO_DIR, fileName);

            console.log(`⏳ 正在合成: ${fileName} ...`);

            try {
                // toStream 返回 { audioStream, metadataStream }，必须对 audioStream 写入
                const { audioStream } = tts.toStream(item.content);
                const writable = fs.createWriteStream(filePath);
                await pipeline(audioStream, writable);

                const stat = fs.statSync(filePath);
                if (stat.size === 0) {
                    fs.unlinkSync(filePath);
                    throw new Error('未收到音频数据');
                }

                console.log(`✅ 完成: ${fileName}`);
            } catch (error) {
                if (fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                    } catch {
                        /* ignore */
                    }
                }
                console.error(`❌ 合成 ${fileName} 失败:`, error.message);
            }
        }

        console.log(`\n🎉 [完美交付] 所有音频已生成完毕，请前往 audio_assets 文件夹查收！`);
    } finally {
        tts.close();
    }
}

// 执行批量生成
generateBatchAudio();