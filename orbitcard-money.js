'use strict';
const { CardPreparationError } = require('./orbitcard-card-policy');
const SCALE = 100000000n;
function units(value) {
    const text = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(8) : String(value ?? '');
    const match = /^(\d{1,14})(?:\.(\d{1,8}))?$/.exec(text);
    if (!match) throw new CardPreparationError('平台金额缺失或格式无效，已停止资金操作');
    return BigInt(match[1]) * SCALE + BigInt((match[2] || '').padEnd(8, '0'));
}
function decimal(value) { return `${value / SCALE}.${String(value % SCALE).padStart(8,'0')}`; }
function cents(value) {
    const rounded = (value + 999999n) / 1000000n;
    return `${rounded / 100n}.${String(rounded % 100n).padStart(2,'0')}`;
}
module.exports = { units, decimal, cents };
