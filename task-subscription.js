'use strict';

async function authorize(data, { store, verifyAdminToken }) {
    if (typeof data.jobKey !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(data.jobKey)) return false;
    const task = await store.getTaskStatus(data.jobKey);
    if (!task) return false;
    const cdk = String(data.cdk || '').trim();
    if (cdk && !cdk.startsWith('ADMIN_') && cdk === task.cdk_code) return true;
    const admin = verifyAdminToken(typeof data.adminToken === 'string' ? data.adminToken : '');
    if (!admin) return false;
    const config = await store.getAdminAuthConfig();
    return Number(admin.pv || 0) === config.passwordVersion;
}

module.exports = { authorize };
