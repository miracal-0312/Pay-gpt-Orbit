'use strict';

// Presentation-only helpers. No API calls or payment state changes.
(() => {
    const sidebar = document.getElementById('adminSidebar');
    const toggle = document.getElementById('menuToggle');
    const scrim = document.getElementById('menuScrim');
    const workspace = document.querySelector('.admin-workspace');
    const compact = window.matchMedia('(max-width: 980px)');
    function setMenu(open, restoreFocus = false) {
        const shown = open && compact.matches;
        document.body.classList.toggle('menu-open', shown);
        toggle.setAttribute('aria-expanded', String(shown));
        toggle.setAttribute('aria-label', shown ? '收起导航' : '展开导航');
        sidebar.inert = compact.matches && !shown;
        workspace.inert = shown;
        if (shown) sidebar.querySelector('[aria-current="page"]')?.focus();
        else if (restoreFocus) toggle.focus();
    }
    toggle.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
    scrim.addEventListener('click', () => setMenu(false, true));
    compact.addEventListener('change', () => setMenu(false));
    document.getElementById('tabs').addEventListener('click', event => {
        if (!event.target.closest('[data-tab]')) return;
        const wasOpen = document.body.classList.contains('menu-open');
        setMenu(false);
        if (wasOpen) document.getElementById('viewTitle').focus();
        window.scrollTo({ top: 0, behavior: 'instant' });
    });
    document.addEventListener('keydown', event => {
        if (!document.body.classList.contains('menu-open')) return;
        if (event.key === 'Escape') { event.preventDefault(); setMenu(false, true); }
        if (event.key === 'Tab') {
            const items = [...sidebar.querySelectorAll('a,button')];
            const first = items[0], last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
    setMenu(false);

    const searches = {
        tasks: ['搜索账号、卡密或订单编号', '仅筛选当前加载的订单'],
        cdkRows: ['搜索卡密、套餐或状态', '仅筛选当前列表；CSV 导出仍按套餐筛选'],
        manualOrderRows: ['搜索账号、请求编号或 CDK', '仅筛选当前加载的管理员订单'],
        cardRows: ['搜索卡 ID、状态或产品代码', '仅筛选当前加载的卡片']
    };
    for (const [id, [placeholder, scope]] of Object.entries(searches)) {
        const body = document.getElementById(id), wrap = body.closest('.table-wrap');
        const toolbar = document.createElement('div'); toolbar.className = 'table-toolbar';
        const label = document.createElement('label'); label.className = 'table-search';
        const input = document.createElement('input'); input.type = 'search'; input.placeholder = placeholder;
        input.setAttribute('aria-label', placeholder); input.autocomplete = 'off';
        const note = document.createElement('span'); note.className = 'table-search-note';
        note.id = id + 'SearchScope'; input.setAttribute('aria-describedby', note.id);
        label.append(input); toolbar.append(label, note); wrap.before(toolbar);
        const empty = document.createElement('p'); empty.className = 'table-empty';
        empty.textContent = '没有匹配记录，请调整搜索内容。'; empty.hidden = true; empty.setAttribute('role', 'status'); wrap.after(empty);
        function filter() {
            const term = input.value.trim().toLocaleLowerCase();
            let total = 0, visible = 0;
            for (const row of body.rows) {
                if (row.cells.length < 2) { row.hidden = false; continue; }
                total++;
                const content = [...row.cells].slice(0, -1).map(cell => cell.textContent).join(' ').toLocaleLowerCase();
                row.hidden = Boolean(term && !content.includes(term));
                if (!row.hidden) visible++;
            }
            empty.hidden = !term || !total || visible > 0;
            note.textContent = `${visible} / ${total} 条 · ${scope}`;
        }
        input.addEventListener('input', filter);
        new MutationObserver(filter).observe(body, { childList: true, subtree: true, characterData: true });
        filter();
    }

    for (const id of ['runtimeLogs', 'diagnosticLog', 'diagTraceLog', 'cardTransactions', 'products', 'loginLogs']) {
        const output = document.getElementById(id);
        output.tabIndex = 0;
        const tools = document.createElement('div'); tools.className = 'log-tools';
        const caption = document.createElement('span'); caption.textContent = 'OUTPUT / 日志与结果';
        const actions = document.createElement('div'); actions.className = 'row';
        const wrap = document.createElement('button'); wrap.type = 'button'; wrap.className = 'secondary';
        wrap.textContent = '自动换行'; wrap.setAttribute('aria-pressed', 'true');
        wrap.addEventListener('click', () => {
            const noWrap = output.classList.toggle('no-wrap');
            wrap.setAttribute('aria-pressed', String(!noWrap)); wrap.textContent = noWrap ? '横向滚动' : '自动换行';
        });
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary'; copy.textContent = '复制内容';
        copy.addEventListener('click', async () => {
            copy.disabled = true;
            try { await navigator.clipboard.writeText(output.textContent); copy.textContent = '已复制'; }
            catch (_) {
                const range = document.createRange(); range.selectNodeContents(output);
                const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
                copy.textContent = '已选中，请手动复制';
            } finally { setTimeout(() => { copy.disabled = false; copy.textContent = '复制内容'; }, 2200); }
        });
        actions.append(wrap, copy); tools.append(caption, actions); output.before(tools);
    }
})();
