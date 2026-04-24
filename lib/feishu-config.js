require('./load-env');

function env(key, fallback) {
    const v = process.env[key];
    if (v == null || String(v).trim() === '') return fallback;
    return String(v).trim();
}

module.exports = {
    APP_ID: env('FEISHU_APP_ID', 'cli_a96a35099cfb1cc4'),
    APP_SECRET: env('FEISHU_APP_SECRET', 'wA65X2YOgX9nG1rsUz903bNGrvqGE55N'),
    SPREADSHEET_TOKEN: env('FEISHU_SPREADSHEET_TOKEN', 'IzAdsd33RhRZsLtFLjEc3T1Jnkf'),
    ASSETS_SHEET_ID: env('FEISHU_ASSETS_SHEET_ID', '084e77'),
    TASKS_SHEET_ID: env('FEISHU_TASKS_SHEET_ID', 'r4N3MD'),
    ANALYTICS_SHEET_ID: env('FEISHU_ANALYTICS_SHEET_ID', '0cHCCA')
};
