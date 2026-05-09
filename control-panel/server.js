/**
 * 本地控制小站：仅监听 127.0.0.1，切换 RENDER_MODE、浏览白名单目录、触发常用脚本。
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const PUBLIC_DIR = path.join(__dirname, 'public');

const ROOTS = {
    assets: path.join(PROJECT_ROOT, 'assets'),
    audio_assets: path.join(PROJECT_ROOT, 'audio_assets'),
    bgm_assets: path.join(PROJECT_ROOT, 'bgm_assets'),
    output: path.join(PROJECT_ROOT, 'output')
};

for (const dir of Object.values(ROOTS)) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const ALLOWED_SCRIPTS = {
    'start:all': { file: 'start-all.js', label: '全线流水线 start-all' },
    'feishu:v3': { file: 'feishu-engine.js', label: '矩阵混剪 (feishu-engine)' },
    brain: { file: 'brain-engine.js', label: '繁衍中枢 (brain-engine)' },
    evolution: { file: 'evolution-engine.js', label: '达尔文进化' }
};

function safeResolveRootDir(rootKey) {
    const base = ROOTS[rootKey];
    if (!base || !fs.existsSync(base)) return null;
    return path.resolve(base);
}

function safeResolveUnderRoot(rootKey, relativePath) {
    const base = safeResolveRootDir(rootKey);
    if (!base) return null;
    const rel = typeof relativePath === 'string' ? relativePath.replace(/^[/\\]+/, '') : '';
    const target = path.resolve(base, rel);
    const baseNorm = base + path.sep;
    if (!target.startsWith(baseNorm) && target !== base) return null;
    return target;
}

const UPLOAD_MAX_BYTES = Number(process.env.CONTROL_PANEL_UPLOAD_MB || 800) * 1024 * 1024;
const UPLOAD_MAX_FILES = Number(process.env.CONTROL_PANEL_MAX_FILES || 50) || 50;

const uploadStorage = multer.diskStorage({
    destination(req, _file, cb) {
        const rootKey = String(req.body.root || 'assets');
        const subPath = String(req.body.path || '');
        const dir = safeResolveUnderRoot(rootKey, subPath);
        if (!dir) {
            cb(new Error('无效的上传路径'));
            return;
        }
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const st = fs.statSync(dir);
            if (!st.isDirectory()) {
                cb(new Error('目标不是目录'));
                return;
            }
        } catch (e) {
            cb(new Error(`无法创建或访问目录: ${e.message || e}`));
            return;
        }
        cb(null, dir);
    },
    filename(_req, file, cb) {
        const raw = (file.originalname && String(file.originalname)) || 'file';
        const base = path.basename(raw).replace(/[/\\?*:|"<>]/g, '_') || `upload_${Date.now()}`;
        cb(null, base);
    }
});

const upload = multer({
    storage: uploadStorage,
    limits: { fileSize: UPLOAD_MAX_BYTES, files: UPLOAD_MAX_FILES }
});

const FILTER_ENV_KEYS = {
    brainCategory: 'BRAIN_ONLY_CATEGORY',
    brainStyle: 'BRAIN_ONLY_STYLE',
    feishuCategory: 'FEISHU_ONLY_CATEGORY',
    feishuStyle: 'FEISHU_ONLY_STYLE'
};

function readEnvLineValue(text, key) {
    const re = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm');
    const m = re.exec(text);
    if (!m) return '';
    let v = (m[1] != null ? String(m[1]) : '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
    }
    return v.trim();
}

function removeEnvKeyLine(text, key) {
    return text.replace(new RegExp(`^${key}\\s*=.*(?:\\r?\\n|$)`, 'm'), '');
}

function setOrRemoveEnvLine(text, key, value) {
    const v = value != null ? String(value).trim() : '';
    let next = removeEnvKeyLine(text, key);
    if (!v) return next.replace(/\n{3,}/g, '\n\n');
    const line = `${key}=${v}`;
    const re = new RegExp(`^${key}\\s*=.*$`, 'm');
    if (re.test(next)) {
        return next.replace(re, line);
    }
    return `${next.replace(/\s*$/, '')}\n${line}\n`;
}

function readRenderMode() {
    if (!fs.existsSync(ENV_PATH)) {
        return { renderMode: 'full', envExists: false };
    }
    const text = fs.readFileSync(ENV_PATH, 'utf8');
    const m = /^RENDER_MODE\s*=\s*(\S+)/m.exec(text);
    const v = (m && m[1] ? m[1] : 'full').trim().toLowerCase();
    const renderMode = v === 'clips_only' ? 'clips_only' : 'full';
    return { renderMode, envExists: true };
}

function readFilterSettingsFromText(text) {
    const brainOnlyCategory = readEnvLineValue(text, FILTER_ENV_KEYS.brainCategory);
    const brainOnlyStyle = readEnvLineValue(text, FILTER_ENV_KEYS.brainStyle);
    const feishuOnlyCategory = readEnvLineValue(text, FILTER_ENV_KEYS.feishuCategory);
    const feishuOnlyStyle = readEnvLineValue(text, FILTER_ENV_KEYS.feishuStyle);
    return {
        brainOnlyCategory,
        brainOnlyStyle,
        feishuOnlyCategory,
        feishuOnlyStyle,
        brainFilterEnabled: !!(brainOnlyCategory || brainOnlyStyle),
        feishuFilterEnabled: !!(feishuOnlyCategory || feishuOnlyStyle)
    };
}

function writeRenderMode(mode) {
    if (mode !== 'full' && mode !== 'clips_only') {
        throw new Error('RENDER_MODE 只能是 full 或 clips_only');
    }
    if (!fs.existsSync(ENV_PATH)) {
        throw new Error('未找到 .env，请先复制 .env.example 为并按说明填好');
    }
    let text = fs.readFileSync(ENV_PATH, 'utf8');
    const line = `RENDER_MODE=${mode}`;
    if (/^RENDER_MODE\s*=/m.test(text)) {
        text = text.replace(/^RENDER_MODE\s*=.*$/m, line);
    } else {
        text = `${text.replace(/\s*$/, '')}\n\n${line}\n`;
    }
    fs.writeFileSync(ENV_PATH, text, 'utf8');
}

function assertEnvFile() {
    if (!fs.existsSync(ENV_PATH)) {
        throw new Error('未找到 .env，请先复制 .env.example 为并按说明填好');
    }
}

/** 扫描 assets 下「大类→款式」两级子目录，与素材库目录结构一致 */
function scanAssetsCatalog() {
    const assetsDir = ROOTS.assets;
    const catalog = {};
    if (!fs.existsSync(assetsDir)) return catalog;
    const cats = fs.readdirSync(assetsDir, { withFileTypes: true }).filter(
        (d) => d.isDirectory() && d.name && !d.name.startsWith('.')
    );
    for (const d of cats) {
        const catPath = path.join(assetsDir, d.name);
        try {
            const styles = fs
                .readdirSync(catPath, { withFileTypes: true })
                .filter((x) => x.isDirectory() && x.name && !x.name.startsWith('.'))
                .map((x) => x.name)
                .sort((a, b) => a.localeCompare(b, 'zh-CN'));
            catalog[d.name] = styles;
        } catch {
            catalog[d.name] = [];
        }
    }
    return catalog;
}

function writeFilterSettings(body) {
    assertEnvFile();
    let text = fs.readFileSync(ENV_PATH, 'utf8');

    if (body.brainFilterEnabled === true) {
        text = setOrRemoveEnvLine(text, FILTER_ENV_KEYS.brainCategory, body.brainOnlyCategory ?? '');
        text = setOrRemoveEnvLine(text, FILTER_ENV_KEYS.brainStyle, body.brainOnlyStyle ?? '');
    } else if (body.brainFilterEnabled === false) {
        text = removeEnvKeyLine(text, FILTER_ENV_KEYS.brainCategory);
        text = removeEnvKeyLine(text, FILTER_ENV_KEYS.brainStyle);
    }

    if (body.feishuFilterEnabled === true) {
        text = setOrRemoveEnvLine(text, FILTER_ENV_KEYS.feishuCategory, body.feishuOnlyCategory ?? '');
        text = setOrRemoveEnvLine(text, FILTER_ENV_KEYS.feishuStyle, body.feishuOnlyStyle ?? '');
    } else if (body.feishuFilterEnabled === false) {
        text = removeEnvKeyLine(text, FILTER_ENV_KEYS.feishuCategory);
        text = removeEnvKeyLine(text, FILTER_ENV_KEYS.feishuStyle);
    }

    fs.writeFileSync(ENV_PATH, text.replace(/\n{3,}/g, '\n\n'), 'utf8');
}

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/asset-catalog', (_req, res) => {
    try {
        const catalog = scanAssetsCatalog();
        res.json({ catalog });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

app.get('/api/settings', (_req, res) => {
    try {
        const { renderMode, envExists } = readRenderMode();
        let filter = {
            brainOnlyCategory: '',
            brainOnlyStyle: '',
            feishuOnlyCategory: '',
            feishuOnlyStyle: '',
            brainFilterEnabled: false,
            feishuFilterEnabled: false
        };
        if (envExists && fs.existsSync(ENV_PATH)) {
            const text = fs.readFileSync(ENV_PATH, 'utf8');
            filter = readFilterSettingsFromText(text);
        }
        res.json({
            renderMode,
            envExists,
            roots: Object.keys(ROOTS),
            ...filter
        });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

app.post('/api/settings', (req, res) => {
    try {
        const mode = req.body && req.body.renderMode;
        writeRenderMode(mode);
        res.json({ ok: true, renderMode: mode });
    } catch (e) {
        res.status(400).json({ error: String(e.message || e) });
    }
});

/** 仅更新 BRAIN_ONLY_* / FEISHU_ONLY_*；取消勾选会从 .env 中删除对应行 */
app.post('/api/filter-settings', (req, res) => {
    try {
        const b = req.body || {};
        if (b.brainFilterEnabled === undefined && b.feishuFilterEnabled === undefined) {
            return res.status(400).json({ error: '请提供 brainFilterEnabled 或 feishuFilterEnabled' });
        }
        writeFilterSettings({
            brainFilterEnabled: b.brainFilterEnabled,
            brainOnlyCategory: b.brainOnlyCategory,
            brainOnlyStyle: b.brainOnlyStyle,
            feishuFilterEnabled: b.feishuFilterEnabled,
            feishuOnlyCategory: b.feishuOnlyCategory,
            feishuOnlyStyle: b.feishuOnlyStyle
        });
        const text = fs.readFileSync(ENV_PATH, 'utf8');
        const filter = readFilterSettingsFromText(text);
        res.json({ ok: true, ...filter });
    } catch (e) {
        res.status(400).json({ error: String(e.message || e) });
    }
});

app.get('/api/browse', (req, res) => {
    const rootKey = String(req.query.root || 'assets');
    const sub = String(req.query.path || '');
    const target = safeResolveUnderRoot(rootKey, sub);
    if (!target || !fs.existsSync(target)) {
        return res.status(404).json({ error: '路径无效或不存在' });
    }
    const st = fs.statSync(target);
    if (!st.isDirectory()) {
        return res.status(400).json({ error: '不是目录' });
    }
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const items = entries
        .map((d) => {
            const full = path.join(target, d.name);
            let size = null;
            let mtime = null;
            try {
                const s = fs.statSync(full);
                mtime = s.mtimeMs;
                if (s.isFile()) size = s.size;
            } catch {
                return null;
            }
            return {
                name: d.name,
                isDirectory: d.isDirectory(),
                size,
                mtime
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name, 'zh-CN');
        });

    const rel = path.relative(ROOTS[rootKey], target).replace(/\\/g, '/') || '';
    res.json({ root: rootKey, path: rel, items });
});

app.get('/api/file', (req, res) => {
    const rootKey = String(req.query.root || 'assets');
    const sub = String(req.query.path || '');
    if (!sub || sub.endsWith('/') || sub.endsWith('\\')) {
        return res.status(400).json({ error: '请指定文件路径' });
    }
    const target = safeResolveUnderRoot(rootKey, sub);
    if (!target || !fs.existsSync(target)) {
        return res.status(404).json({ error: '文件不存在' });
    }
    const st = fs.statSync(target);
    if (!st.isFile()) {
        return res.status(400).json({ error: '不是文件' });
    }
    const ext = path.extname(target).toLowerCase();
    const types = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    res.sendFile(target);
});

app.post('/api/upload', (req, res) => {
    upload.array('files', UPLOAD_MAX_FILES)(req, res, (err) => {
        if (err) {
            const msg = err instanceof multer.MulterError ? `${err.code}: ${err.message}` : String(err.message || err);
            return res.status(400).json({ error: msg });
        }
        const files = req.files;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: '未选择文件（字段名 files）' });
        }
        const saved = files.map((f) => ({
            filename: f.filename,
            relativePath: path.relative(PROJECT_ROOT, f.path).replace(/\\/g, '/')
        }));
        res.json({ ok: true, count: files.length, saved });
    });
});

app.post('/api/run', (req, res) => {
    const key = req.body && req.body.script;
    const def = ALLOWED_SCRIPTS[key];
    if (!def) {
        return res.status(400).json({ error: '未知脚本' });
    }
    const scriptPath = path.join(PROJECT_ROOT, def.file);
    if (!fs.existsSync(scriptPath)) {
        return res.status(404).json({ error: '脚本文件不存在' });
    }

    const chunks = [];
    const maxOut = 512 * 1024;
    const child = spawn(process.execPath, [scriptPath], {
        cwd: PROJECT_ROOT,
        env: { ...process.env },
        windowsHide: true
    });
    child.stdout.on('data', (d) => {
        chunks.push(d);
        while (Buffer.concat(chunks).length > maxOut) chunks.shift();
    });
    child.stderr.on('data', (d) => {
        chunks.push(d);
        while (Buffer.concat(chunks).length > maxOut) chunks.shift();
    });
    child.on('error', (err) => {
        res.status(500).json({ ok: false, error: String(err.message), output: '' });
    });
    child.on('close', (code) => {
        const output = Buffer.concat(chunks).toString('utf8').slice(-maxOut);
        res.json({
            ok: code === 0,
            exitCode: code,
            label: def.label,
            output
        });
    });
});

const PORT = Number(process.env.CONTROL_PANEL_PORT) || 38471;
const HOST = '127.0.0.1';

app.listen(PORT, HOST, () => {
    console.log(`\n  本地控制面板: http://${HOST}:${PORT}`);
    console.log('  仅本机可访问；RENDER_MODE 与 BRAIN_ONLY / FEISHU_ONLY 可经页面写入项目根目录 .env\n');
});
