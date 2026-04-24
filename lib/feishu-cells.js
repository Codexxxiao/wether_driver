function nonEmptyString(value) {
    if (value == null) return '';
    const s = String(value).trim();
    return s || '';
}

function labelHintFromAttachment(att) {
    if (!att || typeof att !== 'object') return '';
    const keys = [
        'text',
        'displayText',
        'display_text',
        'name',
        'file_name',
        'filename',
        'title'
    ];
    for (const key of keys) {
        const candidate = nonEmptyString(att[key]);
        if (candidate) return candidate;
    }
    return '';
}

function looksLikeSheetMediaToken(label) {
    if (typeof label !== 'string') return false;
    const s = label.trim();
    if (s.length < 16) return false;
    return /^[A-Za-z0-9_-]+$/.test(s);
}

function parseAssetCell(cell, assetIdFallback) {
    if (cell == null || cell === '') return '';
    if (typeof cell === 'string' || typeof cell === 'number') {
        return String(cell).trim();
    }
    let att = null;
    if (Array.isArray(cell) && cell.length > 0) att = cell[0];
    else if (typeof cell === 'object' && (cell.fileToken || cell.file_token)) att = cell;
    if (att && typeof att === 'object') {
        const hint = labelHintFromAttachment(att);
        const token = att.fileToken || att.file_token || null;
        const fallback = token ? String(token) : '';
        let label = hint || fallback;
        if (looksLikeSheetMediaToken(label) && nonEmptyString(assetIdFallback)) {
            label = nonEmptyString(assetIdFallback);
        }
        return label;
    }
    return String(cell);
}

module.exports = {
    nonEmptyString,
    parseAssetCell
};
