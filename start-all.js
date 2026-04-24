require('./lib/load-env');

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const axios = require('axios');

/** 环境变量 FEISHU_WEBHOOK_URL 配置群机器人 Webhook；未配置则跳过推送 */
async function sendFeishuNotify(content) {
    const webhookUrl = (process.env.FEISHU_WEBHOOK_URL || '').trim();
    if (!webhookUrl) {
        return;
    }
    try {
        await axios.post(
            webhookUrl,
            {
                msg_type: 'text',
                content: { text: `矩阵工厂通知：\n${content}` }
            },
            {
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 15000
            }
        );
    } catch (err) {
        console.error('飞书通知发送失败:', err.message || err);
    }
}

function writeLog(message) {
    const timestamp = new Date().toLocaleString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(path.join(__dirname, 'production.log'), logMessage);
}

async function runEngine(name, scriptPath) {
    const absScript = path.join(__dirname, scriptPath);
    writeLog(`[启动] ${name} → ${scriptPath}`);
    console.log(`\n🚀 [总控中心] 正在启动模块: ${name}...`);
    try {
        execSync(`node "${absScript}"`, { stdio: 'inherit', cwd: __dirname });
        writeLog(`[完成] ${name}`);
        console.log(`✅ [${name}] 运行结束。`);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        writeLog(`[失败] ${name}: ${detail}`);
        console.error(`❌ [${name}] 运行出错，流程中断！请检查报错。`);
        await sendFeishuNotify(`[失败] 模块：${name}\n脚本：${scriptPath}\n原因：${detail}`);
        process.exit(1);
    }
}

async function main() {
    writeLog('======== 气象驱动分发引擎 V1.0 流水线开始 ========');
    console.log('==========================================');
    console.log('🌟 气象驱动分发引擎 V1.0 - 全自动流水线启动');
    console.log('==========================================');

    await runEngine('AI 编剧中心', 'content-engine.js');
    await runEngine('AI 配音工厂', 'audio-engine.js');

    await runEngine('达尔文进化引擎', 'evolution-engine.js');
    await runEngine('繁衍中枢', 'brain-engine.js');
    await runEngine('自动化渲染工厂', 'auto-director.js');

    writeLog('======== 全线完工：各模块已顺序执行完毕 ========');
    console.log('\n🎊 [全线完工] 今日份视频已全部产出并登记在飞书，请查收！');
}

main().catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    writeLog(`[主流程异常] ${msg}`);
    console.error('主流程异常:', msg);
    await sendFeishuNotify(`[主流程异常]\n${msg}`);
    process.exit(1);
});
