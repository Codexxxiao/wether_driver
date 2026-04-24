const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const cfg = require('./feishu-config');

let cachedTenantToken = { token: null, expireAt: 0 };

async function getTenantAccessToken() {
    if (cachedTenantToken.token && Date.now() < cachedTenantToken.expireAt) {
        return cachedTenantToken.token;
    }
    const res = await axios.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        { app_id: cfg.APP_ID, app_secret: cfg.APP_SECRET },
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
    const d = res.data;
    if (d.code !== 0) {
        throw new Error(d.msg || '获取 tenant_access_token 失败');
    }
    const ttlSec = typeof d.expire === 'number' ? d.expire : 7000;
    cachedTenantToken = {
        token: d.tenant_access_token,
        expireAt: Date.now() + Math.max(60, ttlSec - 120) * 1000
    };
    return cachedTenantToken.token;
}

/**
 * 本地视频 → 当前电子表格素材（≤20MB）
 * @returns {Promise<string>} file_token
 */
async function uploadVideoToSheetMedia(localFilePath, displayFileName) {
    const stat = fs.statSync(localFilePath);
    if (stat.size > 20971520) {
        throw new Error('成片超过 20MB，无法用 upload_all，请压缩或改分片上传');
    }
    const token = await getTenantAccessToken();
    const form = new FormData();
    form.append('file_name', displayFileName);
    form.append('parent_type', 'sheet_file');
    form.append('parent_node', cfg.SPREADSHEET_TOKEN);
    form.append('size', String(stat.size));
    form.append('file', fs.createReadStream(localFilePath));

    const up = await axios.post('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', form, {
        headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${token}`
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });
    const body = up.data;
    if (body.code !== 0) {
        throw new Error(body.msg || 'upload_all 失败');
    }
    const fileToken = body.data?.file_token;
    if (!fileToken) {
        throw new Error('upload_all 未返回 file_token');
    }
    return fileToken;
}

module.exports = {
    getTenantAccessToken,
    uploadVideoToSheetMedia
};
