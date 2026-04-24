const lark = require('@larksuiteoapi/node-sdk');

// ================= 配置区 =================
// 1. 填入你刚才在开发者后台获取的 App ID 和 App Secret
const APP_ID = 'cli_a96a35099cfb1cc4';
const APP_SECRET = 'wA65X2YOgX9nG1rsUz903bNGrvqGE55N';


// 浏览器打开表格后，地址栏 .../sheets/{token}?sheet={sheetId} → 两段分别填这里（勿手打错 I 与 l）
const SPREADSHEET_TOKEN =
    process.env.FEISHU_SPREADSHEET_TOKEN || 'IzAdsd33RhRZsLtFLjEc3T1Jnkf';
// 当前子表：切到目标工作表后，复制 ?sheet= 后面的 ID（换子表会变）
const SHEET_ID = process.env.FEISHU_SHEET_ID || '084e77';
const CELL_RANGE = process.env.FEISHU_CELL_RANGE || 'A1:F10';

const client = new lark.Client({
    appId: APP_ID,
    appSecret: APP_SECRET,
});
// ==========================================

async function testReadFeishu() {
    console.log("📡 [飞书中枢] 正在呼叫飞书服务器...");

    try {
        // 官方推荐用 sheetId!A1:B2；也可用工作表标题，但 sheetId 更稳（见 sheets-v3 概述）
        const rangeRaw = `${SHEET_ID}!${CELL_RANGE}`;
        const range = encodeURIComponent(rangeRaw);
        console.log(`   (range=${rangeRaw})`);

        const response = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${range}`
        });

        // 判断接口底层是否返回成功
        if (response.code === 0) {
            console.log("✅ [连接成功] 成功攻入飞书数据库！");
            console.log("📊 成功读取到的表格数据如下：");
            // 提取飞书返回的真实数据矩阵
            console.log(response.data.valueRange.values);
        } else {
            console.error("❌ [API 返回报错]:", response.msg);
        }

    } catch (error) {
        console.error("❌ [网络/配置错误] 详细报错信息:");
        console.error(error.message || error);
    }
}

// 扣下扳机
testReadFeishu();