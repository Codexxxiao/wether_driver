const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const xlsx = require('xlsx');

// ================= 配置区 =================
// 女声：zh-CN-XiaoxiaoNeural | 男声：zh-CN-YunxiNeural
const VOICE_NAME = "zh-CN-XiaoxiaoNeural";

const EXCEL_PATH = path.join(__dirname, 'generated_scripts.xlsx');
const AUDIO_DIR = path.join(__dirname, 'audio_assets');

if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

let scriptsData = [];
if (fs.existsSync(EXCEL_PATH)) {
    const workbook = xlsx.readFile(EXCEL_PATH);
    const sheetName = workbook.SheetNames[0];
    const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    scriptsData = rawData.map((row, i) => ({
        version: row.version || `audio_${i}`,
        content: [row.hook, row.content, row.callToAction].filter(Boolean).join(' ')
    }));
} else {
    console.error('⚠️ [致命错误] 未找到 generated_scripts.xlsx！请先运行 content-engine.js。');
    process.exit(1);
}

if (scriptsData.length === 0) {
    console.error('⚠️ [致命错误] generated_scripts.xlsx 中没有脚本行，请先运行 content-engine.js。');
    process.exit(1);
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