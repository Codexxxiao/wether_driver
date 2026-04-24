const client = require('./feishu-client');

async function getMediaTmpDownloadUrl(fileToken) {
    const res = await client.request({
        method: 'GET',
        url: '/open-apis/drive/v1/medias/batch_get_tmp_download_url',
        params: { file_tokens: fileToken }
    });
    if (res.code !== 0) {
        throw new Error(res.msg || 'batch_get_tmp_download_url failed');
    }
    const url = res.data?.tmp_download_urls?.[0]?.tmp_download_url;
    if (!url) {
        throw new Error('未返回 tmp_download_url');
    }
    return url;
}

module.exports = { getMediaTmpDownloadUrl };
