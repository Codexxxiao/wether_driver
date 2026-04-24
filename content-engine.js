const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const OpenAI = require('openai');

// ================= 配置区 =================
// 这里以 DeepSeek 为例，如果你用其他大模型，改一下 baseURL 和 apiKey 即可
const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-f69d63f052c04bbd87df2ceca6933080' // 替换为你的真实 Key
});

// 你存放竞品原爆款文案的源文件
const SOURCE_FILE = path.join(__dirname, 'source_scripts.txt');
const OUTPUT_EXCEL = path.join(__dirname, 'generated_scripts.xlsx');

// 你的核心商业 Prompt
const SYSTEM_PROMPT = `
你是一位年GMV过亿的抖音千川投放总监。请将用户输入的【竞品爆款文案】进行拆解重组。
要求生成 3 个版本的【极短】视频脚本，必须严格控制总字数在 60-65 字以内（口播时长控制在 8-9 秒）：
版本A（恐吓拉扯型）：放大不戴口罩的严重后果（1句话）。
版本B（场景代入型）：设定具体生活场景引发共鸣（1句话）。
版本C（算账省钱型）：对比防晒霜/医美的成本（1句话）。

必须严格返回 JSON 格式，结构如下：
[
  { "version": "版本A", "hook": "前3秒钩子", "content": "正文话术", "callToAction": "逼单话术" },
  { "version": "版本B", "hook": "前3秒钩子", "content": "正文话术", "callToAction": "逼单话术" },
  { "version": "版本C", "hook": "前3秒钩子", "content": "正文话术", "callToAction": "逼单话术" }
]
注意：这三部分合并起来的总字数绝对不能超过 65 个字！除了 JSON 数组，不要输出任何其他废话。
`;

/**
 * 解析模型输出为脚本数组（支持裸数组、markdown 代码块、或 { scripts: [] } 包装）
 */
function parseScriptsJson(resultText) {
    let raw = String(resultText ?? '').trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
        raw = fence[1].trim();
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (parsed && Array.isArray(parsed.scripts)) {
        return parsed.scripts;
    }
    if (parsed && Array.isArray(parsed.data)) {
        return parsed.data;
    }
    throw new Error('模型返回格式异常：需要 JSON 数组或 { "scripts": [...] }');
}
// ==========================================

async function generateScripts() {
    console.log("🚀 [内容工厂] 启动！开始读取源文案...");

    // 1. 读取原稿
    if (!fs.existsSync(SOURCE_FILE)) {
        fs.writeFileSync(SOURCE_FILE, "请输入你抄来的爆款文案...", 'utf8');
        console.log("⚠️ 请先在 source_scripts.txt 中填入你的源文案！");
        return;
    }
    const sourceText = fs.readFileSync(SOURCE_FILE, 'utf8').trim();
    if (!sourceText) return console.log("⚠️ 源文件为空！");

    console.log("🧠 正在调用 AI 大脑进行降维拆解与变异重组...");

    try {
        // 2. 调用大模型 API
        const response = await openai.chat.completions.create({
            model: 'deepseek-chat', // 使用的模型名称
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: `待重写文案：\n${sourceText}` }
            ],
            temperature: 0.8 // 稍微高一点，让文案更有创意
        });

        const resultText = response.choices[0].message.content;
        const scriptsArray = parseScriptsJson(resultText);

        // 3. 将结果写入 Excel
        saveToExcel(scriptsArray);

        // 4. (预留) 语音合成接口调用
        // await generateAudio(scriptsArray);

    } catch (error) {
        console.error("❌ 内容生成失败:", error.message);
    }
}

/**
 * 自动化导出表格
 */
function saveToExcel(data) {
    // 将 JSON 数据转换为 Excel 工作表
    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "裂变脚本库");

    // 保存文件
    xlsx.writeFile(workbook, OUTPUT_EXCEL);
    console.log(`✅ [完美闭环] 成功裂变 ${data.length} 套新脚本，已存入 ${OUTPUT_EXCEL}`);
}

// 运行程序
generateScripts();