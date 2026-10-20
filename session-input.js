'use strict';

function parseSession(raw) {
    let session;
    try { session = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { throw new Error('请提交完整 Session JSON'); }
    if (!session || Array.isArray(session) || typeof session !== 'object'
        || !session.user || typeof session.user !== 'object' || Array.isArray(session.user)
        || !session.account || typeof session.account !== 'object' || Array.isArray(session.account)
        || typeof (session.accessToken || session.access_token) !== 'string'
        || !(session.accessToken || session.access_token).trim()) throw new Error('Session 必须包含 user、account 和 accessToken');
    if (typeof session.user.email !== 'string' || session.user.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(session.user.email)) throw new Error('Session 缺少有效的账号邮箱');
    if (session.expires && (!Number.isFinite(Date.parse(session.expires)) || Date.parse(session.expires) <= Date.now())) throw new Error('Session 已过期，请重新获取');
    // Authentication is verified by Orbitcard. No browser login or locally forged JWT acceptance.
    return session;
}

module.exports = { parseSession };
