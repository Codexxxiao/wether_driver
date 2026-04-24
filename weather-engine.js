const axios = require('axios');
const cron = require('node-cron');

// ================= 配置区 =================
// 新版控制台凭据必须使用「设置 → API Host」（如 https://xxxx.qweatherapi.com）；用错域名会 403 Invalid Host。
// 优先读环境变量 QWEATHER_API_HOST；也可在下方填你的专属 Host（不要末尾 /）。
const QWEATHER_API_HOST_INLINE = 'https://ka78m2r6h7.re.qweatherapi.com';
const QWEATHER_API_HOST = (
    process.env.QWEATHER_API_HOST ||
    QWEATHER_API_HOST_INLINE ||
    'https://devapi.qweather.com'
).replace(/\/$/, '');
const QWEATHER_KEY = process.env.QWEATHER_KEY || '579a94dadeda48e180be9a9280caee5f';
const WECHAT_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=37df5cd7b73c661148ca1ee23b71d55425c9bf859d7cf859a2a8d195e6fd5fa1';

// 你要重点监控的城市 Location ID (可以去和风天气查，比如 101010100 是北京)
const TARGET_CITIES = [
    { name: '北京', id: '101010100' },
    { name: '上海', id: '101020100' },
    { name: '成都', id: '101270101' }
];

// 业务触发阈值 (这才是你的商业核心)
const RULES = {
    UV_DANGER: 7,        // 紫外线指数 >= 7 (极强)，触发防晒口罩投放
    TEMP_DROP: 8,        // 明日降温幅度 >= 8度，触发保暖口罩投放
    TEMP_COLD: 5         // 绝对低温 <= 5度，持续推保暖产品
};
// ==========================================

/**
 * 获取天气数据并进行业务研判
 */
async function checkWeatherAndDecide() {
    console.log(`[${new Date().toLocaleString()}] 开始执行气象监控巡检...`);

    let alertMessages = [];

    for (const city of TARGET_CITIES) {
        try {
            // 获取未来3天天气预报（v7：Header 使用 X-QW-Api-Key，勿与 URL ?key= 混用）
            const weatherRequestUrl = `${QWEATHER_API_HOST}/v7/weather/3d?location=${encodeURIComponent(city.id)}`;
            const response = await axios.get(weatherRequestUrl, {
                headers: { 'X-QW-Api-Key': QWEATHER_KEY },
                decompress: true
            });

            if (response.data.code === '200') {
                const dailyData = response.data.daily;
                const today = dailyData[0];
                const tomorrow = dailyData[1];

                // 1. 数据提取
                const todayUV = parseInt(today.uvIndex);
                const todayMaxTemp = parseInt(today.tempMax);
                const tomorrowMaxTemp = parseInt(tomorrow.tempMax);
                const tomorrowMinTemp = parseInt(tomorrow.tempMin);

                // 2. 计算温差 (今日最高温 - 明日最高温，判断断崖降温)
                const tempDrop = todayMaxTemp - tomorrowMaxTemp;

                // 3. 商业逻辑研判
                let cityAlerts = [];

                // 触发条件 A: 防晒需求爆发
                if (todayUV >= RULES.UV_DANGER || parseInt(tomorrow.uvIndex) >= RULES.UV_DANGER) {
                    cityAlerts.push(`🔥【防晒爆单预警】紫外线指数高达 ${todayUV}！建议立刻开启 ${city.name} 的防晒口罩千川定向投放，或发布防晒短视频。`);
                }

                // 触发条件 B: 保暖需求爆发 (断崖式降温)
                if (tempDrop >= RULES.TEMP_DROP) {
                    cityAlerts.push(`❄️【保暖爆单预警】断崖降温！明日最高温骤降 ${tempDrop}℃ (低至 ${tomorrowMinTemp}℃)！建议主推抓绒/保暖款口罩。`);
                }
                // 触发条件 C: 持续低温保暖需求
                else if (tomorrowMinTemp <= RULES.TEMP_COLD) {
                    cityAlerts.push(`🥶【保暖持续需求】明日最低温 ${tomorrowMinTemp}℃，天气严寒，保暖口罩转化率处于高位。`);
                }

                // 汇总该城市的报警信息
                if (cityAlerts.length > 0) {
                    alertMessages.push(`📍 **${city.name} 市场动态**:\n` + cityAlerts.join('\n'));
                }
            }
        } catch (error) {
            const apiError = error.response?.data;
            const invalidHost =
                error.response?.status === 403 &&
                (apiError?.error?.title === 'Invalid Host' ||
                    String(apiError?.error?.detail || '').includes('API Host'));
            if (invalidHost) {
                console.error(
                    `获取 ${city.name} 天气失败: 当前 QWEATHER_API_HOST=${QWEATHER_API_HOST} 与凭据不匹配。请在和风控制台「设置」复制 API Host，设置环境变量 QWEATHER_API_HOST 后重试。`
                );
            } else {
                console.error(`获取 ${city.name} 天气失败:`, error.message, apiError != null ? apiError : '');
            }
        }
    }

    // 4. 发送触达通知
    if (alertMessages.length > 0) {
        const finalMessage = "📢 **气象电商系统提示**\n\n" + alertMessages.join('\n\n') + "\n\n💡 *系统提示：趁着极端天气未到达前抢量，转化成本最低。去行动吧！*";
        await sendDingTalkAlert(finalMessage);
    } else {
        console.log("今日气象平稳，无需特殊投放动作。");
    }
}

/**
 * 推送报警到企业微信/钉钉
 */
async function sendWechatAlert(content) {
    try {
        await axios.post(WECHAT_WEBHOOK, {
            msgtype: 'markdown',
            markdown: {
                content: content
            }
        });
        console.log("✅ 预警消息推送成功！");
    } catch (error) {
        console.error("❌ 推送消息失败:", error.message);
    }
}

/**
 * 推送报警到钉钉
 */
async function sendDingTalkAlert(content) {
    try {
        await axios.post(WECHAT_WEBHOOK, { // 把你在顶部定义的 Webhook 变量名放这里
            msgtype: 'markdown',
            markdown: {
                title: '气象爆单预警',  // 钉钉必填项，手机通知栏显示的标题
                text: content        // 具体的报警内容
            }
        });
        console.log("✅ 钉钉预警消息推送成功！");
    } catch (error) {
        console.error("❌ 推送消息失败:", error.message);
    }
}

// ================= 定时任务 =================
// 设定在每天早晨 07:30 自动运行，给你足够的时间在上播或早高峰前调整千川计划
cron.schedule('30 7 * * *', () => {
    checkWeatherAndDecide();
});


console.log("🚀 气象驱动引擎已启动，监控运行中...");
// 启动时先强制执行一次测试连通性
checkWeatherAndDecide();