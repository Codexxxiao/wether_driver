const lark = require('@larksuiteoapi/node-sdk');
const cfg = require('./feishu-config');

module.exports = new lark.Client({ appId: cfg.APP_ID, appSecret: cfg.APP_SECRET });
