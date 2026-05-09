require('./lib/load-env');
const axios = require('axios');
const client = require('./lib/feishu-client');
const { SPREADSHEET_TOKEN, ANALYTICS_SHEET_ID } = require('./lib/feishu-config');

// 从环境变量读取千川配置
const QC_ADVERTISER_ID = process.env.QC_ADVERTISER_ID;
const QC_ACCESS_TOKEN = process.env.QC_ACCESS_TOKEN;

// 格式化日期工具 (YYYY-MM-DD)
function getYesterdayDateString() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
}

async function fetchQianchuanData() {
    const targetDate = getYesterdayDateString();
    console.log(`📈 [千川雷达] 启动！正在拉取 ${targetDate} 的投放报表...`);

    try {
        // 1. 调用千川素材数据报表 API
        const response = await axios.get('https://ad.oceanengine.com/open_api/v1.0/qianchuan/report/material/get/', {
            headers: {
                'Access-Token': QC_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            },
            params: {
                advertiser_id: QC_ADVERTISER_ID,
                start_date: targetDate,
                end_date: targetDate,
                filtering: {
                    material_type: 'video' // 只看视频素材
                },
                fields: [
                    'material_name',
                    'stat_cost',
                    'play_duration_3s_rate',
                    'click_cnt',
                    'pay_order_count'
                ]
            }
        });

        if (response.data.code !== 0) {
            throw new Error(`千川 API 报错: ${response.data.message}`);
        }

        const materials = response.data.data.list || [];
        if (materials.length === 0) {
            return console.log(`   🤷‍♂️ 昨日 (${targetDate}) 千川后台暂无数据回流。`);
        }

        console.log(`   📊 千川接口返回 ${materials.length} 条视频素材数据，开始清洗过滤...`);

        const newAnalyticsRows = [];

        // 2. 遍历千川数据，清洗出我们的“矩阵视频”
        for (const item of materials) {
            const materialName = item.material_name; // 素材名称
            const metrics = item.metrics; // 数据指标

            // 过滤规则：只处理系统生成的视频（比如名字里带有大类标识或时间戳）
            // 根据之前的脑图，我们的视频命名类似于 "防晒口罩_腮红款_17150000"
            if (!materialName || !materialName.includes('_')) continue;

            // 如果该素材根本没花钱，或者没有展现，跳过
            if (metrics.stat_cost <= 0) continue;

            // 3. 计算核心基因评价指标
            // 3秒完播率 (千川返回的是小数，比如 0.155，我们转成 15.5)
            const playRate = (metrics.play_duration_3s_rate * 100).toFixed(2);

            // 转化率 CVR = 支付订单数 / 点击数
            let cvr = 0;
            if (metrics.click_cnt > 0) {
                cvr = ((metrics.pay_order_count / metrics.click_cnt) * 100).toFixed(2);
            }

            console.log(`   ├─ 锁定目标素材: [${materialName}] | 完播: ${playRate}% | CVR: ${cvr}%`);

            // 推入飞书格式数组: A(视频名), B(完播率), C(CVR), D(状态)
            newAnalyticsRows.push([
                materialName,
                playRate,
                cvr,
                '待评级' // 留给达尔文引擎去处理
            ]);
        }

        if (newAnalyticsRows.length === 0) {
            return console.log(`   ⚠️ 洗盘结束，昨日没有产生消耗的矩阵视频。`);
        }

        // 4. 将清洗后的有效数据写入飞书【运营回流表】
        const analyticsRange = `${ANALYTICS_SHEET_ID}!A:D`;
        const writeRes = await client.request({
            method: 'POST',
            url: `/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values_append`,
            params: { insertDataOption: 'INSERT_ROWS' },
            data: {
                valueRange: {
                    range: analyticsRange,
                    values: newAnalyticsRows
                }
            }
        });

        if (writeRes.code !== 0) {
            throw new Error(`写入飞书失败: ${writeRes.msg}`);
        }

        console.log(`   ✅ 成功将 ${newAnalyticsRows.length} 条有效投放反馈写入飞书！请运行达尔文引擎进行审判。`);

    } catch (error) {
        console.error('❌ 千川数据同步崩溃:', error.message || error);
    }
}

fetchQianchuanData();