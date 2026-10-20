'use strict';

const { classifyResult, hasConfirmedSuccess, mayHaveSubmitted } = require('./local-payment-state');
const { redactText } = require('./log-safety');

// The server supplies the browser/process runner; this module owns durable settlement.
async function run({ task, cdk, runAttempt, store, log, broadcast, notify, metadata = () => ({}), maxAttempts = 1 }) {
    const outputs = [];
    let liveOutput = '';
    let launched = false;
    let progress = 3;
    let result;
    const fields = output => {
        const info = metadata(output);
        return { ...info, failureScreenshots: [...(info.screenshots || []), ...(info.videos || [])] };
    };
    const persistProgress = async (value, output) => {
        liveOutput = redactText(output);
        progress = Math.max(progress, Math.min(99, Number(value) || 0));
        await store.updateTaskLog(task.jobKey, {
            status: 'running', progress,
            message: mayHaveSubmitted(liveOutput) ? '支付已提交，正在确认结果' : '正在开通中',
            rawOutput: [...outputs, liveOutput].join('\n'),
            localState: mayHaveSubmitted(liveOutput) ? 'submitting' : 'running',
            ...fields(liveOutput)
        });
        broadcast({ status: 'running', progress, message: '正在开通中', ...fields(liveOutput) });
    };
    try {
        const started = await store.settleLocalTask(task.jobKey, {
            status: 'running', localState: 'running', progress, message: '本地充值任务已启动', expectedState: 'prepared'
        });
        if (!started.applied) throw new Error('任务已被处理，停止启动');
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            liveOutput = '';
            log(`开始本地支付尝试 ${attempt}/${maxAttempts}`);
            result = await runAttempt(attempt, persistProgress, () => { launched = true; });
            liveOutput = redactText(result.output || '');
            outputs.push(`===== ATTEMPT ${attempt} =====\n${liveOutput}`);
            result.analysis = classifyResult(result.analysis || { status: 'failed' }, liveOutput);
            if (!result.analysis.shouldRetry || attempt >= maxAttempts) break;
        }
        const analysis = result?.analysis || { status: 'failed', message: '任务未执行' };
        const status = analysis.status === 'retry' ? 'failed' : analysis.status;
        const saved = await store.settleLocalTask(task.jobKey, {
            status, localState: status, progress: status === 'success' ? 100 : progress,
            message: analysis.message, rawOutput: outputs.join('\n'), ...fields(outputs.join('\n'))
        });
        if (saved.applied) {
            log(`任务结算 status=${status} CDK=${status === 'failed' ? '已释放' : status === 'success' ? '已核销' : '保持占用'}`);
            broadcast({ status, progress: status === 'success' ? 100 : progress, message: analysis.message, ...fields(outputs.join('\n')) });
            try { await notify(status, analysis.message, outputs.join('\n')); }
            catch (_) { log('任务已结算，后续通知或统计更新失败'); }
        }
    } catch (error) {
        const output = [...outputs, liveOutput].join('\n');
        const status = hasConfirmedSuccess(output) ? 'success' : launched ? 'manual' : 'failed';
        const message = status === 'success' ? '支付已确认成功，后处理异常，请查看任务日志'
            : status === 'manual' ? '本地支付流程中断，CDK 保持占用，请核对原支付记录' : redactText(error.message);
        const saved = await store.settleLocalTask(task.jobKey, {
            status, localState: status, progress: status === 'success' ? 100 : progress,
            message, rawOutput: `${output}\n[WORKER_ERROR] ${redactText(error.message)}`, ...fields(output)
        });
        log(message);
        if (saved.applied) {
            broadcast({ status, progress: status === 'success' ? 100 : progress, message, ...fields(output) });
            try { await notify(status, message, output); } catch (_) { log('结果已保留，通知失败'); }
        }
    }
}

module.exports = { run };
