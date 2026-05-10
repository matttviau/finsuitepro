/* ═══════════════════════════════════════════════════════════════════════════
   Paralux Terminal — Client JS
   ═══════════════════════════════════════════════════════════════════════════ */

const C = {
    cyan:'#00D4AA', green:'#00D4AA', gold:'#FFB347', red:'#FF3D6B',
    blue:'#4DA6FF', purple:'#B06EFF', orange:'#FF7B54', ema:'#00BF96',
    border:'#152038', grid:'#0F1D35', dim:'#253850', sec:'#527090'
};

let charts = {};
let techPeriod    = '1Y', corrPeriod = '1Y';
let techInterval  = '1d';  // '1d'|'4h'|'1h'|'30m'|'15m'|'5m'|'1m'

// Period button sets per interval
const _INTRADAY_PERIODS = {
    '1m':  [['1D','1D'],['3D','3D'],['5D','5D'],['7D','7D']],
    '5m':  [['1D','1D'],['5D','5D'],['1M','1M'],['2M','2M']],
    '15m': [['1D','1D'],['5D','5D'],['1M','1M'],['2M','2M']],
    '30m': [['1D','1D'],['5D','5D'],['1M','1M'],['2M','2M']],
    '1h':  [['1D','1D'],['1W','1W'],['1M','1M'],['3M','3M'],['6M','6M'],['1Y','1Y']],
    '4h':  [['1W','1W'],['1M','1M'],['3M','3M'],['6M','6M'],['1Y','1Y']],
};
const _DAILY_PERIODS = [['3M','3M'],['6M','6M'],['YTD','YTD'],['1Y','1Y'],
                        ['3Y','3Y'],['5Y','5Y'],['10Y','10Y'],['MAX','MAX'],['CUSTOM','Custom ▾']];
let fundData = null, fundAllItems = [];

/* ── Session-state micro-helpers (used by all modules) ── */
function _saveState(k,obj){try{sessionStorage.setItem('fs_'+k,JSON.stringify(obj));}catch(_){}}
function _loadState(k){try{const s=sessionStorage.getItem('fs_'+k);return s?JSON.parse(s):null;}catch(_){return null;}}
function _clearState(k){try{sessionStorage.removeItem('fs_'+k);}catch(_){}}

/* ── Helpers ──────────────────────────────────────────────────────────── */
function destroyChart(id){ if(charts[id]){ charts[id].destroy(); delete charts[id]; } }

function switchTab(prefix, btn, tab){
    btn.closest('.tabs').querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll(`[id^="${prefix}-"]`).forEach(el=>{
        if(el.classList.contains('tab-content')) el.classList.remove('active');
    });
    const t = document.getElementById(`${prefix}-${tab}`);
    if(t) t.classList.add('active');
}

function setPeriod(btn, ctx){
    btn.parentNode.querySelectorAll('.period-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');

    if(ctx === 'tech'){
        techPeriod = btn.dataset.period;

        // Show / hide the custom date range row
        const customRow = document.getElementById('ta-custom-range');
        if(customRow) customRow.style.display = techPeriod === 'CUSTOM' ? 'flex' : 'none';

        // Pre-fill custom inputs with a sensible default (1Y) first time
        if(techPeriod === 'CUSTOM'){
            const tf = document.getElementById('ta-from');
            const tt = document.getElementById('ta-to');
            if(tf && !tf.value){
                const d = new Date(); d.setFullYear(d.getFullYear()-1);
                tf.value = d.toISOString().slice(0,10);
            }
            if(tt && !tt.value) tt.value = new Date().toISOString().slice(0,10);
            return; // wait for user to press "Apply Range"
        }

        // Auto-reload if a chart is already showing
        if(taData) runTech();
    }

    if(ctx === 'corr') corrPeriod = btn.dataset.period;
}

// Switch intraday/daily interval and rebuild period buttons accordingly
function setTechInterval(btn) {
    document.querySelectorAll('.ta-interval-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    techInterval = btn.dataset.interval;

    const isIntraday = techInterval !== '1d';
    const periods    = isIntraday ? (_INTRADAY_PERIODS[techInterval] || _INTRADAY_PERIODS['1h']) : _DAILY_PERIODS;
    const container  = document.getElementById('taPeriodBtns');
    const customRow  = document.getElementById('ta-custom-range');
    const hint       = document.getElementById('taIntervalHint');

    if (container) {
        container.innerHTML = periods.map(([val, lbl], i) =>
            `<button class="period-btn${i===0?' active':''}" data-period="${val}" onclick="setPeriod(this,'tech')">${lbl}</button>`
        ).join('');
    }
    if (customRow) customRow.style.display = 'none';

    // Show/hide intraday warning hint
    if (hint) {
        if (techInterval === '1m') {
            hint.textContent = '⚡ 1-min data: max 7 days lookback'; hint.style.display = '';
        } else if (['5m','15m','30m'].includes(techInterval)) {
            hint.textContent = '⚡ Sub-hour data: max 60 days lookback'; hint.style.display = '';
        } else if (['1h','4h'].includes(techInterval)) {
            hint.textContent = '⚡ Hourly data: max ~730 days lookback'; hint.style.display = '';
        } else {
            hint.style.display = 'none';
        }
    }

    // Set default period for the new interval
    techPeriod = periods[isIntraday ? Math.min(1, periods.length-1) : 3][0];  // default: 3D for intraday, 1Y for daily

    // Auto-reload if a ticker is already loaded
    if (taData) runTech();
}

// Apply a custom date range to the already-rendered TA chart.
// If no data is loaded yet, fetches MAX first then zooms.
function applyCustomRange(){
    const from = document.getElementById('ta-from')?.value;
    const to   = document.getElementById('ta-to')?.value;
    if(!from || !to){ alert('Please select both a start and end date.'); return; }
    if(from >= to){ alert('Start date must be before end date.'); return; }

    const _zoom = () => {
        if (!taData?.dates?.length) return;
        const dates = taData.dates;
        // For category axis: convert date strings to bar indices
        let i0 = dates.findIndex(d => d >= from);
        let i1 = -1;
        for (let i = dates.length - 1; i >= 0; i--) { if (dates[i] <= to + 'z') { i1 = i; break; } }
        if (i0 < 0) i0 = 0;
        if (i1 < 0) i1 = dates.length - 1;
        try {
            Plotly.relayout('ta-plotly-chart', {
                'xaxis.range': [i0 - 0.5, i1 + 0.5],
                'xaxis.autorange': false
            });
        } catch(e){ console.warn('Plotly relayout skipped:', e); }
    };

    if(taData){
        _zoom();
    } else {
        // Fetch the full history first, then zoom
        const ticker = document.getElementById('ticker')?.value?.toUpperCase()?.trim();
        if(!ticker){ alert('Enter a ticker symbol first.'); return; }
        document.getElementById('tech-loading').style.display = 'flex';
        document.getElementById('tech-content').style.display = 'none';
        fetch(`/api/technical/${ticker}?period=MAX&interval=1d`)
            .then(r => r.json())
            .then(d => {
                document.getElementById('tech-loading').style.display = 'none';
                if(d.error){ alert(d.error); return; }
                taData = d;
                document.getElementById('tech-content').style.display = 'block';
                renderTechStats(d);
                buildTAChart();
                renderDist(d);
                setTimeout(_zoom, 200); // wait for Plotly to finish rendering
            })
            .catch(e => { document.getElementById('tech-loading').style.display = 'none'; alert(e); });
    }
}

// Quick-fill the backtest date pickers from a named preset.
function setBtPreset(btn, preset){
    document.querySelectorAll('.bt-preset-btn').forEach(b => b.classList.remove('active'));
    if(btn) btn.classList.add('active');
    const today = new Date();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    document.getElementById('bt-end').value = fmt(today);
    if(preset === 'MAX'){
        document.getElementById('bt-start').value = '1990-01-01';
    } else {
        const days = {'1Y':365,'3Y':1095,'5Y':1825,'10Y':3650}[preset] || 365;
        const s = new Date(today); s.setDate(s.getDate() - days);
        document.getElementById('bt-start').value = fmt(s);
    }
}

function fmtLarge(x){
    if(Math.abs(x)>=1e12) return (x/1e12).toFixed(2)+'T';
    if(Math.abs(x)>=1e9) return (x/1e9).toFixed(2)+'B';
    if(Math.abs(x)>=1e6) return (x/1e6).toFixed(2)+'M';
    if(Math.abs(x)>=1e3) return (x/1e3).toFixed(2)+'K';
    return x.toFixed(2);
}

const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: { labels: { font: { family: "'DM Sans'", size: 11 }, usePointStyle: true, color: '#527090' } },
        tooltip: {
            titleFont: { family: "'DM Sans'" }, bodyFont: { family: "'DM Sans'" },
            backgroundColor: '#0C1224', borderColor: '#152038', borderWidth: 1,
            titleColor: '#C8E4FF', bodyColor: '#527090',
            padding: 10, cornerRadius: 8
        }
    },
    scales: {
        x: { grid: { color: C.grid, lineWidth: 0.5 }, ticks: { font: { family: "'DM Sans'", size: 10 }, color: C.sec, maxTicksLimit: 20 }, border: { color: C.border } },
        y: { grid: { color: C.grid, lineWidth: 0.5 }, ticks: { font: { family: "'DM Sans'", size: 10 }, color: C.sec }, border: { color: C.border } }
    }
};

function makeLineDataset(label, data, color, opts={}){
    return { label, data, borderColor: color, backgroundColor: color+'18', borderWidth: opts.width||2,
        pointRadius: 0, tension: 0.1, fill: opts.fill||false, borderDash: opts.dash||[], ...opts };
}

/* ═══════════════════════════════════════════════════════════════════════════
   TECHNICAL ANALYSIS — Plotly-powered advanced charting
   ═══════════════════════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────────────────────
let taData        = null;
let taChartType   = 'candlestick';
let taOverlays    = new Set(['sma50', 'bb']);
let taPanels      = new Set(['volume', 'rsi', 'macd']);

// Plotly base config
const PLY = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor:  '#060E1C',
    font: { family: "'DM Sans', sans-serif", size: 11, color: '#527090' },
    margin: { l: 60, r: 20, t: 20, b: 40 },
    colorway: ['#00D4AA'],
    hoverlabel: {
        bgcolor: '#0C1224', bordercolor: '#152038',
        font: { family: "'DM Sans'", size: 12, color: '#C8E4FF' }
    },
    legend: {
        orientation: 'h', y: 1.02, x: 0,
        font: { size: 11 }, bgcolor: 'rgba(0,0,0,0)',
        itemclick: 'togglevisibility'
    },
    xaxis_rangeslider_visible: false,
};

const PLY_AXIS = {
    gridcolor: '#0F1D35', gridwidth: 0.5,
    linecolor: '#152038', tickcolor: '#152038',
    tickfont: { size: 10, color: '#527090' },
    zerolinecolor: '#152038',
    showgrid: true,
};

/* ═══════════════════════════════════════════════════════════════════════════
   TA PREFERENCES — persistent chart customization stored in localStorage
   ═══════════════════════════════════════════════════════════════════════════ */
const TA_PREFS_KEY = 'finsuite-ta-prefs-v2';
const TA_DEFAULTS = {
    // ── Chart defaults ──
    defaultChartType: 'candlestick',
    defaultPeriod:    '1Y',
    defaultOverlays:  'sma50,bb',
    defaultPanels:    'volume,rsi,macd',
    // ── Candlestick ──
    candleUpColor:      '#00D4AA',  candleDownColor:    '#FF3D6B',
    candleLineWidth:    1,          candleFillOpacity:  15,
    // ── OHLC ──
    ohlcUpColor:    '#00D4AA',  ohlcDownColor: '#FF3D6B',  ohlcLineWidth: 1.5,
    // ── Line / Area ──
    lineColor: '#00D4AA', lineWidth: 2, lineDash: 'solid',
    areaFill:  '#00D4AA', areaOpacity: 8,
    // ── Overlays ──
    sma20Color: '#7DD3FC', sma20Width: 1.4, sma20Dash: 'dot',
    sma50Color: '#FFB347', sma50Width: 1.6, sma50Dash: 'dash',
    sma200Color:'#FF6B6B', sma200Width:1.8, sma200Dash:'longdash',
    ema9Color:  '#A8FF9F', ema9Width:  1.2, ema9Dash:  'solid',
    ema20Color: '#00BF96', ema20Width: 1.4, ema20Dash: 'solid',
    vwapColor:  '#FF7B54', vwapWidth:  1.6, vwapDash:  'dashdot',
    bbColor:    '#B06EFF', bbLineWidth: 1,  bbFillOpacity: 5,
    // ── Volume ──
    volUpColor: '#00D4AA', volDownColor: '#FF3D6B',
    // ── RSI ──
    rsiColor: '#00D4AA', rsiWidth: 1.8, rsiOB: 70, rsiOS: 30,
    // ── MACD ──
    macdColor: '#00D4AA',  macdSigColor: '#FF3D6B',
    macdHistUp: '#00D4AA', macdHistDown: '#FF3D6B',
    macdLineWidth: 1.6,    macdSigWidth: 1.4,
    // ── Stochastic ──
    stochKColor: '#00D4AA', stochDColor: '#FF7B54',
    stochKWidth: 1.6,       stochDWidth: 1.4,
    stochOB: 80,            stochOS: 20,
    // ── OBV / ATR ──
    obvColor: '#00BF96', obvWidth: 1.8,
    atrColor: '#FF7B54', atrWidth: 1.8,
    // ── Appearance ──
    plotBg:     '#060E1C',
    gridColor:  '#0F1D35',
    gridWidth:  0.5,
    xhairColor: '#527090',
    minHeight:  560,
};

function loadTAPrefs() {
    try {
        return { ...TA_DEFAULTS, ...JSON.parse(localStorage.getItem(TA_PREFS_KEY) || '{}') };
    } catch(_) { return { ...TA_DEFAULTS }; }
}

function _hexOp(pct) {
    return Math.round(255 * Math.max(0, Math.min(100, +pct)) / 100)
        .toString(16).padStart(2, '0').toUpperCase();
}

/* Called from profile page */
function saveTAPrefs() {
    const prefs = {};
    for (const key of Object.keys(TA_DEFAULTS)) {
        if (key === 'defaultOverlays' || key === 'defaultPanels') continue;
        const el = document.getElementById('pref-' + key);
        if (!el) continue;
        prefs[key] = (el.type === 'range' || el.type === 'number') ? +el.value : el.value;
    }
    const ovArr = []; document.querySelectorAll('.pref-ov-cb:checked').forEach(cb => ovArr.push(cb.value));
    prefs.defaultOverlays = ovArr.join(',');
    const panArr = []; document.querySelectorAll('.pref-pan-cb:checked').forEach(cb => panArr.push(cb.value));
    prefs.defaultPanels = panArr.join(',');
    try { localStorage.setItem(TA_PREFS_KEY, JSON.stringify(prefs)); } catch(_){}
    _showToast('TA Preferences saved ✓');
}

function resetTAPrefs() {
    if (!confirm('Reset all TA preferences to factory defaults?')) return;
    try { localStorage.removeItem(TA_PREFS_KEY); } catch(_){}
    _loadPrefForm();
    _showToast('Preferences reset to defaults');
}

function _loadPrefForm() {
    const p = loadTAPrefs();
    for (const [key, val] of Object.entries(p)) {
        const el = document.getElementById('pref-' + key);
        if (el) el.value = val;
    }
    const ovSet  = new Set((p.defaultOverlays  || '').split(',').filter(Boolean));
    const panSet = new Set((p.defaultPanels || '').split(',').filter(Boolean));
    document.querySelectorAll('.pref-ov-cb').forEach(cb  => cb.checked = ovSet.has(cb.value));
    document.querySelectorAll('.pref-pan-cb').forEach(cb => cb.checked = panSet.has(cb.value));
    // Sync range display labels
    document.querySelectorAll('input[type="range"].pref-range').forEach(r => {
        const v = document.getElementById(r.id + '-val');
        if (v) v.textContent = r.value;
    });
    // Sync color value labels
    document.querySelectorAll('input[type="color"].pref-color').forEach(c => {
        const v = document.getElementById(c.id + '-val');
        if (v) v.textContent = c.value;
    });
}

function _showToast(msg) {
    const t = document.createElement('div');
    t.className = 'sc-toast'; t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2200);
}

function initTAFromPrefs() {
    if (!document.querySelector('.ta-ctype-btn')) return;
    const p = loadTAPrefs();
    taChartType = p.defaultChartType || 'candlestick';
    taOverlays  = new Set((p.defaultOverlays || '').split(',').filter(Boolean));
    taPanels    = new Set((p.defaultPanels || '').split(',').filter(Boolean));
    document.querySelectorAll('.ta-ctype-btn').forEach(b => b.classList.toggle('active', b.dataset.type === taChartType));
    document.querySelectorAll('[data-ind]').forEach(b   => b.classList.toggle('active', taOverlays.has(b.dataset.ind)));
    document.querySelectorAll('[data-panel]').forEach(b => b.classList.toggle('active', taPanels.has(b.dataset.panel)));
    // Set active period button
    const dp = p.defaultPeriod || '1Y';
    techPeriod = dp;
    document.querySelectorAll('[data-period]').forEach(b => b.classList.toggle('active', b.dataset.period === dp));
}

/* ── Entry point ─────────────────────────────────────────────────────────── */
function runTech(){
    const ticker = document.getElementById('ticker')?.value?.toUpperCase()?.trim();
    if(!ticker) return;
    document.getElementById('tech-loading').style.display='flex';
    document.getElementById('tech-content').style.display='none';
    const sb = document.getElementById('tech-status');
    sb.style.display='none'; sb.innerHTML='';

    fetch(`/api/technical/${ticker}?period=${techPeriod}&interval=${techInterval}`)
        .then(r=>r.json())
        .then(d=>{
            document.getElementById('tech-loading').style.display='none';
            if(d.error){
                sb.style.display='block';
                sb.innerHTML=`<span style="color:var(--red)">⚠ ${d.error}</span>`;
                return;
            }
            taData = d;
            document.getElementById('tech-content').style.display='block';
            renderTechStats(d);
            buildTAChart();
            renderDist(d);
            // Status bar
            const s = d.stats;
            const up = s.change_pct >= 0;
            const arrow = up ? '▲' : '▼';
            const col   = up ? C.green : C.red;
            const rsiColor = s.rsi > 70 ? C.red : s.rsi < 30 ? C.green : C.gold;
            sb.style.display='block';
            sb.innerHTML = `
                <span class="ta-status-ticker">${d.ticker}</span>
                <span class="ta-status-price">$${s.latest_close}</span>
                <span class="ta-status-chg" style="color:${col}">${arrow} ${Math.abs(s.change_pct).toFixed(2)}%</span>
                <span class="ta-status-sep">·</span>
                <span>52W <span style="color:${C.green}">H ${s.high_52w}</span> / <span style="color:${C.red}">L ${s.low_52w}</span></span>
                <span class="ta-status-sep">·</span>
                <span>RSI <span style="color:${rsiColor}">${s.rsi ?? 'N/A'}</span></span>
                <span class="ta-status-sep">·</span>
                <span>Vol <span style="color:${C.gold}">${s.volatility}%</span></span>
                <span class="ta-status-sep">·</span>
                <span class="ta-status-signal" style="color:${s.macd_signal==='Bullish'?C.green:C.red}">
                    ${s.macd_signal==='Bullish'?'▲':'▼'} MACD ${s.macd_signal}
                </span>
            `;
            const _state = { ticker: d.ticker, period: techPeriod, interval: techInterval };
            if(techPeriod === 'CUSTOM'){
                _state.customFrom = document.getElementById('ta-from')?.value || '';
                _state.customTo   = document.getElementById('ta-to')?.value   || '';
            }
            _saveState('tech', _state);
            const barLabel = d.is_intraday
                ? `${d.ticker} · ${d.dates ? d.dates.length : 0} bars · ${(techInterval||'1d').toUpperCase()}`
                : `${d.ticker} · ${d.returns ? d.returns.filter(v=>v!=null).length : 0} sessions`;
            document.getElementById('distSubLabel').textContent = barLabel;
        })
        .catch(e=>{
            document.getElementById('tech-loading').style.display='none';
            sb.style.display='block';
            sb.innerHTML=`<span style="color:var(--red)">Error: ${e}</span>`;
        });
}

/* ══════════════════════════════════════════════════════════════════════════
   MORE DATA TAB — yfinance comprehensive dashboard
   ══════════════════════════════════════════════════════════════════════════ */

let _mdData = null;   // cached more-data response per ticker
let _mdTicker = '';

function switchTaView(view, btn){
    document.querySelectorAll('.ta-view-btn').forEach(b=>b.classList.remove('active'));
    if(btn) btn.classList.add('active');
    document.getElementById('ta-view-chart').style.display    = view==='chart'    ? '' : 'none';
    document.getElementById('ta-view-moredata').style.display = view==='moredata' ? '' : 'none';
    if(view === 'moredata'){
        const ticker = (document.getElementById('ticker')?.value||'').toUpperCase().trim();
        if(!ticker) return;
        // If ticker changed or no data yet, fetch
        if(_mdTicker !== ticker || !_mdData){
            _loadMoreData(ticker);
        }
    }
}

function _loadMoreData(ticker){
    _mdTicker = ticker;
    _mdData = null;
    const loading = document.getElementById('moredata-loading');
    const content = document.getElementById('moredata-content');
    if(loading) loading.style.display = 'flex';
    if(content) content.innerHTML = '';

    fetch(`/api/technical/${ticker}/moredata`)
        .then(r => r.json())
        .then(d => {
            if(loading) loading.style.display = 'none';
            if(d.error){
                if(content) content.innerHTML = `<div style="color:var(--red);padding:20px">⚠ ${d.error}</div>`;
                return;
            }
            _mdData = d;
            _renderMoreData(d, content);
        })
        .catch(e => {
            if(loading) loading.style.display = 'none';
            if(content) content.innerHTML = `<div style="color:var(--red);padding:20px">Error: ${e}</div>`;
        });
}

function _mdFmt(val, type){
    if(val === null || val === undefined) return '—';
    if(type === 'large'){
        const v = parseFloat(val);
        if(isNaN(v)) return '—';
        if(Math.abs(v)>=1e12) return (v/1e12).toFixed(2)+'T';
        if(Math.abs(v)>=1e9)  return (v/1e9).toFixed(2)+'B';
        if(Math.abs(v)>=1e6)  return (v/1e6).toFixed(2)+'M';
        if(Math.abs(v)>=1e3)  return (v/1e3).toFixed(2)+'K';
        return v.toFixed(2);
    }
    if(type === 'pct'){
        const v = parseFloat(val);
        if(isNaN(v)) return '—';
        return (v*100).toFixed(2)+'%';
    }
    if(type === 'price'){
        const v = parseFloat(val);
        if(isNaN(v)) return '—';
        return '$'+v.toFixed(2);
    }
    if(type === 'ratio'){
        const v = parseFloat(val);
        if(isNaN(v)) return '—';
        return v.toFixed(2)+'×';
    }
    if(type === 'int'){
        const v = parseInt(val);
        if(isNaN(v)) return '—';
        return v.toLocaleString();
    }
    return val != null ? String(val) : '—';
}

function _renderMoreData(d, container){
    const info = d.info || {};
    let html = '';

    // ── 1. Company Profile Card ──────────────────────────────────────────
    const sector   = info.sector || info.sectorDisp || '';
    const industry = info.industry || info.industryDisp || '';
    const country  = info.country || '';
    const exchange = info.exchange || info.fullExchangeName || '';
    const employees= info.fullTimeEmployees;
    const website  = info.website || '';
    const summary  = (info.longBusinessSummary || '').split(' ').slice(0,80).join(' ') + '…';
    const currency = info.currency || 'USD';
    const name     = info.longName || info.shortName || d.ticker;

    html += `<div class="md-profile-card">
        <div class="md-profile-header">
            <div class="md-profile-ticker">${d.ticker}</div>
            <div class="md-profile-name">${name}</div>
            <div class="md-profile-meta">
                ${sector  ? `<span class="md-tag">${sector}</span>` : ''}
                ${industry? `<span class="md-tag md-tag--dim">${industry}</span>` : ''}
                ${country ? `<span class="md-tag md-tag--dim">🌍 ${country}</span>` : ''}
                ${exchange? `<span class="md-tag md-tag--dim">${exchange}</span>` : ''}
                ${employees ? `<span class="md-tag md-tag--dim">👥 ${parseInt(employees).toLocaleString()} employees</span>` : ''}
                ${website  ? `<a class="md-tag md-tag--link" href="${website}" target="_blank" rel="noopener">↗ Website</a>` : ''}
            </div>
        </div>
        ${summary ? `<div class="md-profile-summary">${summary}</div>` : ''}
    </div>`;

    // ── 2. Key Metrics Grid ──────────────────────────────────────────────
    const metrics = [
        { label:'Market Cap',       val: _mdFmt(info.marketCap,'large'),        icon:'📊' },
        { label:'Enterprise Value', val: _mdFmt(info.enterpriseValue,'large'),   icon:'🏢' },
        { label:'Revenue (TTM)',    val: _mdFmt(info.totalRevenue,'large'),       icon:'💰' },
        { label:'Net Income',       val: _mdFmt(info.netIncomeToCommon,'large'),  icon:'📈' },
        { label:'P/E (Trailing)',   val: _mdFmt(info.trailingPE,'ratio'),         icon:'⚖' },
        { label:'P/E (Forward)',    val: _mdFmt(info.forwardPE,'ratio'),          icon:'🔭' },
        { label:'P/B Ratio',        val: _mdFmt(info.priceToBook,'ratio'),        icon:'📚' },
        { label:'EV / EBITDA',      val: _mdFmt(info.enterpriseToEbitda,'ratio'), icon:'📐' },
        { label:'PEG Ratio',        val: _mdFmt(info.pegRatio,'ratio'),           icon:'📉' },
        { label:'Beta',             val: info.beta != null ? parseFloat(info.beta).toFixed(2) : '—', icon:'β' },
        { label:'Gross Margin',     val: _mdFmt(info.grossMargins,'pct'),         icon:'📋' },
        { label:'Operating Margin', val: _mdFmt(info.operatingMargins,'pct'),     icon:'⚙' },
        { label:'Net Margin',       val: _mdFmt(info.profitMargins,'pct'),        icon:'💵' },
        { label:'ROE',              val: _mdFmt(info.returnOnEquity,'pct'),       icon:'🔄' },
        { label:'ROA',              val: _mdFmt(info.returnOnAssets,'pct'),       icon:'🏗' },
        { label:'Debt / Equity',    val: info.debtToEquity != null ? (parseFloat(info.debtToEquity)/100).toFixed(2)+'×' : '—', icon:'🔗' },
        { label:'Current Ratio',    val: info.currentRatio != null ? parseFloat(info.currentRatio).toFixed(2) : '—', icon:'💧' },
        { label:'Free Cash Flow',   val: _mdFmt(info.freeCashflow,'large'),       icon:'🌊' },
        { label:'Dividend Yield',   val: _mdFmt(info.dividendYield,'pct'),        icon:'💸' },
        { label:'Payout Ratio',     val: _mdFmt(info.payoutRatio,'pct'),          icon:'📤' },
        { label:'52W High',         val: _mdFmt(info.fiftyTwoWeekHigh,'price'),   icon:'⬆' },
        { label:'52W Low',          val: _mdFmt(info.fiftyTwoWeekLow,'price'),    icon:'⬇' },
        { label:'50D Avg',          val: _mdFmt(info.fiftyDayAverage,'price'),    icon:'〰' },
        { label:'200D Avg',         val: _mdFmt(info.twoHundredDayAverage,'price'),icon:'〰' },
    ];

    html += `<div class="md-section-title">Key Metrics</div>
    <div class="md-metrics-grid">
        ${metrics.map(m => `
        <div class="md-metric-card">
            <div class="md-metric-icon">${m.icon}</div>
            <div class="md-metric-label">${m.label}</div>
            <div class="md-metric-value">${m.val}</div>
        </div>`).join('')}
    </div>`;

    // ── 3. Revenue & Earnings Chart ──────────────────────────────────────
    const fin = d.financials;
    if(fin && fin.dates && fin.dates.length > 0){
        const revRow = fin.rows.find(r => r.item.toLowerCase().includes('total revenue') || r.item.toLowerCase().includes('revenue'));
        const niRow  = fin.rows.find(r => r.item.toLowerCase().includes('net income') && !r.item.toLowerCase().includes('non'));
        const gpRow  = fin.rows.find(r => r.item.toLowerCase().includes('gross profit'));

        if(revRow || niRow){
            html += `<div class="md-section-title">Annual Financials (Revenue · Gross Profit · Net Income)</div>
            <div class="md-chart-wrap"><div id="md-chart-financials" style="width:100%;height:320px"></div></div>`;
        }
    }

    // ── 4. Quarterly Financials ──────────────────────────────────────────
    html += `<div class="md-section-title">Financial Statements
        <span class="md-stmt-tabs" id="md-stmt-tabs">
            <button class="md-stmt-tab active" onclick="mdSetStmt('income','annual',this)">Income · Annual</button>
            <button class="md-stmt-tab" onclick="mdSetStmt('income','quarterly',this)">Income · Quarterly</button>
            <button class="md-stmt-tab" onclick="mdSetStmt('balance','annual',this)">Balance Sheet · Annual</button>
            <button class="md-stmt-tab" onclick="mdSetStmt('balance','quarterly',this)">Balance Sheet · Quarterly</button>
            <button class="md-stmt-tab" onclick="mdSetStmt('cashflow','annual',this)">Cash Flow · Annual</button>
            <button class="md-stmt-tab" onclick="mdSetStmt('cashflow','quarterly',this)">Cash Flow · Quarterly</button>
        </span>
    </div>
    <div id="md-stmt-content" class="md-stmt-wrap"></div>`;

    // ── 5. Analyst section ───────────────────────────────────────────────
    if(d.recommendations && d.recommendations.length > 0){
        // Try to find summary data (newer yfinance format has period/strongBuy/buy/hold/sell/strongSell)
        const hasGrade = d.recommendations[0] && 'period' in d.recommendations[0];
        if(hasGrade){
            const latest = d.recommendations[0];
            const total  = (latest.strongBuy||0)+(latest.buy||0)+(latest.hold||0)+(latest.sell||0)+(latest.strongSell||0);
            const pct    = v => total > 0 ? Math.round(v/total*100) : 0;
            html += `<div class="md-section-title">Analyst Consensus
                <span style="font-size:11px;color:var(--text-dim);margin-left:6px">Period: ${latest.period||'—'}</span>
            </div>
            <div class="md-analyst-bar-wrap">
                <div class="md-analyst-pills">
                    <div class="md-analyst-pill md-pill--sbuy">Strong Buy<span>${latest.strongBuy||0}</span></div>
                    <div class="md-analyst-pill md-pill--buy">Buy<span>${latest.buy||0}</span></div>
                    <div class="md-analyst-pill md-pill--hold">Hold<span>${latest.hold||0}</span></div>
                    <div class="md-analyst-pill md-pill--sell">Sell<span>${latest.sell||0}</span></div>
                    <div class="md-analyst-pill md-pill--ssell">Strong Sell<span>${latest.strongSell||0}</span></div>
                </div>
                <div class="md-analyst-bar">
                    <div class="md-abar-seg" style="width:${pct(latest.strongBuy||0)}%;background:#00B87A" title="Strong Buy ${pct(latest.strongBuy||0)}%"></div>
                    <div class="md-abar-seg" style="width:${pct(latest.buy||0)}%;background:#00D4AA" title="Buy ${pct(latest.buy||0)}%"></div>
                    <div class="md-abar-seg" style="width:${pct(latest.hold||0)}%;background:#FFB347" title="Hold ${pct(latest.hold||0)}%"></div>
                    <div class="md-abar-seg" style="width:${pct(latest.sell||0)}%;background:#FF7B54" title="Sell ${pct(latest.sell||0)}%"></div>
                    <div class="md-abar-seg" style="width:${pct(latest.strongSell||0)}%;background:#FF3D6B" title="Strong Sell ${pct(latest.strongSell||0)}%"></div>
                </div>
            </div>`;
        }
    }

    // Analyst price target
    const targetMean  = info.targetMeanPrice;
    const targetHigh  = info.targetHighPrice;
    const targetLow   = info.targetLowPrice;
    const currentPrice = info.currentPrice || info.regularMarketPrice;
    if(targetMean && currentPrice){
        const upside = ((targetMean - currentPrice) / currentPrice * 100).toFixed(1);
        const upsideColor = parseFloat(upside) >= 0 ? C.green : C.red;
        html += `<div class="md-price-target-row">
            <div class="md-pt-card">
                <div class="md-pt-label">Current Price</div>
                <div class="md-pt-value">${_mdFmt(currentPrice,'price')}</div>
            </div>
            <div class="md-pt-arrow">→</div>
            <div class="md-pt-range">
                <div class="md-pt-rangerow">
                    <span class="md-pt-label">Low Target</span>
                    <span>${_mdFmt(targetLow,'price')}</span>
                </div>
                <div class="md-pt-rangerow">
                    <span class="md-pt-label">Mean Target</span>
                    <span style="color:${upsideColor};font-weight:700">${_mdFmt(targetMean,'price')}
                        <span style="font-size:11px">(${upside}%)</span>
                    </span>
                </div>
                <div class="md-pt-rangerow">
                    <span class="md-pt-label">High Target</span>
                    <span>${_mdFmt(targetHigh,'price')}</span>
                </div>
            </div>
        </div>`;
    }

    // ── 6. Upgrades / Downgrades ─────────────────────────────────────────
    if(d.upgrades && d.upgrades.length > 0){
        html += `<div class="md-section-title">Recent Analyst Upgrades & Downgrades</div>
        <div class="md-table-wrap">
        <table class="md-table">
            <thead><tr>
                <th>Date</th><th>Firm</th><th>Action</th><th>From Grade</th><th>To Grade</th>
            </tr></thead>
            <tbody>
            ${d.upgrades.slice(0,15).map(u => {
                const action = (u.Action||u.action||'').toLowerCase();
                const acol = action.includes('up')?C.green:action.includes('down')?C.red:C.gold;
                return `<tr>
                    <td>${u.GradeDate||u.gradeDate||u.Date||'—'}</td>
                    <td>${u.Firm||u.firm||'—'}</td>
                    <td style="color:${acol};font-weight:600">${u.Action||u.action||'—'}</td>
                    <td style="color:var(--text-dim)">${u['From Grade']||u.fromGrade||'—'}</td>
                    <td style="color:var(--text-primary)">${u['To Grade']||u.toGrade||'—'}</td>
                </tr>`;
            }).join('')}
            </tbody>
        </table></div>`;
    }

    // ── 7. Institutional Holders ─────────────────────────────────────────
    if(d.institutional_holders && d.institutional_holders.length > 0){
        const cols = Object.keys(d.institutional_holders[0] || {});
        html += `<div class="md-section-title">Top Institutional Holders</div>
        <div class="md-table-wrap">
        <table class="md-table">
            <thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead>
            <tbody>
            ${d.institutional_holders.slice(0,10).map(row =>
                `<tr>${cols.map(c => `<td>${row[c]??'—'}</td>`).join('')}</tr>`
            ).join('')}
            </tbody>
        </table></div>`;
    }

    // ── 8. Major Holders ─────────────────────────────────────────────────
    if(d.major_holders && d.major_holders.length > 0){
        html += `<div class="md-section-title">Major Shareholders</div>
        <div class="md-table-wrap">
        <table class="md-table">
            <thead><tr>${Object.keys(d.major_holders[0]||{}).map(c=>`<th>${c}</th>`).join('')}</tr></thead>
            <tbody>
            ${d.major_holders.map(row =>
                `<tr>${Object.values(row).map(v=>`<td>${v??'—'}</td>`).join('')}</tr>`
            ).join('')}
            </tbody>
        </table></div>`;
    }

    // ── 9. Options info ───────────────────────────────────────────────────
    if(d.options_dates && d.options_dates.length > 0){
        html += `<div class="md-section-title">Options — Available Expiry Dates</div>
        <div class="md-options-chips">
            ${d.options_dates.map(dt => `<span class="md-options-chip">${dt}</span>`).join('')}
        </div>
        <div style="font-size:11px;color:var(--text-dim);margin:6px 0 18px">
            Options data available. Use a dedicated options chain tool to view puts/calls per strike.
        </div>`;
    }

    // ── 10. Earnings History ─────────────────────────────────────────────
    if(d.earnings_history && d.earnings_history.length > 0){
        const ecols = Object.keys(d.earnings_history[0]||{});
        html += `<div class="md-section-title">Earnings History</div>
        <div class="md-chart-wrap"><div id="md-chart-earnings" style="width:100%;height:260px"></div></div>
        <div class="md-table-wrap" style="margin-top:10px">
        <table class="md-table">
            <thead><tr>${ecols.map(c=>`<th>${c}</th>`).join('')}</tr></thead>
            <tbody>
            ${d.earnings_history.slice(0,16).map(row =>
                `<tr>${ecols.map(c => {
                    const v = row[c];
                    if(c.toLowerCase().includes('surprise') && v !== null){
                        const n = parseFloat(v);
                        const col = !isNaN(n) && n > 0 ? C.green : (!isNaN(n) && n < 0 ? C.red : 'inherit');
                        return `<td style="color:${col}">${v??'—'}</td>`;
                    }
                    return `<td>${v??'—'}</td>`;
                }).join('')}</tr>`
            ).join('')}
            </tbody>
        </table></div>`;
    }

    container.innerHTML = html;

    // ── Post-render: charts ──────────────────────────────────────────────
    _renderFinancialsChart(d);
    _renderEarningsHistChart(d);
    mdSetStmt('income', 'annual', document.querySelector('.md-stmt-tab'));
}

function _renderFinancialsChart(d){
    const el = document.getElementById('md-chart-financials');
    if(!el) return;
    const fin = d.financials;
    if(!fin || !fin.dates || !fin.dates.length) return;

    const dates  = fin.dates.slice().reverse();
    const revRow = fin.rows.find(r => /total.?revenue|^revenue$/i.test(r.item));
    const gpRow  = fin.rows.find(r => /gross.?profit/i.test(r.item));
    const niRow  = fin.rows.find(r => /^net.?income/i.test(r.item) && !/non/i.test(r.item));

    const toB = arr => arr ? arr.slice().reverse().map(v => v != null ? +(v/1e9).toFixed(2) : null) : [];
    const traces = [];
    if(revRow) traces.push({ x: dates, y: toB(revRow.values), name:'Revenue', type:'bar', marker:{color:C.blue+'99',line:{color:C.blue,width:1}}, yaxis:'y1' });
    if(gpRow)  traces.push({ x: dates, y: toB(gpRow.values),  name:'Gross Profit', type:'bar', marker:{color:C.cyan+'99',line:{color:C.cyan,width:1}}, yaxis:'y1' });
    if(niRow)  traces.push({ x: dates, y: toB(niRow.values),  name:'Net Income', type:'scatter', mode:'lines+markers',
        line:{color:C.gold,width:2}, marker:{size:7,color:C.gold}, yaxis:'y1' });

    const layout = {
        ...PLY, height:320, barmode:'group',
        xaxis:{ ...PLY_AXIS, type:'category' },
        yaxis:{ ...PLY_AXIS, title:{ text:'Billions (USD)', font:{size:11,color:'#527090'} } },
        legend:{ orientation:'h', x:0, y:1.08, font:{size:11}, bgcolor:'rgba(0,0,0,0)' },
        margin:{l:60,r:20,t:30,b:40},
    };
    Plotly.react('md-chart-financials', traces, layout, {responsive:true,displayModeBar:false});
}

function _renderEarningsHistChart(d){
    const el = document.getElementById('md-chart-earnings');
    if(!el || !d.earnings_history || !d.earnings_history.length) return;

    const rows = d.earnings_history.slice().reverse();
    const dates = rows.map(r => r.period || r.Period || r.quarter || '');
    const est = rows.map(r => {
        const v = r.epsEstimate || r['EPS Estimate'] || r.estimate;
        return v != null ? parseFloat(v) : null;
    });
    const act = rows.map(r => {
        const v = r.epsActual || r['EPS Actual'] || r.actual;
        return v != null ? parseFloat(v) : null;
    });

    const traces = [
        { x: dates, y: est, name:'EPS Estimate', type:'bar',
          marker:{color:C.gold+'66',line:{color:C.gold,width:1}} },
        { x: dates, y: act, name:'EPS Actual', type:'scatter', mode:'lines+markers',
          line:{color:C.cyan,width:2}, marker:{size:7,color:C.cyan} },
    ];
    const layout = {
        ...PLY, height:260, barmode:'group',
        xaxis:{ ...PLY_AXIS, type:'category' },
        yaxis:{ ...PLY_AXIS, title:{text:'EPS ($)',font:{size:11,color:'#527090'}} },
        legend:{ orientation:'h', x:0, y:1.08, font:{size:11}, bgcolor:'rgba(0,0,0,0)' },
        margin:{l:60,r:20,t:30,b:40},
    };
    Plotly.react('md-chart-earnings', traces, layout, {responsive:true,displayModeBar:false});
}

/* Switch between statement types in the More Data tab */
let _mdStmtMode = { type:'income', period:'annual' };
function mdSetStmt(type, period, btn){
    _mdStmtMode = { type, period };
    document.querySelectorAll('.md-stmt-tab').forEach(b=>b.classList.remove('active'));
    if(btn) btn.classList.add('active');
    if(!_mdData) return;

    const map = {
        'income-annual':     _mdData.financials,
        'income-quarterly':  _mdData.quarterly_financials,
        'balance-annual':    _mdData.balance_sheet,
        'balance-quarterly': _mdData.quarterly_balance,
        'cashflow-annual':   _mdData.cashflow,
        'cashflow-quarterly':_mdData.quarterly_cashflow,
    };
    const table = map[`${type}-${period}`] || { dates:[], rows:[] };
    const el = document.getElementById('md-stmt-content');
    if(!el) return;

    if(!table.dates || !table.dates.length){
        el.innerHTML = '<div style="color:var(--text-dim);padding:16px;font-size:13px">No data available for this view.</div>';
        return;
    }

    const formatCell = (v) => {
        if(v === null || v === undefined) return '—';
        const n = parseFloat(v);
        if(isNaN(n)) return String(v);
        const abs = Math.abs(n);
        const fmt = abs >= 1e9 ? (n/1e9).toFixed(2)+'B'
                  : abs >= 1e6 ? (n/1e6).toFixed(2)+'M'
                  : abs >= 1e3 ? (n/1e3).toFixed(2)+'K'
                  : n.toFixed(2);
        return `<span style="color:${n<0?C.red:'inherit'}">${fmt}</span>`;
    };

    el.innerHTML = `<div class="md-table-wrap">
    <table class="md-table md-table--stmt">
        <thead><tr>
            <th class="md-stmt-item-col">Item</th>
            ${table.dates.map(d=>`<th>${d}</th>`).join('')}
        </tr></thead>
        <tbody>
        ${table.rows.map(row => `<tr>
            <td class="md-stmt-item-col">${row.item}</td>
            ${row.values.map(v => `<td>${formatCell(v)}</td>`).join('')}
        </tr>`).join('')}
        </tbody>
    </table></div>`;
}

/* ── UI Controls ──────────────────────────────────────────────────────────── */
function setChartType(btn) {
    document.querySelectorAll('.ta-ctype-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    taChartType = btn.dataset.type;
    const isPnf = taChartType === 'pnf';
    document.getElementById('pnfOpts').style.display   = isPnf ? 'flex' : 'none';
    document.getElementById('overlayRow').style.display = isPnf ? 'none' : 'flex';
    document.getElementById('panelRow').style.display   = isPnf ? 'none' : 'flex';
    if (taData) buildTAChart();
}

function toggleOverlay(btn) {
    const ind = btn.dataset.ind;
    if (taOverlays.has(ind)) { taOverlays.delete(ind); btn.classList.remove('active'); }
    else                     { taOverlays.add(ind);    btn.classList.add('active'); }
    if (taData) buildTAChart();
}

function togglePanel(btn) {
    const panel = btn.dataset.panel;
    if (taPanels.has(panel)) { taPanels.delete(panel); btn.classList.remove('active'); }
    else                     { taPanels.add(panel);    btn.classList.add('active'); }
    if (taData) buildTAChart();
}

/* ── Stats grid ──────────────────────────────────────────────────────────── */
function renderTechStats(d){
    const s = d.stats;
    const rsiColor  = s.rsi > 70 ? C.red : s.rsi < 30 ? C.green : '#C8E4FF';
    const chgColor  = s.change_pct >= 0 ? C.green : C.red;
    const stochColor = s.stoch_k > 80 ? C.red : s.stoch_k < 20 ? C.green : '#C8E4FF';
    const macdColor  = s.macd_signal === 'Bullish' ? C.green : C.red;
    const items = [
        ['Close',     `$${s.latest_close}`,  chgColor,   `${s.change_pct >= 0?'+':''}${s.change_pct}%`],
        ['52W High',  `$${s.high_52w}`,      C.green,    ''],
        ['52W Low',   `$${s.low_52w}`,       C.red,      ''],
        ['Volatility',`${s.volatility}%`,    C.gold,     'annualized'],
        ['Sharpe',    `${s.sharpe}`,           s.sharpe>=1?C.green:s.sharpe>=0?C.gold:C.red,  'all volatility'],
        ['Sortino',   `${s.sortino??'—'}`,    (s.sortino??0)>=1?C.green:(s.sortino??0)>=0?C.gold:C.red, 'downside only'],
        ['Max DD',    `${s.max_drawdown}%`,  C.red,      'from peak'],
        ['RSI (14)',  `${s.rsi??'N/A'}`,     rsiColor,   s.rsi>70?'Overbought':s.rsi<30?'Oversold':'Neutral'],
        ['ATR (14)',  `$${s.atr??'N/A'}`,    C.orange,   'avg true range'],
        ['BB Width',  `${s.bb_width??0}%`,   C.purple,   'band squeeze'],
        ['Stoch %K',  `${s.stoch_k??'N/A'}`,stochColor,  s.stoch_k>80?'Overbought':s.stoch_k<20?'Oversold':'Neutral'],
        ['MACD',      s.macd_signal,          macdColor,  ''],
    ];
    document.getElementById('stats-grid').innerHTML = items.map(([l,v,col,sub])=>
        `<div class="stat-card">
            <div class="stat-card__label">${l}</div>
            <div class="stat-card__value" style="color:${col}">${v}</div>
            ${sub?`<div class="stat-card__sub">${sub}</div>`:''}
        </div>`
    ).join('');
}

// ── Category-axis tick generator (called from buildTAChart) ──────────────────
function _catAxisTicks(dates, isIntraday) {
    const n = dates.length;
    if (!n) return {};
    const targetTicks = Math.min(12, Math.max(4, Math.floor(n / 25)));
    const step = Math.max(1, Math.ceil(n / targetTicks));
    const tickvals = [], ticktext = [];
    for (let i = 0; i < n; i += step) {
        tickvals.push(i);
        const dt = dates[i] || '';
        if (isIntraday) {
            // "01-15 09:30" compact format
            const sp = dt.indexOf(' ');
            const dp = sp > 4 ? dt.slice(5, sp) : dt.slice(5, 10);  // MM-DD
            const tp = sp >= 0 ? dt.slice(sp + 1, sp + 6) : '';       // HH:MM
            ticktext.push(dp + (tp ? ' ' + tp : ''));
        } else {
            // "Jan '24" monthly label
            const ms = new Date(dt).getTime();
            ticktext.push(isNaN(ms) ? dt.slice(0, 7) :
                new Date(ms).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
        }
    }
    return { tickmode: 'array', tickvals, ticktext };
}

/* ── Main chart builder ──────────────────────────────────────────────────── */
function buildTAChart() {
    if (!taData) return;
    const p = loadTAPrefs();
    if (taChartType === 'pnf') { renderPnFChart(); return; }

    const d = taData;
    const traces  = [];
    const panelList = [...taPanels].filter(p =>
        ['volume','rsi','macd','stoch','obv','atr'].includes(p));
    const nPanels = panelList.length;

    // ── Compute subplot domains (price at top, panels below) ──────────────
    const GAP = 0.018;
    const PRICE_H = nPanels === 0 ? 1.0 : nPanels <= 2 ? 0.60 : 0.55;
    const avail = 1.0 - PRICE_H - GAP * nPanels;
    const panelH = nPanels > 0 ? avail / nPanels : 0;
    const priceDomain = [1.0 - PRICE_H, 1.0];

    const panelDomains = [];
    for (let i = 0; i < nPanels; i++) {
        const top    = priceDomain[0] - GAP - i * (panelH + GAP);
        const bottom = top - panelH;
        panelDomains.push([Math.max(0, bottom), top]);
    }

    // ── Price trace ─────────────────────────────────────────────────────
    const commonXY = { x: d.dates, xaxis: 'x', yaxis: 'y' };
    if (taChartType === 'candlestick') {
        traces.push({
            type: 'candlestick',
            name: d.ticker,
            x: d.dates,
            open: d.open, high: d.high, low: d.low, close: d.close,
            xaxis: 'x', yaxis: 'y',
            increasing: { line: { color: p.candleUpColor, width: +p.candleLineWidth }, fillcolor: p.candleUpColor + _hexOp(p.candleFillOpacity) },
            decreasing: { line: { color: p.candleDownColor, width: +p.candleLineWidth }, fillcolor: p.candleDownColor + _hexOp(p.candleFillOpacity) },
            whiskerwidth: 0.6,
            hoverinfo: 'x+y',
        });
    } else if (taChartType === 'ohlc') {
        traces.push({
            type: 'ohlc',
            name: d.ticker,
            x: d.dates,
            open: d.open, high: d.high, low: d.low, close: d.close,
            xaxis: 'x', yaxis: 'y',
            increasing: { line: { color: p.ohlcUpColor, width: +p.ohlcLineWidth } },
            decreasing: { line: { color: p.ohlcDownColor, width: +p.ohlcLineWidth } },
        });
    } else if (taChartType === 'area') {
        traces.push({
            type: 'scatter', mode: 'lines', name: d.ticker,
            x: d.dates, y: d.close,
            line: { color: p.areaFill, width: +p.lineWidth },
            fill: 'tozeroy', fillcolor: p.areaFill + _hexOp(p.areaOpacity),
            ...commonXY,
        });
    } else { // line
        traces.push({
            type: 'scatter', mode: 'lines', name: d.ticker,
            x: d.dates, y: d.close,
            line: { color: p.lineColor, width: +p.lineWidth, dash: p.lineDash === 'solid' ? undefined : p.lineDash },
            ...commonXY,
        });
    }

    // ── Overlay traces ───────────────────────────────────────────────────
    const overlayBase = { type:'scatter', mode:'lines', xaxis:'x', yaxis:'y',
                          hoverinfo:'skip', showlegend:true };
    if (taOverlays.has('sma20')) traces.push({...overlayBase,
        name:'SMA 20', x:d.dates, y:d.sma_20,
        line:{ color:p.sma20Color, width:+p.sma20Width, dash:p.sma20Dash }});
    if (taOverlays.has('sma50')) traces.push({...overlayBase,
        name:'SMA 50', x:d.dates, y:d.sma_50,
        line:{ color:p.sma50Color, width:+p.sma50Width, dash:p.sma50Dash }});
    if (taOverlays.has('sma200')) traces.push({...overlayBase,
        name:'SMA 200', x:d.dates, y:d.sma_200,
        line:{ color:p.sma200Color, width:+p.sma200Width, dash:p.sma200Dash }});
    if (taOverlays.has('ema9')) traces.push({...overlayBase,
        name:'EMA 9', x:d.dates, y:d.ema_9,
        line:{ color:p.ema9Color, width:+p.ema9Width, dash:p.ema9Dash }});
    if (taOverlays.has('ema20')) traces.push({...overlayBase,
        name:'EMA 20', x:d.dates, y:d.ema_20,
        line:{ color:p.ema20Color, width:+p.ema20Width, dash:p.ema20Dash }});
    if (taOverlays.has('vwap')) traces.push({...overlayBase,
        name:'VWAP 20d', x:d.dates, y:d.vwap,
        line:{ color:p.vwapColor, width:+p.vwapWidth, dash:p.vwapDash }});
    if (taOverlays.has('bb')) {
        traces.push({...overlayBase, name:'BB Upper', x:d.dates, y:d.bb_upper,
            line:{ color:p.bbColor, width:+p.bbLineWidth, dash:'dot' },
            fill:'none', showlegend:true });
        traces.push({...overlayBase, name:'BB Mid', x:d.dates, y:d.bb_mid,
            line:{ color:p.bbColor+'50', width:+p.bbLineWidth*0.8 }, showlegend:false });
        traces.push({...overlayBase, name:'BB Lower', x:d.dates, y:d.bb_lower,
            line:{ color:p.bbColor, width:+p.bbLineWidth, dash:'dot' },
            fill:'tonexty', fillcolor:p.bbColor+_hexOp(p.bbFillOpacity), showlegend:false });
    }

    // ── Panel traces ─────────────────────────────────────────────────────
    panelList.forEach((panel, i) => {
        const axisN  = i + 2;          // y2, y3, y4 ...
        const yref   = `y${axisN}`;
        const pb     = { xaxis:'x', yaxis:yref, hoverinfo:'x+y' };

        if (panel === 'volume') {
            const volColors = d.close.map((c,j) =>
                j===0 ? p.volUpColor+'80' : (c >= (d.close[j-1]||c) ? p.volUpColor+'88' : p.volDownColor+'88'));
            traces.push({ type:'bar', name:'Volume', x:d.dates, y:d.volume,
                marker:{ color: volColors, line:{ width:0 } },
                showlegend:true, ...pb });
        }
        if (panel === 'rsi') {
            traces.push({ type:'scatter', mode:'lines', name:'RSI', x:d.dates, y:d.rsi,
                line:{ color:p.rsiColor, width:+p.rsiWidth }, showlegend:true, ...pb });
            traces.push({ type:'scatter', mode:'lines', name:`OB ${p.rsiOB}`,
                x:d.dates, y:d.dates.map(()=>+p.rsiOB),
                line:{ color:C.red, width:0.8, dash:'dot' },
                fill:'none', showlegend:false, ...pb, hoverinfo:'skip' });
            traces.push({ type:'scatter', mode:'lines', name:`OS ${p.rsiOS}`,
                x:d.dates, y:d.dates.map(()=>+p.rsiOS),
                line:{ color:C.green, width:0.8, dash:'dot' },
                fill:'tonexty', fillcolor:C.green+'08', showlegend:false, ...pb, hoverinfo:'skip' });
        }
        if (panel === 'macd') {
            const histCol = d.macd_hist.map(v => v >= 0 ? p.macdHistUp+'CC' : p.macdHistDown+'CC');
            traces.push({ type:'bar', name:'MACD Hist', x:d.dates, y:d.macd_hist,
                marker:{ color:histCol, line:{width:0} }, showlegend:false, ...pb });
            traces.push({ type:'scatter', mode:'lines', name:'MACD', x:d.dates, y:d.macd,
                line:{ color:p.macdColor, width:+p.macdLineWidth }, showlegend:true, ...pb });
            traces.push({ type:'scatter', mode:'lines', name:'Signal', x:d.dates, y:d.macd_signal,
                line:{ color:p.macdSigColor, width:+p.macdSigWidth, dash:'dot' }, showlegend:true, ...pb });
        }
        if (panel === 'stoch') {
            traces.push({ type:'scatter', mode:'lines', name:'%K', x:d.dates, y:d.stoch_k,
                line:{ color:p.stochKColor, width:+p.stochKWidth }, showlegend:true, ...pb });
            traces.push({ type:'scatter', mode:'lines', name:'%D', x:d.dates, y:d.stoch_d,
                line:{ color:p.stochDColor, width:+p.stochDWidth, dash:'dot' }, showlegend:true, ...pb });
            traces.push({ type:'scatter', mode:'lines', name:`OB ${p.stochOB}`,
                x:d.dates, y:d.dates.map(()=>+p.stochOB),
                line:{ color:C.red, width:0.7, dash:'dot' },
                showlegend:false, ...pb, hoverinfo:'skip' });
            traces.push({ type:'scatter', mode:'lines', name:`OS ${p.stochOS}`,
                x:d.dates, y:d.dates.map(()=>+p.stochOS),
                line:{ color:C.green, width:0.7, dash:'dot' },
                showlegend:false, ...pb, hoverinfo:'skip' });
        }
        if (panel === 'obv') {
            traces.push({ type:'scatter', mode:'lines', name:'OBV (M)', x:d.dates, y:d.obv,
                line:{ color:p.obvColor, width:+p.obvWidth },
                fill:'tozeroy', fillcolor:p.obvColor+_hexOp(8), showlegend:true, ...pb });
        }
        if (panel === 'atr') {
            traces.push({ type:'scatter', mode:'lines', name:'ATR (14)', x:d.dates, y:d.atr,
                line:{ color:p.atrColor, width:+p.atrWidth },
                fill:'tozeroy', fillcolor:p.atrColor+_hexOp(8), showlegend:true, ...pb });
        }
    });

    // ── Build layout ─────────────────────────────────────────────────────
    const panelLabels = { volume:'Volume', rsi:'RSI (0-100)',
        macd:'MACD', stoch:'Stoch (0-100)', obv:'OBV (M)', atr:'ATR' };

    const dynAxis = {
        ...PLY_AXIS,
        gridcolor: p.gridColor,
        gridwidth: +p.gridWidth,
        zerolinecolor: p.gridColor,
    };
    const yAxisBase = {
        ...dynAxis, fixedrange: false,
        title: { font: { size: 10, color: p.xhairColor } },
    };

    // Compute explicit x-range from data — prevents black space on period switch
    const _xFirst = d.dates && d.dates.length ? d.dates[0] : null;
    const _xLast  = d.dates && d.dates.length ? d.dates[d.dates.length - 1] : null;

    const layout = {
        ...PLY,
        uirevision: `${d.ticker}-${techPeriod}-${techInterval}-${d.dates ? d.dates.length : 0}`,
        plot_bgcolor: p.plotBg,
        height: Math.max(+p.minHeight, _taChartHeight(nPanels)),
        xaxis: {
            ...dynAxis,
            // category type = equal bar spacing, no weekend/holiday gaps
            type: 'category',
            range: [-0.5, (d.dates ? d.dates.length : 1) - 0.5],
            autorange: false,
            ...(_catAxisTicks(d.dates || [], d.is_intraday)),
            tickangle: (d.is_intraday) ? -35 : 0,
            rangeslider: { visible: false },
            domain: [0, 1],
            anchor: nPanels > 0 ? `y${nPanels+1}` : 'y',
            showspikes: true, spikemode:'across', spikethick:1,
            spikecolor:'#527090', spikedash:'dot',
        },
        yaxis: {
            ...yAxisBase,
            domain: priceDomain,
            autorange: true,
            title: { text: 'Price', font:{size:10,color:'#527090'} },
            tickformat: d.is_intraday ? '$.3f' : '$.2f',
        },
        shapes: [],
        annotations: [],
    };

    // RSI / Stoch reference lines as shapes
    panelList.forEach((panel, i) => {
        const axisN = i + 2;
        const dom   = panelDomains[i];
        layout[`yaxis${axisN}`] = {
            ...yAxisBase,
            domain: dom,
            title: { text: panelLabels[panel]||panel, font:{size:9,color:'#527090'} },
            ...(panel === 'rsi'   ? { range:[0,100], fixedrange:true } : {}),
            ...(panel === 'stoch' ? { range:[0,100], fixedrange:true } : {}),
        };
        layout.xaxis.anchor = `y${nPanels+1}`;
    });

    // When panels share x-axis properly
    if (nPanels > 0) {
        layout.xaxis.anchor = `y${nPanels + 1}`;
        // Re-anchor to bottommost panel
        for (let i = nPanels - 1; i >= 0; i--) {
            const axisN = i + 2;
            const isLast = (i === nPanels - 1);
            layout[`yaxis${axisN}`].anchor = isLast ? 'x' : 'free';
            if (!isLast) layout[`yaxis${axisN}`].position = 0;
        }
        // price yaxis floats
        layout.yaxis.anchor = 'free';
        layout.yaxis.position = 0;
    }

    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['select2d','lasso2d','autoScale2d'],
        modeBarButtonsToAdd: [],
        displaylogo: false,
        scrollZoom: true,
        toImageButtonOptions: { format:'png', scale:2, filename: `${d.ticker}_chart` }
    };

    Plotly.react('ta-plotly-chart', traces, layout, config);

    // Store OHLC snap data for trendline magnetic snap
    _taSnapData = {
        dates:  d.dates  || [],
        highs:  d.high   || [],
        lows:   d.low    || [],
        closes: d.close  || [],
        firstDate: d.dates && d.dates.length ? d.dates[0] : null,
        lastDate:  d.dates && d.dates.length ? d.dates[d.dates.length - 1] : null,
    };

    // Re-apply any drawings after chart re-renders
    if (typeof _applyDrawingsToChart === 'function') {
        setTimeout(_applyDrawingsToChart, 150);
    }
}

function _taChartHeight(nPanels) {
    return Math.max(560, 480 + nPanels * 120);
}

/* ── Point & Figure ──────────────────────────────────────────────────────── */
function computePnF(dates, highs, lows, closes, boxPct, reversal) {
    const columns = [];
    const validIdx = closes.map((c,i)=>[c,i]).filter(([c])=>c!=null);
    if (!validIdx.length) return columns;

    // Determine box size (percentage-based, relative to first price)
    const firstPrice = validIdx[0][0];
    const boxSize    = firstPrice * boxPct / 100;

    function roundBox(price) {
        return Math.round(price / boxSize) * boxSize;
    }

    let dir      = null;  // 'X' or 'O'
    let curTop   = roundBox(firstPrice);
    let curBot   = curTop;
    let colIdx   = 0;
    let colBoxes = [];   // price levels in current column

    for (let ii = 1; ii < validIdx.length; ii++) {
        const [close, di] = validIdx[ii];
        const hi = roundBox(highs[di]);
        const lo = roundBox(lows[di]);
        const dt = dates[di];

        if (dir === null) {
            if (hi >= curTop + boxSize) {
                dir = 'X';
                for (let p = curTop + boxSize; p <= hi; p += boxSize) {
                    colBoxes.push({ y: p, date: dt });
                    curTop = p;
                }
            } else if (lo <= curBot - boxSize) {
                dir = 'O';
                for (let p = curBot - boxSize; p >= lo; p -= boxSize) {
                    colBoxes.push({ y: p, date: dt });
                    curBot = p;
                }
            }
        } else if (dir === 'X') {
            if (hi >= curTop + boxSize) {
                const n = Math.floor((hi - curTop) / boxSize);
                for (let b = 0; b < n; b++) {
                    curTop += boxSize;
                    colBoxes.push({ y: curTop, date: dt });
                }
            } else if (lo <= curTop - reversal * boxSize) {
                columns.push({ dir, colIdx, boxes: colBoxes, top: curTop, bot: curTop - (colBoxes.length-1)*boxSize });
                colIdx++;
                const newBot = roundBox(curTop - reversal * boxSize);
                colBoxes = [];
                for (let p = curTop - boxSize; p >= newBot; p -= boxSize) {
                    colBoxes.push({ y: p, date: dt });
                }
                curBot = newBot; curTop = curTop - boxSize;
                dir = 'O';
            }
        } else { // dir === 'O'
            if (lo <= curBot - boxSize) {
                const n = Math.floor((curBot - lo) / boxSize);
                for (let b = 0; b < n; b++) {
                    curBot -= boxSize;
                    colBoxes.push({ y: curBot, date: dt });
                }
            } else if (hi >= curBot + reversal * boxSize) {
                columns.push({ dir, colIdx, boxes: colBoxes, top: curBot + (colBoxes.length-1)*boxSize, bot: curBot });
                colIdx++;
                const newTop = roundBox(curBot + reversal * boxSize);
                colBoxes = [];
                for (let p = curBot + boxSize; p <= newTop; p += boxSize) {
                    colBoxes.push({ y: p, date: dt });
                }
                curTop = newTop; curBot = curBot + boxSize;
                dir = 'X';
            }
        }
    }
    if (colBoxes.length) {
        columns.push({ dir: dir||'X', colIdx, boxes: colBoxes,
            top: dir==='X' ? curTop : curBot+(colBoxes.length-1)*boxSize,
            bot: dir==='O' ? curBot : curTop-(colBoxes.length-1)*boxSize });
    }
    return columns;
}

function renderPnFChart() {
    const d        = taData;
    const boxPct   = parseFloat(document.getElementById('pnfBoxPct')?.value || 1);
    const reversal = parseInt(document.getElementById('pnfReversal')?.value || 3);
    const cols     = computePnF(d.dates, d.high, d.low, d.close, boxPct, reversal);

    if (!cols.length) {
        document.getElementById('ta-plotly-chart').innerHTML =
            `<div style="padding:60px;text-align:center;color:#527090">
                Not enough price movement for P&F chart with ${boxPct}% box size.
                Try a smaller box size or longer period.
            </div>`;
        return;
    }

    // Build scatter traces — one per column
    const xTraces = [];
    const oTraces = [];

    cols.forEach(col => {
        const xCoord = col.colIdx;
        const ys = col.boxes.map(b => b.y);
        const dates = col.boxes.map(b => b.date);
        const trace = {
            type: 'scatter', mode: 'markers+text',
            x: ys.map(() => xCoord),
            y: ys,
            text: ys.map(() => col.dir === 'X' ? 'X' : 'O'),
            textposition: 'middle center',
            textfont: { family:"'DM Sans'", size:11,
                color: col.dir === 'X' ? C.green : C.red },
            marker: { size: 14, opacity: 0, symbol:'square' },
            hovertext: dates.map((dt,i)=>`${col.dir} at $${ys[i].toFixed(2)}<br>${dt}`),
            hoverinfo: 'text',
            showlegend: false,
            name: `${col.dir}${col.colIdx}`,
        };
        if (col.dir === 'X') xTraces.push(trace);
        else                  oTraces.push(trace);
    });

    const allTraces = [...xTraces, ...oTraces];

    // X-axis ticks: every 5th column
    const tickVals = cols.filter((c,i)=>i%5===0).map(c=>c.colIdx);
    const tickText = cols.filter((c,i)=>i%5===0).map(c=>c.boxes[0]?.date?.slice(0,7)||'');

    const layout = {
        ...PLY,
        height: 620,
        title: {
            text: `${d.ticker} — Point & Figure (${boxPct}% box, ${reversal}× reversal)`,
            font:{ size:14, color:'#C8E4FF' }, x:0.02
        },
        xaxis: {
            ...PLY_AXIS, title:{ text:'Column', font:{size:10,color:'#527090'} },
            tickvals: tickVals, ticktext: tickText,
            showgrid:true, gridcolor:'#0F1D35',
        },
        yaxis: {
            ...PLY_AXIS, title:{ text:'Price ($)', font:{size:10,color:'#527090'} },
            tickformat:'$.2f',
        },
        annotations: cols.map(col => ({
            x: col.colIdx,
            y: col.boxes[col.boxes.length-1]?.y ?? 0,
            text: col.dir === 'X' ? '▲' : '▼',
            font: { size:9, color: col.dir==='X'?C.green:C.red },
            showarrow:false, yanchor:'bottom',
        })),
    };

    Plotly.react('ta-plotly-chart', allTraces, layout,
        { responsive:true, displayModeBar:true, displaylogo:false, scrollZoom:true });
}

/* ── Distribution chart (keep Chart.js) ─────────────────────────────────── */
function renderDist(d){
    destroyChart('dist');
    const ctx = document.getElementById('chart-dist');
    // Pair returns with their dates, dropping nulls
    const paired = (d.dates || [])
        .map((dt, i) => ({ date: dt, ret: d.returns[i] }))
        .filter(p => p.ret !== null && p.ret !== undefined);
    const returns = paired.map(p => p.ret);
    if (!returns.length) return;
    const min_r = Math.min(...returns), max_r = Math.max(...returns);
    const bins = 60, step = (max_r - min_r) / bins;
    const labels = [], counts = [], colors = [];
    const dateBins = []; // one array of dates per bin
    for(let i = 0; i < bins; i++){
        const mid = min_r + step * i + step / 2;
        labels.push(mid.toFixed(2) + '%');
        counts.push(0);
        colors.push(mid >= 0 ? C.green + '99' : C.red + '88');
        dateBins.push([]);
    }
    paired.forEach(({ date, ret }) => {
        const idx = Math.min(bins - 1, Math.floor((ret - min_r) / step));
        counts[idx]++;
        dateBins[idx].push(date);
    });
    charts.dist = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{
            data: counts, backgroundColor: colors, borderWidth: 0, borderRadius: 2,
        }]},
        options: { ...chartDefaults,
            plugins: { ...chartDefaults.plugins,
                legend: { display: false },
                annotation: undefined,
                tooltip: {
                    ...chartDefaults.plugins?.tooltip,
                    callbacks: {
                        title: items => {
                            const i = items[0].dataIndex;
                            const datesInBin = dateBins[i];
                            if (!datesInBin.length) return `Return: ${labels[i]}`;
                            // Show up to 6 dates; if more, summarise
                            const MAX = 6;
                            const shown = datesInBin.slice(0, MAX);
                            const extra = datesInBin.length - MAX;
                            const dateStr = shown.join('  ·  ') + (extra > 0 ? `  (+${extra} more)` : '');
                            return [`Return: ${labels[i]}`, dateStr];
                        },
                        label: ctx => `  Occurrences: ${ctx.parsed.y}`,
                    },
                },
            },
            scales: { ...chartDefaults.scales,
                x: { ...chartDefaults.scales.x,
                    ticks: { ...chartDefaults.scales.x.ticks, maxTicksLimit: 10 }
                },
                y: { ...chartDefaults.scales.y, title: { display: true, text: 'Frequency',
                    color: '#527090', font: { size: 10, family: "'DM Sans'" } }
                }
            }
        }
    });
}

/* ═══════════════════════════════════════════════════════════════════════════
   FUNDAMENTALS — XBRL LINE ITEM CHARTING
   ═══════════════════════════════════════════════════════════════════════════ */
let fundOpts = { ctype: 'line', period: 0, scale: 'auto' };

/* ── Load ticker data ── */
function runFund() {
    const ticker = document.getElementById('fund-ticker')?.value?.toUpperCase()?.trim();
    if (!ticker) return;
    document.getElementById('fund-loading').style.display = 'flex';
    document.getElementById('fund-content').style.display = 'none';
    document.getElementById('fund-status').textContent = '';
    fetch(`/api/fundamentals/${ticker}`)
        .then(r => r.json())
        .then(d => {
            document.getElementById('fund-loading').style.display = 'none';
            if (d.error) { document.getElementById('fund-status').textContent = 'Error: ' + d.error; return; }
            fundData     = d;
            fundAllItems = d.line_items;
            document.getElementById('fund-content').style.display = 'block';
            document.getElementById('fund-status').textContent =
                `${d.ticker} — ${d.line_items.length} XBRL line items loaded`;
            _renderCompanyInfo(d.info || {}, d.ticker);
            _fundPopulateSelects(d.line_items);
            /* persist ticker immediately so panel navigation always restores it.
               loadFundSeries() will overwrite this with the full state (item, opts…)
               once a series is charted. */
            const _existing = _loadState('fund') || {};
            _saveState('fund', { ..._existing, ticker });
            /* restore statement tab + period from saved state if available */
            if (_existing.stmtType)   _stmtType   = _existing.stmtType;
            if (_existing.stmtPeriod) _stmtPeriod = _existing.stmtPeriod;
            /* auto-load ratios + active statement tab */
            loadRatios();
            loadStatements(_stmtType, document.getElementById('stmt-btn-' + _stmtType));
            /* restore saved chart state when navigating back */
            if (window._fundRestoreItem) {
                const rs = window._fundRestoreItem;
                window._fundRestoreItem = null;
                if (rs.opts) {
                    fundOpts = { ...fundOpts, ...rs.opts };
                    document.querySelectorAll('[data-ctype]').forEach(b=>b.classList.toggle('active',b.dataset.ctype===fundOpts.ctype));
                    document.querySelectorAll('[data-cperiod]').forEach(b=>b.classList.toggle('active',+b.dataset.cperiod===fundOpts.period));
                    document.querySelectorAll('[data-scale]').forEach(b=>b.classList.toggle('active',b.dataset.scale===fundOpts.scale));
                }
                const tlEl=document.getElementById('fund-trendline');   if(tlEl) tlEl.checked=rs.trendline||false;
                const dlEl=document.getElementById('fund-datalabels');  if(dlEl) dlEl.checked=rs.datalabels||false;
                if (rs.compareMode) {
                    const cmEl=document.getElementById('fund-compare-mode');
                    if(cmEl){cmEl.checked=true;toggleFundCompare(cmEl);}
                    const e2=document.getElementById('fund-item-2'); if(e2&&rs.item2) e2.value=rs.item2;
                    const e3=document.getElementById('fund-item-3'); if(e3&&rs.item3) e3.value=rs.item3;
                }
                if (rs.item) {
                    const sel=document.getElementById('fund-item-select');
                    if(sel) sel.value=rs.item;
                    loadFundSeries();
                }
            }
        })
        .catch(e => {
            document.getElementById('fund-loading').style.display = 'none';
            document.getElementById('fund-status').textContent = 'Error: ' + e;
        });
}

function _renderCompanyInfo(info, ticker) {
    const card = document.getElementById('fund-company-card');
    if (!card) return;

    const name   = info.name || ticker;
    const desc   = info.description || '';
    const sector = info.sector || '';
    const exch   = info.exchange ? info.exchange.replace('XNAS','NASDAQ').replace('XNYS','NYSE').replace('XASE','AMEX') : '';
    const emp    = info.employees ? Number(info.employees).toLocaleString() + ' employees' : '';
    const mcap   = info.market_cap ? '$' + fmtLarge(info.market_cap) + ' mkt cap' : '';
    const listed = info.list_date ? 'Listed ' + info.list_date.slice(0,4) : '';

    const metaParts = [exch, sector, mcap, emp, listed].filter(Boolean);

    document.getElementById('fund-co-name').textContent = name;
    document.getElementById('fund-co-meta').innerHTML = metaParts
        .map((p, i) => `<span class="fund-co-pill">${p}</span>` + (i < metaParts.length - 1 ? '' : ''))
        .join('');
    document.getElementById('fund-co-desc').textContent = desc || 'No description available.';

    const linkEl = document.getElementById('fund-co-link');
    if (info.homepage) {
        linkEl.href = info.homepage.startsWith('http') ? info.homepage : 'https://' + info.homepage;
        linkEl.style.display = 'inline-flex';
    } else {
        linkEl.style.display = 'none';
    }

    card.style.display = 'block';
}

function _fundPopulateSelects(items) {
    const opts = items.map(i => `<option value="${i}">${i}</option>`).join('');
    document.getElementById('fund-item-select').innerHTML = opts;
    const none = '<option value="">— none —</option>';
    ['fund-item-2', 'fund-item-3'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = none + opts;
    });
}

function filterFundItems() {
    const q = document.getElementById('fund-filter').value.toLowerCase();
    _fundPopulateSelects(fundAllItems.filter(i => i.toLowerCase().includes(q)));
}

/* ── Option toggles ── */
function setFundOpt(key, val, btn) {
    fundOpts[key] = val;
    btn.closest('.controls__row').querySelectorAll(`[data-c${key}]`)
       .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

function toggleFundCompare(cb) {
    document.getElementById('fund-compare-row').style.display = cb.checked ? 'flex' : 'none';
}

/* ── Scale helpers ── */
function _fundDivisor(values) {
    if (fundOpts.scale === 'B') return 1e9;
    if (fundOpts.scale === 'M') return 1e6;
    const mx = Math.max(...values.map(Math.abs).filter(isFinite));
    if (mx >= 5e9) return 1e9;
    if (mx >= 5e6) return 1e6;
    if (mx >= 5e3) return 1e3;
    return 1;
}
function _fundSuffix(divisor) {
    return divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : divisor === 1e3 ? 'K' : '';
}

/* ── Period filter ── */
function _fundFilterPeriod(labels, values) {
    if (!fundOpts.period) return { labels, values };
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - fundOpts.period);
    const pairs = labels.map((l, i) => ({ l, v: values[i] }))
                        .filter(p => new Date(p.l) >= cutoff);
    return { labels: pairs.map(p => p.l), values: pairs.map(p => p.v) };
}

/* ── Linear trendline ── */
function _fundTrend(values) {
    const n = values.length;
    if (n < 3) return null;
    const mx = (n - 1) / 2;
    const my = values.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    values.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
    const slope = den ? num / den : 0;
    const ic    = my - slope * mx;
    return values.map((_, x) => +(slope * x + ic).toFixed(4));
}

/* ── Main chart function ── */
async function loadFundSeries() {
    if (!fundData) return;
    const item1 = document.getElementById('fund-item-select').value;
    if (!item1) return;
    /* snapshot the current state so coming back to this tab restores it */
    _saveState('fund', {
        ticker:      document.getElementById('fund-ticker')?.value || fundData.ticker,
        item:        item1,
        opts:        { ...fundOpts },
        trendline:   document.getElementById('fund-trendline')?.checked   || false,
        datalabels:  document.getElementById('fund-datalabels')?.checked  || false,
        compareMode: document.getElementById('fund-compare-mode')?.checked || false,
        item2:       document.getElementById('fund-item-2')?.value  || '',
        item3:       document.getElementById('fund-item-3')?.value  || '',
        stmtType:    _stmtType,
        stmtPeriod:  _stmtPeriod,
    });

    const compareOn = document.getElementById('fund-compare-mode')?.checked;
    const item2 = compareOn ? document.getElementById('fund-item-2').value : '';
    const item3 = compareOn ? document.getElementById('fund-item-3').value : '';
    const showTrend  = document.getElementById('fund-trendline')?.checked;
    const showLabels = document.getElementById('fund-datalabels')?.checked;

    const fetchS = item => fetch(`/api/fundamentals/${fundData.ticker}/series/${encodeURIComponent(item)}`).then(r => r.json());

    const s1 = await fetchS(item1);
    if (s1.error) { alert(s1.error); return; }
    const allSeries = [s1];
    if (item2) { const s = await fetchS(item2); if (!s.error) allSeries.push(s); }
    if (item3) { const s = await fetchS(item3); if (!s.error) allSeries.push(s); }

    /* filter + scale each series independently */
    const COLORS  = [C.blue, C.gold, C.cyan];
    const FILL_BG = ['rgba(40,128,255,0.12)', 'rgba(255,176,32,0.10)', 'rgba(0,192,255,0.10)'];
    const datasets = [];
    let divisor = 1, suffix = '';

    allSeries.forEach((s, idx) => {
        const rawLabels = s.labels?.length ? s.labels : s.periods;
        const { labels: fl, values: fv } = _fundFilterPeriod(rawLabels, s.values);
        if (idx === 0) {
            divisor = _fundDivisor(fv);
            suffix  = _fundSuffix(divisor);
        }
        const scaled = fv.map(v => +(v / divisor).toFixed(4));
        const col    = COLORS[idx % COLORS.length];
        const name   = suffix ? `${s.line_item} (${suffix})` : s.line_item;
        const isBar  = fundOpts.ctype === 'bar';

        if (isBar) {
            datasets.push({
                label: name, data: scaled, type: 'bar',
                backgroundColor: col + '88', borderColor: col,
                borderWidth: 1.5, borderRadius: 3,
            });
        } else {
            datasets.push({
                label: name, data: scaled, type: 'line',
                borderColor: col, borderWidth: 2.5,
                backgroundColor: allSeries.length === 1 ? FILL_BG[0] : 'transparent',
                fill: allSeries.length === 1,
                tension: 0.35,
                pointRadius: fl.length > 24 ? 2 : 4,
                pointBackgroundColor: col,
                pointHoverRadius: 6,
            });
        }

        /* trend line — only on primary, line mode */
        if (idx === 0 && showTrend && !isBar) {
            const trendVals = _fundTrend(scaled);
            if (trendVals) {
                datasets.push({
                    label: 'Trend', data: trendVals, type: 'line',
                    borderColor: 'rgba(255,80,80,0.75)', borderWidth: 1.5,
                    borderDash: [5, 4], pointRadius: 0, fill: false, tension: 0,
                });
            }
        }
    });

    /* labels come from primary series after period filter */
    const { labels: finalLabels, values: finalVals } =
        _fundFilterPeriod(s1.labels?.length ? s1.labels : s1.periods, s1.values);

    const titleText = allSeries.length === 1
        ? `${s1.ticker}  ·  ${s1.line_item}${suffix ? '  (' + suffix + ')' : ''}`
        : `${s1.ticker}  ·  Comparison${suffix ? '  (' + suffix + ')' : ''}`;

    // ── Rebuild as Plotly traces ──
    const isBar  = fundOpts.ctype === 'bar';
    const isArea = fundOpts.ctype === 'area';
    const plotlyTraces = [];

    allSeries.forEach((s, idx) => {
        const rawLabels = s.labels?.length ? s.labels : s.periods;
        const { labels: fl, values: fv } = _fundFilterPeriod(rawLabels, s.values);
        const scaledHere = fv.map(v => +(v / divisor).toFixed(4));
        const col  = COLORS[idx % COLORS.length];
        const name = suffix ? `${s.line_item} (${suffix})` : s.line_item;
        const fmtV = v => Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'K' : v.toFixed(2);

        if(isBar){
            plotlyTraces.push({
                x: fl, y: scaledHere, name,
                type: 'bar',
                marker: { color: col + '99', line: { color: col, width: 1 } },
                text: showLabels ? scaledHere.map(fmtV) : undefined,
                textposition: showLabels ? 'outside' : undefined,
                textfont: showLabels ? { size: 9, color: '#A8C4E0' } : undefined,
                hovertemplate: `%{x}<br><b>${name}:</b> %{y:.3s}${suffix?' '+suffix:''}<extra></extra>`,
            });
        } else {
            plotlyTraces.push({
                x: fl, y: scaledHere, name,
                type: 'scatter',
                mode: showLabels ? 'lines+markers+text' : 'lines+markers',
                line: { color: col, width: 2.5 },
                marker: { color: col, size: fl.length > 24 ? 4 : 6 },
                fill: (idx === 0 && isArea && allSeries.length === 1) ? 'tozeroy' : 'none',
                fillcolor: (idx === 0 && isArea) ? FILL_BG[0] : undefined,
                text: showLabels ? scaledHere.map(fmtV) : undefined,
                textposition: showLabels ? 'top center' : undefined,
                textfont: showLabels ? { size: 9, color: '#A8C4E0' } : undefined,
                hovertemplate: `%{x}<br><b>${name}:</b> %{y:.3s}${suffix?' '+suffix:''}<extra></extra>`,
            });
        }

        // Trend line — primary series, line mode only
        if(idx === 0 && showTrend && !isBar){
            const scaledPrimary = finalVals.map(v => +(v / divisor).toFixed(4));
            const trendVals = _fundTrend(scaledPrimary);
            if(trendVals){
                plotlyTraces.push({
                    x: finalLabels, y: trendVals, name: 'Trend',
                    type: 'scatter', mode: 'lines',
                    line: { color: 'rgba(255,80,80,0.75)', width: 1.5, dash: 'dot' },
                    hovertemplate: '%{x}<br><b>Trend:</b> %{y:.3s}<extra></extra>',
                });
            }
        }
    });

    const axBase = {
        gridcolor: '#0F1D35', gridwidth: 0.5,
        linecolor: '#152038', tickcolor: '#152038',
        tickfont: { size: 10, color: '#527090', family: "'DM Sans', sans-serif" },
        zeroline: false,
    };

    const fundLayout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor:  '#060E1C',
        font: { family: "'DM Sans', sans-serif", size: 11, color: '#527090' },
        margin: { l: 72, r: 20, t: 50, b: 60 },
        autosize: true,
        title: {
            text: titleText,
            font: { family: "'DM Sans', sans-serif", size: 15, color: '#C8E4FF' },
            x: 0.02, xanchor: 'left',
        },
        showlegend: allSeries.length > 1 || showTrend,
        legend: { font: { size: 11, color: '#8BAFC7' }, bgcolor: 'rgba(0,0,0,0)', x: 0.01, y: 0.99 },
        xaxis: { ...axBase, rangeslider: { visible: false } },
        yaxis: { ...axBase, automargin: true, hoverformat: '.3s' },
        hovermode: 'x unified',
        hoverlabel: {
            bgcolor: '#0C1929', bordercolor: '#152038',
            font: { family: "'DM Sans', sans-serif", size: 11, color: '#C8E4FF' }
        },
        bargap: 0.3,
    };

    Plotly.react('chart-fund-series', plotlyTraces, fundLayout, {
        responsive: true, displaylogo: false,
        modeBarButtonsToRemove: ['toImage','sendDataToCloud','editInChartStudio','select2d','lasso2d'],
    });

    /* stats strip */
    _fundRenderStats(s1.line_item, finalLabels, finalVals, divisor, suffix);
}

/* ── Stats strip below chart ── */
function _fundRenderStats(name, labels, rawVals, divisor, suffix) {
    const el = document.getElementById('fund-series-stats');
    if (!rawVals?.length) { el.style.display = 'none'; return; }

    const latest   = rawVals[rawVals.length - 1];
    const prev     = rawVals[rawVals.length - 2];
    const first    = rawVals[0];
    const latestLbl = labels[labels.length - 1] || '';

    const chg    = (prev != null && prev !== 0) ? (latest - prev) / Math.abs(prev) * 100 : null;
    const chgCol = chg === null ? 'var(--text-dim)' : chg >= 0 ? C.green : C.red;
    const chgStr = chg !== null ? `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%` : '—';

    let cagr = null;
    const n = rawVals.length;
    if (n >= 2 && first > 0 && latest > 0) {
        cagr = (Math.pow(latest / first, 1 / (n - 1)) - 1) * 100;
    }
    const cagrStr = cagr !== null ? `${cagr >= 0 ? '+' : ''}${cagr.toFixed(1)}%` : '—';

    const fmt = v => {
        const sv = v / divisor;
        if (Math.abs(sv) >= 1000) return (sv / 1000).toFixed(1) + 'K' + (suffix ? ' ' + suffix : '');
        return sv.toFixed(2) + (suffix ? ' ' + suffix : '');
    };

    el.style.display = 'block';
    el.innerHTML = `<div class="fund-stats-row">
        <div class="fund-stat">
            <span class="fund-stat__lbl">Latest</span>
            <span class="fund-stat__val" style="color:var(--cyan)">${fmt(latest)}</span>
            <span class="fund-stat__period">${latestLbl}</span>
        </div>
        <div class="fund-stat">
            <span class="fund-stat__lbl">Period Change</span>
            <span class="fund-stat__val" style="color:${chgCol}">${chgStr}</span>
            <span class="fund-stat__period">vs prior period</span>
        </div>
        <div class="fund-stat">
            <span class="fund-stat__lbl">CAGR</span>
            <span class="fund-stat__val" style="color:var(--gold)">${cagrStr}</span>
            <span class="fund-stat__period">full series · ${n} periods</span>
        </div>
        <div class="fund-stat">
            <span class="fund-stat__lbl">Range</span>
            <span class="fund-stat__val" style="color:var(--text-sec)">${fmt(Math.min(...rawVals))} – ${fmt(Math.max(...rawVals))}</span>
            <span class="fund-stat__period">${labels[0] || ''} → ${latestLbl}</span>
        </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FUNDAMENTALS — RATIO ANALYSIS & FINANCIAL STATEMENTS
   ═══════════════════════════════════════════════════════════════════════════ */

let _stmtPeriod = 'annual';
let _stmtType   = 'income';

/* ── Ratio Analysis ── */
function loadRatios() {
    if (!fundData) return;
    document.getElementById('ratios-loading').style.display = 'flex';
    document.getElementById('ratios-content').style.display = 'none';
    fetch(`/api/fundamentals/${fundData.ticker}/ratios`)
        .then(r => r.json())
        .then(d => {
            document.getElementById('ratios-loading').style.display = 'none';
            if (d.error) { alert('Ratio error: ' + d.error); return; }
            document.getElementById('ratios-content').style.display = 'block';
            _renderRatios(d.ratios);
        })
        .catch(e => {
            document.getElementById('ratios-loading').style.display = 'none';
            console.error('Ratio fetch error:', e);
        });
}

function _renderRatios(ratios) {
    // ── Category config: icon · accent color · description ────────────────
    const CAT_CFG = {
        'Earnings':               { icon:'💰', color:'#00D4AA', desc:'Absolute income statement & cash flow figures (TTM/annual)' },
        'Profitability':          { icon:'📊', color:'#4DA6FF', desc:'Margins showing how efficiently revenue converts to profit' },
        'Debt Management':        { icon:'⚖',  color:'#FF7B54', desc:'Leverage and coverage ratios assessing financial risk' },
        'Return on Assets':       { icon:'🏭', color:'#B06EFF', desc:'How efficiently assets generate operating & net income' },
        'Return to Shareholders': { icon:'👥', color:'#FFB347', desc:'Equity returns, dividends, and buyback activity' },
    };

    // ── Value formatter ────────────────────────────────────────────────────
    const fmtVal = r => {
        const v = r.value;
        if (v === null || v === undefined) return 'N/A';
        if (r.fmt === 'x')   return v.toFixed(2) + 'x';
        if (r.fmt === '%')   return (v >= 0 ? '' : '') + v.toFixed(1) + '%';
        if (r.fmt === 'eps') return '$' + v.toFixed(2);
        if (r.fmt === '$') {
            const sign = v < 0 ? '−' : '';
            const a = Math.abs(v);
            if (a >= 1e12) return sign + (a/1e12).toFixed(2) + 'T';
            if (a >= 1e9)  return sign + (a/1e9).toFixed(2) + 'B';
            if (a >= 1e6)  return sign + (a/1e6).toFixed(2) + 'M';
            if (a >= 1e3)  return sign + (a/1e3).toFixed(2) + 'K';
            return sign + a.toFixed(0);
        }
        return v.toFixed(2);
    };

    // ── Health badge ───────────────────────────────────────────────────────
    const BADGE = {
        good:    { label:'Good',    color:'#00D4AA', bg:'rgba(0,212,170,.12)',  border:'rgba(0,212,170,.3)'  },
        ok:      { label:'OK',      color:'#FFB020', bg:'rgba(255,176,32,.1)',  border:'rgba(255,176,32,.3)' },
        bad:     { label:'Caution', color:'#FF3D6B', bg:'rgba(255,61,107,.1)',  border:'rgba(255,61,107,.3)' },
        neutral: { label:'—',       color:'#527090', bg:'transparent',          border:'var(--border)'       },
    };

    // ── Build HTML ─────────────────────────────────────────────────────────
    const cats = {};
    // Preserve category order
    const CAT_ORDER = ['Earnings','Profitability','Debt Management','Return on Assets','Return to Shareholders'];
    ratios.forEach(r => {
        if (!cats[r.category]) cats[r.category] = [];
        cats[r.category].push(r);
    });

    let html = '<div class="ratio-grid-wrap">';

    CAT_ORDER.forEach(cat => {
        const items = cats[cat];
        if (!items || !items.length) return;
        const cfg = CAT_CFG[cat] || { icon:'◆', color:'var(--cyan)', desc:'' };

        // Separate into "has value" and "missing" for cleaner layout
        const present = items.filter(r => r.status !== 'missing_data');
        const missing  = items.filter(r => r.status === 'missing_data');

        html += `
        <div class="ratio-section">
            <div class="ratio-section__header" style="border-left:3px solid ${cfg.color}">
                <span class="ratio-section__icon">${cfg.icon}</span>
                <div>
                    <div class="ratio-section__title" style="color:${cfg.color}">${cat}</div>
                    <div class="ratio-section__desc">${cfg.desc}</div>
                </div>
            </div>
            <div class="ratio-cards">`;

        present.forEach(r => {
            const b   = BADGE[r.health] || BADGE.neutral;
            const valStr = fmtVal(r);
            const isNeg = r.value !== null && r.value < 0;
            const valColor = r.fmt === '$' || r.fmt === 'eps'
                ? (isNeg ? '#FF3D6B' : '#E2F0FF')  // absolute: red if negative
                : b.color;                          // ratios: health-colored

            html += `
            <div class="ratio-card">
                <div class="ratio-card__top">
                    <span class="ratio-card__name">${r.name}</span>
                    <span class="ratio-card__badge"
                          style="color:${b.color};background:${b.bg};border:1px solid ${b.border}">
                        ${b.label}
                    </span>
                </div>
                <div class="ratio-card__value" style="color:${valColor}">${valStr}</div>
                <div class="ratio-card__desc">${r.description}</div>
                ${r.source ? `<div class="ratio-card__src" title="XBRL tag(s) used">${r.source}</div>` : ''}
            </div>`;
        });

        // Missing data items — compact row at bottom of section
        if (missing.length) {
            html += `<div class="ratio-missing-row">`;
            missing.forEach(r => {
                html += `<span class="ratio-missing-chip" title="${r.description}">${r.name}: N/A</span>`;
            });
            html += `</div>`;
        }

        html += `</div></div>`; // .ratio-cards  .ratio-section
    });

    html += '</div>'; // .ratio-grid-wrap

    const el = document.getElementById('ratios-content');
    el.innerHTML = html || '<p style="color:var(--text-dim);font-size:13px;padding:10px 0">No ratio data available.</p>';
}

/* ── Financial Statements ── */
function setStmtPeriod(period, btn) {
    _stmtPeriod = period;
    document.querySelectorAll('#stmt-period-annual,#stmt-period-qtr')
        .forEach(el => el.classList.remove('active'));
    btn.classList.add('active');
    loadStatements(_stmtType, document.getElementById('stmt-btn-' + _stmtType));
}

function loadStatements(type, btn) {
    if (!fundData) return;
    _stmtType = type;
    ['income','balance','cashflow'].forEach(t => {
        const b = document.getElementById('stmt-btn-' + t);
        if (b) b.classList.toggle('active', t === type);
    });
    /* persist active tab so it survives panel navigation */
    const _ex = _loadState('fund') || {};
    _saveState('fund', { ..._ex, stmtType: _stmtType, stmtPeriod: _stmtPeriod });
    document.getElementById('stmt-loading').style.display = 'flex';
    document.getElementById('stmt-content').style.display = 'none';
    fetch(`/api/fundamentals/${fundData.ticker}/statements?type=${type}&period=${_stmtPeriod}`)
        .then(r => r.json())
        .then(d => {
            document.getElementById('stmt-loading').style.display = 'none';
            if (d.error) { alert('Statement error: ' + d.error); return; }
            document.getElementById('stmt-content').style.display = 'block';
            _renderStatement(d);
        })
        .catch(e => {
            document.getElementById('stmt-loading').style.display = 'none';
            console.error('Statement fetch error:', e);
        });
}

function _renderStatement(d) {
    const { periods, rows, scale, ticker, statement, period_type } = d;
    if (!periods || periods.length === 0) {
        document.getElementById('stmt-content').innerHTML =
            '<p style="color:var(--text-dim);padding:20px;font-size:13px">No statement data found for this company.</p>';
        return;
    }
    const unit = scale.unit ? ` (${scale.unit})` : '';
    const titles = { income:'Income Statement', balance:'Balance Sheet', cashflow:'Cash Flow Statement' };
    const stmtTitle = (titles[statement] || statement) + unit;

    const rowBg = {
        highlight: 'background:rgba(0,229,255,.05);font-weight:700;',
        subtotal:  'background:rgba(255,255,255,.025);font-weight:700;',
        derived:   'font-style:italic;',
        dim:       'opacity:.7;',
        per_share: 'opacity:.8;font-size:11px;',
        shares:    'opacity:.8;font-size:11px;',
    };

    let html = `
    <div style="font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:10px">
        ${ticker} · ${stmtTitle}
        <span style="font-size:10px;color:var(--text-dim);font-weight:400;margin-left:6px">
            ${period_type === 'annual' ? 'Annual' : 'Quarterly'}
            ${scale.unit ? '· values in ' + scale.unit : ''}
            ${statement === 'cashflow' ? '· * FCF = Operating CF ± CapEx' : ''}
        </span>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
            <tr style="border-bottom:2px solid var(--border)">
                <th style="text-align:left;padding:7px 10px;color:var(--text-sec);font-size:11px;
                           font-weight:700;min-width:180px;white-space:nowrap;
                           font-family:'DM Sans',sans-serif">Line Item</th>`;
    periods.forEach(p => {
        html += `<th style="text-align:right;padding:7px 10px;color:var(--text-sec);font-size:11px;
                             font-weight:700;white-space:nowrap;font-family:var(--font-mono)">${p}</th>`;
    });
    html += `</tr></thead><tbody>`;

    rows.forEach(row => {
        const rs = rowBg[row.type] || '';
        const isHL = row.type === 'highlight';
        const nameCol = isHL ? 'var(--text-primary)' : 'var(--text-sec)';
        html += `<tr style="${rs}border-bottom:1px solid rgba(255,255,255,.04)">
            <td style="padding:7px 10px;color:${nameCol};white-space:nowrap;
                       font-family:'DM Sans',sans-serif">${row.label}</td>`;
        row.values.forEach(v => {
            if (v === null || v === undefined) {
                html += `<td style="text-align:right;padding:7px 10px;color:var(--text-dim);
                                    font-family:var(--font-mono)">—</td>`;
                return;
            }
            const neg = v < 0;
            let color;
            if (row.type === 'highlight' || row.type === 'derived') {
                color = neg ? 'var(--red)' : 'var(--cyan)';
            } else if (row.type === 'subtotal') {
                color = neg ? 'rgba(255,100,100,.9)' : 'var(--text-primary)';
            } else {
                color = neg ? 'rgba(255,110,110,.8)' : 'inherit';
            }
            let disp;
            if (row.type === 'per_share') {
                disp = v.toFixed(2);
            } else if (row.type === 'shares') {
                disp = (Math.abs(v) > 1e3 ? (v/1e3).toFixed(0)+'B' :
                        Math.abs(v) > 1   ? v.toFixed(0)+'M' : v.toFixed(2)+'M');
            } else {
                const a = Math.abs(v);
                disp = a >= 10000 ? (v/1000).toFixed(1)+'K' :
                       a >= 1     ? v.toFixed(1) :
                                    v.toFixed(3);
            }
            html += `<td style="text-align:right;padding:7px 10px;color:${color};
                                font-family:var(--font-mono)">${disp}</td>`;
        });
        html += `</tr>`;
    });
    html += `</tbody></table>`;
    document.getElementById('stmt-content').innerHTML = html;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CORRELATION
   ═══════════════════════════════════════════════════════════════════════════ */
function runCorr(){
    const raw = document.getElementById('corr-tickers').value;
    const tickers = raw.split(',').map(t=>t.trim().toUpperCase()).filter(Boolean);
    if(tickers.length<2) return alert('Enter at least 2 tickers');
    document.getElementById('corr-loading').style.display='flex';
    document.getElementById('corr-content').style.display='none';
    fetch('/api/correlation',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({tickers,period:corrPeriod})
    }).then(r=>r.json()).then(d=>{
        document.getElementById('corr-loading').style.display='none';
        if(d.error) return alert(d.error);
        document.getElementById('corr-content').style.display='block';
        renderHeatmap(d);
        _saveState('corr', { tickers: raw, period: corrPeriod });
    }).catch(e=>{document.getElementById('corr-loading').style.display='none';alert(e);});
}

function renderHeatmap(d){
    const n = d.tickers.length;
    let html = '<table class="heatmap-table"><tr><th></th>';
    d.tickers.forEach(t=>html+=`<th>${t}</th>`);
    html += '</tr>';
    for(let i=0;i<n;i++){
        html += `<tr><th>${d.tickers[i]}</th>`;
        for(let j=0;j<n;j++){
            const v = d.matrix[i][j];
            const pct = Math.abs(v);
            let r,g,b;
            if(v>=0){ r=Math.round(220-v*180); g=Math.round(240-v*60); b=Math.round(220-v*180); }
            else{ r=Math.round(240+v*20); g=Math.round(220+v*180); b=Math.round(220+v*180); }
            const tc = pct>0.5?'white':'#1A1D23';
            const bg = v>=0 ? `rgba(22,163,74,${pct*0.7})` : `rgba(220,38,38,${pct*0.7})`;
            html += `<td style="background:${bg};color:${tc}">${v.toFixed(2)}</td>`;
        }
        html += '</tr>';
    }
    html += '</table>';
    document.getElementById('corr-table').innerHTML = html;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ECONOMIC DATA — Series Explorer · Macro Dashboard · FRED Search
   ═══════════════════════════════════════════════════════════════════════════ */

// US recession date ranges (NBER)
const RECESSIONS = [
    ['1990-07-01','1991-03-01'],['2001-03-01','2001-11-01'],
    ['2007-12-01','2009-06-01'],['2020-02-01','2020-04-01'],
];

let _econRaw      = null;   // full API response for main series
let _econYears    = 1;      // active period selector
let _econType     = 'line'; // chart type: line | bar | area
let _econYoY      = false;  // YoY overlay active
let _econMA       = false;  // moving average overlay
let _econNorm     = false;  // normalize to index 100 at period start
let _econRec      = true;   // show recession bands
let _econPins     = [];     // [{sid, label, dates, values, color, units}]
let _econView     = 'series'; // 'series' | 'dashboard' | 'search'
let _dashYears    = 1;
let _dashData     = null;   // cached dashboard fetch
const PIN_COLORS  = ['#FF7B54','#B06EFF','#FFB347','#4DA6FF'];

function runEcon(){
    const sid = document.getElementById('econ-series')?.value;
    if(!sid) return;
    document.getElementById('econ-loading').style.display='flex';
    document.getElementById('econ-content').style.display='none';
    fetch(`/api/fred/${sid}`)
        .then(r=>r.json())
        .then(d=>{
            document.getElementById('econ-loading').style.display='none';
            if(d.error){ alert('FRED error: '+d.error); return; }
            _econRaw = d;
            document.getElementById('econ-content').style.display='block';
            renderEcon();
        })
        .catch(e=>{ document.getElementById('econ-loading').style.display='none'; alert(e); });
}

// ── View switcher ──────────────────────────────────────────────────────────
function setEconView(btn, view){
    _econView = view;
    document.querySelectorAll('.econ-view-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('econ-panel-series').style.display    = view==='series'    ? '' : 'none';
    document.getElementById('econ-panel-dashboard').style.display = view==='dashboard' ? '' : 'none';
    document.getElementById('econ-panel-search').style.display    = view==='search'    ? '' : 'none';
    if(view==='dashboard' && !_dashData) loadEconDashboard();
}

// ── Series Explorer controls ───────────────────────────────────────────────
function setEconPeriod(btn, years){
    document.querySelectorAll('.econ-period-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    _econYears = years;
    if(_econRaw) renderEcon();
}

function setEconType(btn, type){
    document.querySelectorAll('.econ-type-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    _econType = type;
    if(_econRaw) renderEcon();
}

function toggleEconYoY(){
    _econYoY = !_econYoY;
    const btn = document.getElementById('econ-yoy-btn');
    if(btn){ btn.classList.toggle('active', _econYoY); }
    document.getElementById('econ-yoy-panel').style.display = _econYoY ? '' : 'none';
    if(_econRaw) renderEcon();
}

function toggleEconMA(){
    _econMA = !_econMA;
    const btn = document.getElementById('econ-ma-btn');
    if(btn) btn.classList.toggle('active', _econMA);
    const lbl = document.getElementById('econ-ma-label');
    if(lbl) lbl.style.display = _econMA ? '' : 'none';
    if(_econRaw) renderEcon();
}

function toggleEconNorm(){
    _econNorm = !_econNorm;
    const btn = document.getElementById('econ-norm-btn');
    if(btn) btn.classList.toggle('active', _econNorm);
    if(_econRaw) renderEcon();
}

function toggleEconRec(){
    _econRec = !_econRec;
    const btn = document.getElementById('econ-rec-btn');
    if(btn) btn.classList.toggle('active', _econRec);
    if(_econRaw) renderEcon();
}

function pinEconSeries(){
    if(!_econRaw){ alert('Load a series first.'); return; }
    if(_econPins.length >= 4){ alert('Maximum 4 pinned series.'); return; }
    const sid = _econRaw.series_id;
    if(_econPins.find(p=>p.sid===sid)){ alert(`${sid} is already pinned.`); return; }
    const col = PIN_COLORS[_econPins.length % PIN_COLORS.length];
    _econPins.push({sid, label:_econRaw.label, dates:_econRaw.dates,
                    values:_econRaw.values, color:col, units:_econRaw.units});
    renderEconPins();
    if(_econRaw) renderEcon();
}

function removeEconPin(sid){
    _econPins = _econPins.filter(p=>p.sid!==sid);
    renderEconPins();
    if(_econRaw) renderEcon();
}

function clearEconPins(){
    _econPins = [];
    renderEconPins();
    if(_econRaw) renderEcon();
}

function renderEconPins(){
    const el = document.getElementById('econ-pins');
    const empty = document.getElementById('econ-pins-empty');
    if(!_econPins.length){
        el.innerHTML = '';
        el.appendChild(empty);
        empty.style.display='';
        return;
    }
    empty.style.display='none';
    el.innerHTML = _econPins.map(p=>`
        <span style="display:inline-flex;align-items:center;gap:5px;background:var(--accent);
            border:1px solid ${p.color}44;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600">
            <span style="color:${p.color}">●</span>
            <span style="color:var(--text-primary)">${p.sid}</span>
            <button onclick="removeEconPin('${p.sid}')" style="background:none;border:none;color:var(--text-dim);
                cursor:pointer;font-size:13px;line-height:1;padding:0 0 0 3px" title="Remove">×</button>
        </span>`).join('');
}

function _slicePeriod(dates, values, years){
    if(!years || !dates.length) return {dates, values};
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - years);
    const cutStr = cutoff.toISOString().slice(0,10);
    const idx = dates.findIndex(d=>d >= cutStr);
    if(idx <= 0) return {dates, values};
    return {dates: dates.slice(idx), values: values.slice(idx)};
}

function _computeYoY(dates, values){
    // Find same date ~1 year ago, compute % change
    const yoyDates=[], yoyVals=[];
    for(let i=0;i<dates.length;i++){
        const target = dates[i].slice(0,4)-1 + dates[i].slice(4);
        // find closest date ~1Y back
        let best=-1, bestDiff=Infinity;
        for(let j=0;j<i;j++){
            const diff=Math.abs(new Date(dates[j])-new Date(target));
            if(diff<bestDiff){ bestDiff=diff; best=j; }
        }
        if(best>=0 && values[best]!==0){
            yoyDates.push(dates[i]);
            yoyVals.push(((values[i]-values[best])/Math.abs(values[best]))*100);
        }
    }
    return {dates:yoyDates, values:yoyVals};
}

// _econRecessionPlugin replaced by Plotly shapes in renderEcon()

function downloadEconCSV(){
    if(!_econRaw) return;
    const {dates, values, label, units} = _econRaw;
    let csv = `Date,${label} (${units})\n`;
    dates.forEach((d,i)=>csv+=`${d},${values[i]}\n`);
    const a=document.createElement('a');
    a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
    a.download=`${_econRaw.series_id}.csv`;
    a.click();
}

// ── Helpers ────────────────────────────────────────────────────────────────
function _normalizeSeries(values){
    if(!values.length) return values;
    const base = values[0];
    if(!base) return values;
    return values.map(v => (v / base) * 100);
}

function _computeMA(values, period){
    const result = new Array(values.length).fill(null);
    for(let i = period - 1; i < values.length; i++){
        const slice = values.slice(i - period + 1, i + 1);
        result[i] = slice.reduce((a,b)=>a+b,0) / period;
    }
    return result;
}

// ── Main series render ─────────────────────────────────────────────────────
function renderEcon(){
    const d = _econRaw;
    const {dates:sd, values:svRaw} = _slicePeriod(d.dates, d.values, _econYears);
    if(!sd.length){ return; }

    // Apply normalisation (index 100) if toggled
    const sv = _econNorm ? _normalizeSeries(svRaw) : svRaw;
    const yUnits = _econNorm ? 'Index (base 100)' : d.units;

    _saveState('econ', {
        cat:    document.getElementById('econ-cat')?.value,
        series: document.getElementById('econ-series')?.value,
        years:  _econYears, type: _econType, yoy: _econYoY,
    });

    // ── Stats (always use raw values) ──────────────────────────────────────
    const latest = svRaw[svRaw.length-1];
    const prev   = svRaw.length > 12 ? svRaw[svRaw.length-13] : svRaw[0]; // ~1Y back
    const yoyChg = (prev && prev !== 0) ? ((latest - prev) / Math.abs(prev) * 100) : null;
    let hi = svRaw[0], lo = svRaw[0], sum = 0;
    for(let i=0;i<svRaw.length;i++){ if(svRaw[i]>hi)hi=svRaw[i]; if(svRaw[i]<lo)lo=svRaw[i]; sum+=svRaw[i]; }
    const avg = sum / svRaw.length;
    const pctChgFromFirst = svRaw[0] ? ((latest - svRaw[0]) / Math.abs(svRaw[0]) * 100) : null;
    const chgColor = yoyChg >= 0 ? C.green : C.red;

    document.getElementById('econ-stats').innerHTML = `
        <div class="stat-card"><div class="stat-card__label">Latest</div>
            <div class="stat-card__value">${fmtLarge(latest)}</div>
            <div class="stat-card__sub">${d.units} · ${sd[sd.length-1]}</div></div>
        <div class="stat-card"><div class="stat-card__label">YoY Change</div>
            <div class="stat-card__value" style="color:${yoyChg!=null?chgColor:'var(--text-dim)'}">
                ${yoyChg!=null?(yoyChg>=0?'+':'')+yoyChg.toFixed(2)+'%':'—'}</div></div>
        <div class="stat-card"><div class="stat-card__label">Period High</div>
            <div class="stat-card__value" style="color:${C.green}">${fmtLarge(hi)}</div></div>
        <div class="stat-card"><div class="stat-card__label">Period Low</div>
            <div class="stat-card__value" style="color:${C.red}">${fmtLarge(lo)}</div></div>
        <div class="stat-card"><div class="stat-card__label">Period Avg</div>
            <div class="stat-card__value">${fmtLarge(avg)}</div></div>
        <div class="stat-card"><div class="stat-card__label">Total Change</div>
            <div class="stat-card__value" style="color:${pctChgFromFirst!=null?(pctChgFromFirst>=0?C.green:C.red):'var(--text-dim)'}">
                ${pctChgFromFirst!=null?(pctChgFromFirst>=0?'+':'')+pctChgFromFirst.toFixed(1)+'%':'—'}</div>
            <div class="stat-card__sub">since ${sd[0]}</div></div>`;

    document.getElementById('econ-chart-title').textContent =
        `${d.series_id} — ${d.label}` + (_econNorm ? '  (Indexed: 100 = period start)' : `  (${d.units})`);

    // ── Recession shapes — clipped to visible window ─────────────────────
    const xMin = sd[0], xMax = sd[sd.length - 1];
    const recShapes = _econRec ? RECESSIONS
        .filter(([s, e]) => e > xMin && s < xMax)          // only overlapping recessions
        .map(([s, e]) => ({
            type: 'rect', xref:'x', yref:'paper',
            x0: s < xMin ? xMin : s,                        // clip left edge
            x1: e > xMax ? xMax : e,                        // clip right edge
            y0: 0, y1: 1,
            fillcolor: 'rgba(255,255,255,0.035)',
            line: { width: 0 }, layer: 'below'
        })) : [];

    const hex    = d.color;
    const isBar  = _econType === 'bar';
    const isArea = _econType === 'area';

    // ── Main trace ────────────────────────────────────────────────────────
    let mainTrace;
    const htSuffix = _econNorm ? ' (indexed)' : ` ${yUnits}`;
    if(isBar){
        mainTrace = {
            x: sd, y: sv, name: d.label,
            type: 'bar',
            marker: { color: hex + 'BB', line: { color: hex, width: 0.5 } },
            hovertemplate: `%{x}<br><b>${d.label}:</b> %{y:.4s}${htSuffix}<extra></extra>`
        };
    } else {
        mainTrace = {
            x: sd, y: sv, name: d.label,
            type: 'scatter', mode: 'lines',
            line: { color: hex, width: 2 },
            fill: isArea ? 'tozeroy' : 'none',
            fillcolor: isArea ? hex + '2A' : undefined,
            hovertemplate: `%{x}<br><b>${d.label}:</b> %{y:.4s}${htSuffix}<extra></extra>`
        };
    }

    const traces = [mainTrace];

    // ── Moving average overlay ────────────────────────────────────────────
    if(_econMA){
        const maPeriod = parseInt(document.getElementById('econ-ma-period')?.value || 12);
        const maVals   = _computeMA(sv, maPeriod);
        traces.push({
            x: sd, y: maVals, name: `${maPeriod}-period MA`,
            type: 'scatter', mode: 'lines',
            line: { color: '#FFB347', width: 1.8, dash: 'dash' },
            hovertemplate: `%{x}<br><b>${maPeriod}p MA:</b> %{y:.4s}<extra></extra>`
        });
    }

    // ── Pinned comparison series ──────────────────────────────────────────
    const hasSecondY = !_econNorm && _econPins.some(p => p.units !== d.units);
    _econPins.forEach(p => {
        const {dates:pd, values:pvRaw} = _slicePeriod(p.dates, p.values, _econYears);
        const pv = _econNorm ? _normalizeSeries(pvRaw) : pvRaw;
        const sameUnits = _econNorm || p.units === d.units;
        traces.push({
            x: pd, y: pv, name: `${p.sid}${_econNorm?' (idx)':' ('+p.units+')'}`,
            type: 'scatter', mode: 'lines',
            line: { color: p.color, width: 1.8 },
            yaxis: sameUnits ? 'y' : 'y2',
            hovertemplate: `%{x}<br><b>${p.sid}:</b> %{y:.4s}<extra></extra>`
        });
    });

    const axBase = {
        gridcolor: '#0F1D35', gridwidth: 0.5,
        linecolor: '#152038', tickcolor: '#152038',
        tickfont: { size: 10, color: '#527090', family: "'DM Sans', sans-serif" },
        zeroline: false,
    };

    const layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor:  '#060E1C',
        font: { family: "'DM Sans', sans-serif", size: 11, color: '#527090' },
        margin: { l: 72, r: hasSecondY ? 72 : 24, t: 10, b: 50 },
        autosize: true,
        shapes: recShapes,
        showlegend: traces.length > 1,
        legend: { font:{size:11,color:'#8BAFC7'}, bgcolor:'rgba(0,0,0,0)', x:0.01, y:0.99 },
        xaxis: { ...axBase, type:'date', range:[xMin, xMax], rangeslider:{visible:false} },
        yaxis: { ...axBase, hoverformat:'.4s', automargin:true,
            title: _econNorm ? {text:'Index (100 = start)',font:{size:10,color:'#527090'}} : undefined },
        hovermode: 'x unified',
        hoverlabel: {
            bgcolor:'#0C1929', bordercolor:'#152038',
            font:{family:"'DM Sans', sans-serif",size:11,color:'#C8E4FF'}
        },
        bargap: 0.2,
    };
    if(hasSecondY){
        layout.yaxis2 = { ...axBase, overlaying:'y', side:'right',
            hoverformat:'.4s', showgrid:false, automargin:true };
    }

    Plotly.react('chart-econ', traces, layout, {
        responsive: true, displaylogo: false,
        modeBarButtonsToRemove: ['toImage','sendDataToCloud','editInChartStudio','select2d','lasso2d'],
    });

    // ── YoY Plotly chart ──────────────────────────────────────────────────
    if(_econYoY){
        document.getElementById('econ-yoy-panel').style.display = '';
        const {dates:yd, values:yv} = _computeYoY(sd, svRaw);
        const yoyColors = yv.map(v => v >= 0 ? C.green + 'CC' : C.red + 'CC');
        const yoyAnnotations = [];
        // Annotate last bar
        if(yv.length){
            yoyAnnotations.push({
                x: yd[yd.length-1], y: yv[yv.length-1],
                text: (yv[yv.length-1]>=0?'+':'')+yv[yv.length-1].toFixed(1)+'%',
                showarrow: false,
                font:{size:10, color: yv[yv.length-1]>=0?C.green:C.red},
                xanchor:'left', yanchor:'middle',
            });
        }
        Plotly.react('chart-econ-yoy', [{
            x: yd, y: yv, name: 'YoY % Change',
            type: 'bar',
            marker: { color: yoyColors },
            hovertemplate: '%{x}<br><b>YoY:</b> %{y:+.2f}%<extra></extra>'
        }], {
            paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'#060E1C',
            font:{family:"'DM Sans', sans-serif",size:11,color:'#527090'},
            margin:{l:60,r:24,t:14,b:50},
            autosize:true, showlegend:false,
            annotations: yoyAnnotations,
            xaxis:{...axBase, type:'date', range:[xMin, xMax], rangeslider:{visible:false}},
            yaxis:{...axBase, ticksuffix:'%', hoverformat:'+.2f', zeroline:true, zerolinecolor:'#1F3050', zerolinewidth:1},
            hovermode:'x unified',
            hoverlabel:{bgcolor:'#0C1929',bordercolor:'#152038',font:{family:"'DM Sans', sans-serif",size:11,color:'#C8E4FF'}},
            bargap:0.2, shapes: _econRec ? recShapes : [],
        }, {responsive:true, displaylogo:false,
            modeBarButtonsToRemove:['toImage','sendDataToCloud','editInChartStudio','select2d','lasso2d']});
    }
}

/* ── Macro Dashboard ─────────────────────────────────────────────────────── */
function setDashPeriod(btn, years){
    document.querySelectorAll('.econ-dash-period').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    _dashYears = years;
    if(_dashData) renderEconDashboard(_dashData);
}

function loadEconDashboard(){
    const grid    = document.getElementById('econ-dash-grid');
    const loading = document.getElementById('econ-dash-loading');
    if(!grid) return;
    loading.style.display = 'flex';
    grid.innerHTML = '';
    fetch('/api/fred/dashboard')
        .then(r=>r.json())
        .then(d=>{
            loading.style.display = 'none';
            if(d.error){ grid.innerHTML=`<div style="color:var(--red)">${d.error}</div>`; return; }
            _dashData = d;
            renderEconDashboard(d);
        })
        .catch(e=>{ loading.style.display='none'; grid.innerHTML=`<div style="color:var(--red)">${e}</div>`; });
}

function renderEconDashboard(d){
    const grid = document.getElementById('econ-dash-grid');
    if(!grid) return;
    grid.innerHTML = '';
    d.series.forEach(s=>{
        const {dates:sd, values:sv} = _slicePeriod(s.dates, s.values, _dashYears);
        if(!sd.length) return;

        const latest = sv[sv.length-1];
        const prev   = sv.length > 1 ? sv[sv.length-2] : sv[0];
        const chgAbs = latest - prev;
        const chgPct = prev ? (chgAbs / Math.abs(prev) * 100) : 0;
        const up     = chgAbs >= 0;

        // Sparkline mini Plotly chart
        const tileId = 'dash-chart-' + s.series_id;
        const tile = document.createElement('div');
        tile.className = 'econ-dash-tile';
        tile.innerHTML = `
            <div class="econ-dash-tile__header">
                <span class="econ-dash-tile__id">${s.series_id}</span>
                <span class="econ-dash-tile__label">${s.label}</span>
            </div>
            <div class="econ-dash-tile__value" style="color:${s.color}">
                ${fmtLarge(latest)}
                <span class="econ-dash-tile__units">${s.units}</span>
            </div>
            <div class="econ-dash-tile__chg" style="color:${up?C.green:C.red}">
                ${up?'▲':'▼'} ${Math.abs(chgPct).toFixed(2)}% vs prev
            </div>
            <div id="${tileId}" style="width:100%;height:90px"></div>
            <button class="econ-dash-tile__load" onclick="loadSeriesFromDash('${s.series_id}')">
                Load in Explorer →
            </button>`;
        grid.appendChild(tile);

        // Render sparkline
        setTimeout(()=>{
            Plotly.react(tileId, [{
                x: sd, y: sv, type:'scatter', mode:'lines',
                line:{color:s.color, width:1.8},
                fill:'tozeroy', fillcolor:s.color+'18',
                hoverinfo:'skip',
            }], {
                paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
                margin:{l:0,r:0,t:4,b:0}, autosize:true,
                showlegend:false,
                xaxis:{visible:false, type:'date', range:[sd[0], sd[sd.length-1]]},
                yaxis:{visible:false},
            }, {responsive:true, displaylogo:false, staticPlot:true});
        }, 50);
    });
}

function loadSeriesFromDash(seriesId){
    // Switch to series explorer view, select the series if catalogued, then load
    setEconView(document.getElementById('econ-view-series'), 'series');
    // Try to find in catalogue
    if(typeof FRED_CAT !== 'undefined'){
        for(const [cat, items] of Object.entries(FRED_CAT)){
            if(items[seriesId]){
                const catSel = document.getElementById('econ-cat');
                if(catSel){ catSel.value = cat; updateEconSeries(); }
                const srsSel = document.getElementById('econ-series');
                if(srsSel){ srsSel.value = seriesId; }
                break;
            }
        }
    }
    // Load via API (works for any series ID)
    document.getElementById('econ-loading').style.display='flex';
    document.getElementById('econ-content').style.display='none';
    fetch(`/api/fred/${seriesId}`)
        .then(r=>r.json())
        .then(d=>{
            document.getElementById('econ-loading').style.display='none';
            if(d.error){ alert('FRED error: '+d.error); return; }
            _econRaw = d;
            document.getElementById('econ-content').style.display='block';
            renderEcon();
        })
        .catch(e=>{ document.getElementById('econ-loading').style.display='none'; alert(e); });
}

/* ── FRED Search ─────────────────────────────────────────────────────────── */
function runFredSearch(){
    const q = document.getElementById('fred-search-input')?.value?.trim();
    if(!q) return;
    const loading = document.getElementById('fred-search-loading');
    const results = document.getElementById('fred-search-results');
    loading.style.display='flex'; results.style.display='none';
    fetch(`/api/fred/search?q=${encodeURIComponent(q)}`)
        .then(r=>r.json())
        .then(d=>{
            loading.style.display='none';
            if(d.error){ alert('Search error: '+d.error); return; }
            results.style.display='block';
            if(!d.results.length){
                document.getElementById('fred-search-table').innerHTML=
                    '<div style="color:var(--text-dim);padding:20px;text-align:center">No results found.</div>';
                return;
            }
            let html = `<table class="fred-search-table">
                <thead><tr>
                    <th>Series ID</th><th>Title</th><th>Units</th><th>Freq</th><th>Updated</th><th></th>
                </tr></thead><tbody>`;
            d.results.forEach(r=>{
                const star = r.in_catalogue ? '<span title="In curated catalogue" style="color:#FFB347;margin-right:4px">★</span>' : '';
                html += `<tr>
                    <td style="font-family:monospace;font-weight:700;color:${r.color}">${r.id}</td>
                    <td>${star}${r.title}</td>
                    <td style="color:var(--text-dim)">${r.units}</td>
                    <td style="color:var(--text-dim)">${r.frequency}</td>
                    <td style="color:var(--text-dim)">${r.last_obs}</td>
                    <td><button class="btn btn--primary btn--sm" style="font-size:10px;padding:3px 10px"
                        onclick="loadFredSearchResult('${r.id}','${r.title.replace(/'/g,"\\'")}','${r.units}')">Load</button></td>
                </tr>`;
            });
            html += '</tbody></table>';
            document.getElementById('fred-search-table').innerHTML = html;
        })
        .catch(e=>{ loading.style.display='none'; alert(e); });
}

function loadFredSearchResult(seriesId, title, units){
    // Switch to series view and load directly
    setEconView(document.getElementById('econ-view-series'), 'series');
    document.getElementById('econ-loading').style.display='flex';
    document.getElementById('econ-content').style.display='none';
    fetch(`/api/fred/${seriesId}`)
        .then(r=>r.json())
        .then(d=>{
            document.getElementById('econ-loading').style.display='none';
            if(d.error){ alert('FRED error: '+d.error); return; }
            // Enrich with search metadata if not in catalogue
            if(!d.label || d.label === seriesId) d.label = title;
            if(!d.units) d.units = units;
            _econRaw = d;
            document.getElementById('econ-content').style.display='block';
            renderEcon();
        })
        .catch(e=>{ document.getElementById('econ-loading').style.display='none'; alert(e); });
}

/* ═══════════════════════════════════════════════════════════════════════════
   NEWS & SENTIMENT
   ═══════════════════════════════════════════════════════════════════════════ */
function runNews(){
    const ticker = document.getElementById('news-ticker')?.value?.toUpperCase()?.trim();
    const limit = document.getElementById('news-limit')?.value||50;
    if(!ticker) return;
    document.getElementById('news-loading').style.display='flex';
    document.getElementById('news-content').style.display='none';
    fetch(`/api/news/${ticker}?limit=${limit}`)
        .then(r=>r.json())
        .then(d=>{
            document.getElementById('news-loading').style.display='none';
            if(d.error){ document.getElementById('news-status').textContent='Error: '+d.error; return; }
            document.getElementById('news-content').style.display='block';
            const sm = d.summary;
            const bp = sm.total?((sm.positive/sm.total)*100).toFixed(0):0;
            const bn = sm.total?((sm.negative/sm.total)*100).toFixed(0):0;
            document.getElementById('news-summary').innerHTML =
                `<div class="card" style="padding:12px 18px;display:flex;gap:20px;align-items:center;flex-wrap:wrap">
                <strong>${d.ticker} Sentiment</strong>
                <span style="color:${C.green};font-weight:700">▲ Bullish ${bp}%</span>
                <span style="color:${C.red};font-weight:700">▼ Bearish ${bn}%</span>
                <span style="color:${C.dim}">${sm.total} articles</span></div>`;
            renderNewsFeed(d);
            renderNewsTimeline(d);
            renderNewsDist(d);
            renderNewsKeywords(d);
            _saveState('news', { ticker: d.ticker, limit: document.getElementById('news-limit')?.value });
            document.getElementById('news-status').textContent =
                `${d.ticker} — ${sm.total} articles | ▲ ${sm.positive} positive  ● ${sm.neutral} neutral  ▼ ${sm.negative} negative`;
        })
        .catch(e=>{document.getElementById('news-loading').style.display='none';document.getElementById('news-status').textContent='Error: '+e;});
}

function renderNewsFeed(d){
    const container = document.getElementById('news-feed');
    container.innerHTML = d.articles.map(a=>{
        const sc = a.sentiment==='positive'?'sent-positive':a.sentiment==='negative'?'sent-negative':'sent-neutral';
        const icon = a.sentiment==='positive'?'▲':a.sentiment==='negative'?'▼':'●';
        return `<div class="news-card">
            <div class="news-card__meta">
                <span class="news-card__sentiment ${sc}">${icon} ${a.sentiment}</span>
                <span class="news-card__date">${a.published||'Unknown'}</span>
                <span class="news-card__publisher">${a.publisher}</span>
            </div>
            <div class="news-card__title">${a.title}</div>
            ${a.reasoning&&!a.reasoning.includes('keyword')?`<div class="news-card__reasoning">${a.reasoning}</div>`:''}
            ${a.url?`<a href="${a.url}" target="_blank" class="news-card__url">${a.url.substring(0,80)}...</a>`:''}
        </div>`;
    }).join('');
}

function renderNewsTimeline(d){
    destroyChart('news-tl');
    const byDate = {};
    d.articles.forEach(a=>{
        if(!a.published) return;
        const dt = a.published.split(' ')[0];
        if(!byDate[dt]) byDate[dt]={sum:0,count:0};
        byDate[dt].sum += a.score; byDate[dt].count++;
    });
    const dates = Object.keys(byDate).sort();
    const scores = dates.map(dt=>byDate[dt].sum/byDate[dt].count);
    const colors = scores.map(s=>s>0?C.green+'AA':s<0?C.red+'AA':C.gold+'AA');
    const ctx = document.getElementById('chart-news-tl');
    ctx.parentElement.style.height = '400px';
    charts['news-tl'] = new Chart(ctx, {
        type:'bar',
        data:{labels:dates,datasets:[{label:'Daily Sentiment',data:scores,backgroundColor:colors,borderWidth:0}]},
        options:{...chartDefaults,scales:{...chartDefaults.scales,y:{...chartDefaults.scales.y,min:-1.2,max:1.2}},
            plugins:{...chartDefaults.plugins,title:{display:true,text:d.ticker+' — Sentiment Timeline',font:{family:"'DM Sans'",size:16,weight:'bold'},color:'#C8E4FF',align:'start'}}}
    });
}

function renderNewsDist(d){
    destroyChart('news-dist');
    const ctx = document.getElementById('chart-news-dist');
    ctx.parentElement.style.height = '400px';
    const sm = d.summary;
    charts['news-dist'] = new Chart(ctx, {
        type:'doughnut',
        data:{
            labels:['Positive','Neutral','Negative'],
            datasets:[{data:[sm.positive,sm.neutral,sm.negative], backgroundColor:[C.green,C.gold,C.red], borderWidth:3, borderColor:'#090D1C'}]
        },
        options:{responsive:true,maintainAspectRatio:false,
            plugins:{legend:{position:'bottom',labels:{font:{family:"'DM Sans'",size:12},padding:20}},
                title:{display:true,text:d.ticker+' — Sentiment Distribution',font:{family:"'DM Sans'",size:16,weight:'bold'},color:'#C8E4FF',align:'start'}}}
    });
}

function renderNewsKeywords(d){
    destroyChart('news-kw');
    if(!d.keywords.length) return;
    const ctx = document.getElementById('chart-news-kw');
    ctx.parentElement.style.height = '500px';
    const words = d.keywords.map(k=>k.word);
    const counts = d.keywords.map(k=>k.count);
    const maxC = Math.max(...counts);
    const colors = counts.map(c=>{const r=c/maxC; return `rgba(37,99,235,${0.3+r*0.6})`;});
    charts['news-kw'] = new Chart(ctx, {
        type:'bar',
        data:{labels:words,datasets:[{data:counts,backgroundColor:colors,borderWidth:0}]},
        options:{...chartDefaults,indexAxis:'y',
            plugins:{...chartDefaults.plugins,legend:{display:false},
                title:{display:true,text:d.ticker+' — Top Keywords',font:{family:"'DM Sans'",size:16,weight:'bold'},color:'#C8E4FF',align:'start'}}}
    });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SIGNAL ANALYSIS
   ═══════════════════════════════════════════════════════════════════════════ */
function runSignal(){
    const ticker = document.getElementById('signal-ticker')?.value?.toUpperCase()?.trim();
    if(!ticker) return;
    document.getElementById('signal-loading').style.display='flex';
    document.getElementById('signal-content').style.display='none';
    fetch(`/api/signal/${ticker}`)
        .then(r=>r.json())
        .then(d=>{
            document.getElementById('signal-loading').style.display='none';
            if(d.error){ alert(d.error); return; }
            document.getElementById('signal-content').style.display='block';
            renderSignal(d);
            _saveState('signal', { ticker: d.ticker });
        })
        .catch(e=>{document.getElementById('signal-loading').style.display='none';alert(e);});
}

function renderSignal(d){
    const SIGNAL_CFG = {
        VERY_BULLISH: {
            label: 'Very Bullish',
            bg:    'rgba(0,212,120,0.09)',   dark: '#00D478', badge: '#051A0E',
            icon:  '▲▲',
            desc:  'Composite indicators show strong positive momentum across multiple factors.',
        },
        BULLISH: {
            label: 'Bullish',
            bg:    'rgba(0,212,170,0.07)',   dark: '#00D4AA', badge: '#061A14',
            icon:  '▲',
            desc:  'Composite indicators lean positive — more factors align upward than downward.',
        },
        NEUTRAL: {
            label: 'Neutral',
            bg:    'rgba(255,179,71,0.07)',  dark: '#FFB347', badge: '#1E1200',
            icon:  '●',
            desc:  'Composite indicators show no clear directional bias — mixed or insufficient signals.',
        },
        BEARISH: {
            label: 'Bearish',
            bg:    'rgba(255,100,61,0.07)',  dark: '#FF7B54', badge: '#1E0C06',
            icon:  '▼',
            desc:  'Composite indicators lean negative — more factors align downward than upward.',
        },
        VERY_BEARISH: {
            label: 'Very Bearish',
            bg:    'rgba(255,51,72,0.09)',   dark: '#FF3348', badge: '#1E060C',
            icon:  '▼▼',
            desc:  'Composite indicators show strong negative momentum across multiple factors.',
        },
    };
    const cfg = SIGNAL_CFG[d.signal] || SIGNAL_CFG.NEUTRAL;
    const ms  = d.master_score;

    function scoreBar(label, score, color, hasData){
        const pct = Math.abs(score)*50;
        const dir = score>=0?'right':'left';
        const fill = hasData ? `<div class="score-bar__fill" style="width:${pct}%;background:${color};${dir==='right'?'left:50%':'right:50%'}"></div>` :
            '<div style="position:absolute;width:100%;text-align:center;font-size:10px;color:var(--text-dim);top:1px">No data</div>';
        const scColor = !hasData?C.dim:score>0.1?C.green:score<-0.1?C.red:C.gold;
        return `<div class="score-bar">
            <div class="score-bar__label">${label}</div>
            <div class="score-bar__track">${fill}<div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:${C.border}"></div></div>
            <div class="score-bar__value" style="color:${scColor}">${hasData?(score>=0?'+':'')+score.toFixed(3):'N/A'}</div>
        </div>`;
    }

    let html = `
    <div class="signal-banner" style="background:${cfg.bg}">
        <div class="signal-banner__inner">
            <div class="signal-badge" style="background:${cfg.badge}; border: 1px solid ${cfg.dark}33;">
                <div class="signal-badge__icon" style="color:${cfg.dark}">${cfg.icon}</div>
                <div class="signal-badge__label" style="color:${cfg.dark}">${cfg.label}</div>
            </div>
            <div>
                <div class="signal-info__title" style="color:${cfg.dark}">${d.ticker} — Composite Indicator Reading</div>
                <div class="signal-info__desc" style="color:${cfg.dark}99">${cfg.desc}</div>
                <div class="signal-meta">
                    <span style="color:${cfg.dark}CC">Master Score: <strong style="color:${cfg.dark}">${(ms>=0?'+':'')+ms.toFixed(3)}</strong></span>
                    <span style="color:${cfg.dark}CC">Confidence: <strong style="color:${cfg.dark}">${d.confidence}%</strong></span>
                </div>
            </div>
        </div>
    </div>
    <div class="card">
        <div class="card__title">Score Overview</div>
        ${scoreBar('Master Score', d.master_score, C.cyan, true)}
        ${scoreBar('Technical', d.tech_score, C.blue, d.data_present.tech)}
        ${scoreBar('Fundamental', d.fund_score, C.gold, d.data_present.fund)}
        ${scoreBar('Sentiment', d.sent_score, C.purple, d.data_present.sent)}
        ${scoreBar('Risk / Momentum', d.risk_score, C.orange, d.data_present.risk)}
    </div>`;

    // Sub-signal breakdowns
    if(d.data_present.tech){
        html += `<div class="card"><div class="card__title">Technical Sub-Signals</div>`;
        for(const [k,v] of Object.entries(d.tech_signals)){
            html += scoreBar(k.replace(/_/g,' '), v, C.blue, true);
        }
        html += '</div>';
    }
    if(d.data_present.fund){
        html += `<div class="card"><div class="card__title">Fundamental Sub-Signals</div>`;
        for(const [k,v] of Object.entries(d.fund_signals)){
            html += scoreBar(k.replace(/_/g,' '), v, C.gold, true);
        }
        html += '</div>';
    }
    if(d.sent_breakdown && d.sent_breakdown.articles){
        const sb = d.sent_breakdown;
        html += `<div class="card"><div class="card__title">Sentiment Breakdown</div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;font-size:13px">
                <div><strong>${sb.articles}</strong> articles</div>
                <div style="color:${C.green}"><strong>${sb.pos_pct}%</strong> positive</div>
                <div style="color:${C.red}"><strong>${sb.neg_pct}%</strong> negative</div>
            </div></div>`;
    }
    if(d.data_present.risk){
        html += `<div class="card"><div class="card__title">Risk Sub-Signals</div>`;
        for(const [k,v] of Object.entries(d.risk_signals)){
            html += scoreBar(k.replace(/_/g,' '), v, C.orange, true);
        }
        html += '</div>';
    }

    document.getElementById('signal-content').innerHTML = html;
}

/* ── Backtesting ──────────────────────────────────────────────────────── */
let _btStrategy = 'combined';

function selectStrategy(el, key){
    document.querySelectorAll('.bt-strategy-card').forEach(c=>c.classList.remove('active'));
    el.classList.add('active');
    _btStrategy = key;
    // Adjust threshold defaults per strategy
    const buyEl  = document.getElementById('bt-buy-thresh');
    const sellEl = document.getElementById('bt-sell-thresh');
    if(key === 'sma_crossover')    { buyEl.value='0.05'; sellEl.value='-0.05'; }
    else if(key === 'momentum')    { buyEl.value='0.20'; sellEl.value='-0.20'; }
    else if(key === 'macro_composite') { buyEl.value='0.18'; sellEl.value='-0.18'; }
    else                           { buyEl.value='0.15'; sellEl.value='-0.15'; }
}

function runBacktest(){
    const ticker   = (document.getElementById('bt-ticker')?.value||'').toUpperCase().trim();
    const start    = document.getElementById('bt-start')?.value;
    const end      = document.getElementById('bt-end')?.value;
    const capital  = parseFloat(document.getElementById('bt-capital')?.value)||10000;
    const buyT     = parseFloat(document.getElementById('bt-buy-thresh')?.value)||0.15;
    const sellT    = parseFloat(document.getElementById('bt-sell-thresh')?.value)||-0.15;
    const lookback = document.getElementById('bt-lookback')?.value||120;
    if(!ticker){ alert('Enter a ticker symbol.'); return; }
    document.getElementById('bt-loading').style.display='flex';
    document.getElementById('bt-content').style.display='none';
    const params = new URLSearchParams({start_date:start,end_date:end,capital,
        buy_thresh:buyT,sell_thresh:sellT,lookback,strategy:_btStrategy});
    fetch(`/api/backtest/${ticker}?${params}`)
        .then(r=>r.json())
        .then(d=>{
            document.getElementById('bt-loading').style.display='none';
            if(d.error){ alert(d.error); return; }
            document.getElementById('bt-content').style.display='block';
            renderBacktest(d);
            _saveState('bt', {
                ticker:   ticker, start:    start,  end:      end,
                capital:  capital, buyT:    buyT,   sellT:    sellT,
                lookback: lookback, strategy: _btStrategy,
            });
        })
        .catch(e=>{ document.getElementById('bt-loading').style.display='none'; alert(e); });
}

function renderBacktest(d){
    const s = d.stats;
    const buyT  = parseFloat(document.getElementById('bt-buy-thresh')?.value||0.15);
    const sellT = parseFloat(document.getElementById('bt-sell-thresh')?.value||-0.15);
    const alphaColor = s.alpha>=0 ? C.green : C.red;
    const retColor   = s.total_return>=0 ? C.green : C.red;

    const annRetColor  = (s.annualized_return||0)>=0 ? C.green : C.red;
    const annBhColor   = (s.bench_annualized||0)>=0  ? C.green : C.red;
    const annAlphaCol  = (s.annualized_alpha||0)>=0  ? C.green : C.red;

    // ── Stats grid ──
    let html = `
    <div class="stats-grid" style="margin-bottom:12px">
        <div class="stat-card">
            <div class="stat-card__label">Total Return</div>
            <div class="stat-card__value" style="color:${retColor}">${s.total_return>=0?'+':''}${s.total_return}%</div>
            <div class="stat-card__sub" style="color:${annRetColor}">${(s.annualized_return||0)>=0?'+':''}${s.annualized_return??'—'}% / yr</div>
        </div>
        <div class="stat-card">
            <div class="stat-card__label">Buy &amp; Hold</div>
            <div class="stat-card__value" style="color:${s.benchmark_return>=0?C.green:C.red}">${s.benchmark_return>=0?'+':''}${s.benchmark_return}%</div>
            <div class="stat-card__sub" style="color:${annBhColor}">${(s.bench_annualized||0)>=0?'+':''}${s.bench_annualized??'—'}% / yr</div>
        </div>
        <div class="stat-card">
            <div class="stat-card__label">Alpha vs B&amp;H</div>
            <div class="stat-card__value" style="color:${alphaColor}">${s.alpha>=0?'+':''}${s.alpha}%</div>
            <div class="stat-card__sub" style="color:${annAlphaCol}">${(s.annualized_alpha||0)>=0?'+':''}${s.annualized_alpha??'—'}% / yr annualized</div>
        </div>
        <div class="stat-card"><div class="stat-card__label">Max Drawdown</div>
            <div class="stat-card__value" style="color:${C.red}">-${s.max_drawdown}%</div></div>
        <div class="stat-card"><div class="stat-card__label">Sharpe Ratio</div>
            <div class="stat-card__value" style="color:${s.sharpe>=1?C.green:s.sharpe>=0?C.gold:C.red}">${s.sharpe}</div>
            <div class="stat-card__sub">all volatility</div></div>
        <div class="stat-card"><div class="stat-card__label">Sortino Ratio</div>
            <div class="stat-card__value" style="color:${(s.sortino??0)>=1?C.green:(s.sortino??0)>=0?C.gold:C.red}">${s.sortino??'—'}</div>
            <div class="stat-card__sub">downside only</div></div>
        <div class="stat-card"><div class="stat-card__label">Win Rate</div>
            <div class="stat-card__value" style="color:${s.win_rate>=50?C.green:C.red}">${s.win_rate}%</div></div>
        <div class="stat-card"><div class="stat-card__label">Round-Trip Trades</div>
            <div class="stat-card__value">${s.num_trades}</div>
            <div class="stat-card__sub">${s.backtest_years??'—'} years tested</div>
        </div>
        <div class="stat-card"><div class="stat-card__label">Final Equity</div>
            <div class="stat-card__value" style="color:${C.cyan}">$${s.final_equity.toLocaleString()}</div></div>
    </div>`;

    // ── Charts ──
    html += `<div class="card"><div class="card__title">Equity Curve vs Buy &amp; Hold</div>
        <div class="chart-wrap" style="height:280px"><div id="chart-bt-equity" style="width:100%;height:100%"></div></div></div>`;

    html += `<div class="card"><div class="card__title">Signal Score Over Time — with Entry / Exit Points</div>
        <div class="chart-wrap" style="height:260px"><div id="chart-bt-signal" style="width:100%;height:100%"></div></div>
        <div style="display:flex;gap:20px;font-size:11px;color:var(--text-sec);padding:4px 4px 0">
            <span><span style="color:${C.blue}">━</span> Signal score</span>
            <span><span style="color:${C.green}">▲</span> BUY entry (score ≥ ${buyT})</span>
            <span><span style="color:${C.red}">▼</span> SELL exit (score ≤ ${sellT})</span>
            <span style="color:var(--text-dim)">Dashed lines = thresholds</span>
        </div>
    </div>`;

    // ── Strategy logic explainer ──
    const strategyKey = d.strategy || _btStrategy;
    const strategyDescriptions = {
        combined: {
            name: 'Combined Signal Strategy',
            icon: '◆',
            color: C.cyan,
            body: `Each trading day a composite score is computed from <strong style="color:var(--text-primary)">eight technical indicators</strong>:
                <strong style="color:${C.blue}">RSI</strong> (18%) · <strong style="color:${C.blue}">MACD crossover</strong> (20%) ·
                <strong style="color:${C.blue}">Bollinger Band position</strong> (14%) · <strong style="color:${C.blue}">SMA 50/200 cross</strong> (16%) ·
                <strong style="color:${C.blue}">EMA vs price</strong> (12%) · <strong style="color:${C.blue}">Stochastic %K</strong> (12%) ·
                <strong style="color:${C.blue}">20-day momentum</strong> (8%) — blended into a score from −1.0 to +1.0.
                This multi-indicator approach reduces false signals by requiring broad consensus across momentum, trend, and volatility measures.`
        },
        sma_crossover: {
            name: 'SMA Crossover Strategy',
            icon: '⟋',
            color: C.gold,
            body: `This is the classic <strong style="color:var(--text-primary)">Golden Cross / Death Cross</strong> strategy.
                The signal is derived solely from the relationship between the <strong style="color:${C.gold}">50-day SMA</strong> and the
                <strong style="color:${C.gold}">200-day SMA</strong>. When SMA 50 crosses above SMA 200 (golden cross), a bullish signal is generated.
                When it crosses below (death cross), a bearish signal fires. The score is normalised by the percentage gap between the two averages,
                so a wider cross produces a stronger signal. This is a <em>trend-following</em> strategy with slow response but low noise.`
        },
        momentum: {
            name: 'Momentum Strategy',
            icon: '▶',
            color: C.purple,
            body: `A <strong style="color:var(--text-primary)">pure price momentum</strong> approach combining three oscillators:
                <strong style="color:${C.purple}">RSI</strong> (40%) — identifies overbought/oversold extremes;
                <strong style="color:${C.purple}">20-day Rate of Change</strong> (30%) — measures the raw speed of the price move;
                <strong style="color:${C.purple}">Stochastic %K</strong> (30%) — tracks where price sits within recent high/low range.
                All three are normalised to [−1, +1] and blended. Momentum strategies tend to enter trends early but can generate more frequent trades.`
        },
        macro_composite: {
            name: 'Macro Composite Strategy',
            icon: '🌐',
            color: C.orange,
            body: `A <strong style="color:var(--text-primary)">multi-source signal</strong> that blends four data streams into a single score:
                <strong style="color:${C.orange}">Combined Technical</strong> (70%) — the full 8-indicator composite (RSI, MACD, Bollinger Bands, SMA cross, EMA, Stochastic, Momentum);
                <strong style="color:${C.orange}">Point &amp; Figure</strong> (10%) — synthetic ATR-box reversal pattern: X-columns are bullish, O-columns bearish, scaled by column depth;
                <strong style="color:${C.orange}">Macro / FRED</strong> (20%) — live economic data fetched from the Federal Reserve database:
                <em>Yield Curve (T10Y2Y)</em> 35% — inverted curve signals contraction;
                <em>VIX Fear Gauge</em> 35% — elevated volatility suppresses the signal;
                <em>Unemployment Trend</em> 30% — rising UNRATE momentum is bearish.
                The macro component is time-aligned to each trading day via forward-fill, making the strategy macro-aware throughout history.`
        }
    };
    const strat = strategyDescriptions[strategyKey] || strategyDescriptions.combined;

    const sellTrades = d.trades.filter(t=>t.action.includes('SELL'));
    const winT = sellTrades.filter(t=>(t.pnl||0)>0);
    const lossT = sellTrades.filter(t=>(t.pnl||0)<0);
    const totalPnl = sellTrades.reduce((a,t)=>a+(t.pnl||0),0);
    const avgWin  = winT.length  ? (winT.reduce((a,t)=>a+(t.pnl||0),0)/winT.length).toFixed(2) : '—';
    const avgLoss = lossT.length ? (lossT.reduce((a,t)=>a+(t.pnl||0),0)/lossT.length).toFixed(2) : '—';
    const profitFactor = (lossT.reduce((a,t)=>a+Math.abs(t.pnl||0),0)>0)
        ? (winT.reduce((a,t)=>a+(t.pnl||0),0) / Math.abs(lossT.reduce((a,t)=>a+(t.pnl||0),0))).toFixed(2)
        : '∞';

    html += `<div class="card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
            <span style="font-size:18px;color:${strat.color}">${strat.icon}</span>
            <div class="card__title" style="margin:0">${strat.name} — Logic &amp; Trade Explanation</div>
        </div>
        <div style="font-size:13px;color:var(--text-sec);line-height:1.9;margin-bottom:16px">
            <p>${strat.body}</p>
            <p style="margin-top:8px">
                <strong style="color:${C.green}">BUY signal</strong> fires when score ≥ <code style="background:var(--accent);padding:1px 5px;border-radius:4px">${buyT}</code> and no position is held — full capital deployed.<br>
                <strong style="color:${C.red}">SELL signal</strong> fires when score ≤ <code style="background:var(--accent);padding:1px 5px;border-radius:4px">${sellT}</code> and a position is open — closes at closing price.
            </p>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:16px">
            <div style="background:var(--accent);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
                <div style="font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px">Total P&amp;L</div>
                <div style="font-size:17px;font-weight:700;font-family:var(--mono);margin-top:4px;color:${totalPnl>=0?C.green:C.red}">${totalPnl>=0?'+':''}$${totalPnl.toFixed(2)}</div>
            </div>
            <div style="background:var(--accent);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
                <div style="font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px">Winning Trades</div>
                <div style="font-size:17px;font-weight:700;font-family:var(--mono);margin-top:4px;color:${C.green}">${winT.length}</div>
            </div>
            <div style="background:var(--accent);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
                <div style="font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px">Losing Trades</div>
                <div style="font-size:17px;font-weight:700;font-family:var(--mono);margin-top:4px;color:${C.red}">${lossT.length}</div>
            </div>
            <div style="background:var(--accent);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
                <div style="font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px">Avg Win</div>
                <div style="font-size:17px;font-weight:700;font-family:var(--mono);margin-top:4px;color:${C.green}">$${avgWin}</div>
            </div>
            <div style="background:var(--accent);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
                <div style="font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px">Avg Loss</div>
                <div style="font-size:17px;font-weight:700;font-family:var(--mono);margin-top:4px;color:${C.red}">$${avgLoss}</div>
            </div>
            <div style="background:var(--accent);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
                <div style="font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px">Profit Factor</div>
                <div style="font-size:17px;font-weight:700;font-family:var(--mono);margin-top:4px;color:${parseFloat(profitFactor)>=1?C.green:C.red}">${profitFactor}</div>
            </div>
        </div>
    </div>`;

    // ── Trade-by-trade log ──
    const allTrades = d.trades.slice().reverse();
    let tradeNum = allTrades.filter(t=>t.action.includes('SELL')).length;
    const tradeRows = allTrades.map(t=>{
        const isBuy  = t.action==='BUY';
        const isSell = t.action.includes('SELL');
        const color  = isBuy ? C.green : C.red;
        const icon   = isBuy ? '▲' : '▼';
        let tradeLabel = '';
        if(isSell){ tradeLabel = `<span style="font-size:10px;color:var(--text-dim);margin-right:6px">Trade #${tradeNum--}</span>`; }
        const pnlStr = t.pnl != null
            ? `<span style="color:${t.pnl>=0?C.green:C.red};font-weight:700;font-family:var(--mono)">&nbsp;${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)}</span>`
            : '';
        const sigBar = Math.abs(t.signal)*100;
        const sigColor = t.signal>=buyT ? C.green : t.signal<=sellT ? C.red : C.gold;
        return `<div style="display:grid;grid-template-columns:90px 28px 100px 1fr auto;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px;transition:background 0.12s" onmouseover="this.style.background='var(--accent)'" onmouseout="this.style.background=''">
            <span style="color:var(--text-dim);font-family:var(--mono)">${t.date}</span>
            <span style="color:${color};font-size:14px;font-weight:700">${icon}</span>
            <span>${tradeLabel}<strong style="color:${color}">${t.action}</strong></span>
            <span style="color:var(--text-primary);font-family:var(--mono)">@ $${t.price}${pnlStr}</span>
            <span style="display:flex;align-items:center;gap:6px">
                <div style="width:60px;height:6px;background:var(--border);border-radius:3px;overflow:hidden">
                    <div style="height:100%;width:${sigBar}%;background:${sigColor};border-radius:3px"></div>
                </div>
                <span style="font-size:10px;color:${sigColor};font-family:var(--mono);width:46px">${t.signal>=0?'+':''}${t.signal}</span>
            </span>
        </div>`;
    }).join('');

    html += `<div class="card" style="padding:0">
        <div style="padding:16px 20px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
            <div class="card__title" style="margin:0">Trade-by-Trade Log</div>
            <span style="font-size:11px;color:var(--text-dim)">${allTrades.length} events · ${s.num_trades} round-trips</span>
        </div>
        <div style="display:grid;grid-template-columns:90px 28px 100px 1fr auto;gap:10px;padding:6px 12px;font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid var(--border)">
            <span>Date</span><span></span><span>Action</span><span>Price / P&amp;L</span><span>Signal</span>
        </div>
        <div style="max-height:400px;overflow-y:auto">
            ${tradeRows||'<div style="padding:24px;text-align:center;color:var(--text-dim);font-size:13px">No trades executed in this period.</div>'}
        </div>
    </div>`;

    const el = document.getElementById('bt-content');
    el.innerHTML = html;

    // ── Plotly charts (rendered after innerHTML is set) ──
    const axBase = {
        gridcolor: '#0F1D35', gridwidth: 0.5,
        linecolor: '#152038', tickcolor: '#152038',
        tickfont: { size: 10, color: '#527090', family: "'DM Sans', sans-serif" },
        zeroline: false,
    };
    const plyCfg = {
        responsive: true, displaylogo: false,
        modeBarButtonsToRemove: ['toImage','sendDataToCloud','editInChartStudio','select2d','lasso2d'],
    };
    const plyBase = {
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: '#060E1C',
        font: { family: "'DM Sans', sans-serif", size: 11, color: '#527090' },
        hovermode: 'x unified',
        hoverlabel: { bgcolor: '#0C1929', bordercolor: '#152038',
            font: { family: "'DM Sans', sans-serif", size: 11, color: '#C8E4FF' } },
        legend: { font: { size: 11, color: '#8BAFC7' }, bgcolor: 'rgba(0,0,0,0)' },
    };

    const eCurveDates = d.equity_curve.map(e=>e.date);

    // ── Equity curve ──
    Plotly.react('chart-bt-equity', [
        {
            x: eCurveDates, y: d.equity_curve.map(e=>e.equity),
            name: 'Strategy', type: 'scatter', mode: 'lines',
            line: { color: C.cyan, width: 2 },
            fill: 'tozeroy', fillcolor: 'rgba(0,192,255,0.07)',
            hovertemplate: '%{x}<br><b>Strategy:</b> $%{y:,.0f}<extra></extra>',
        },
        {
            x: d.benchmark.map(e=>e.date), y: d.benchmark.map(e=>e.equity),
            name: 'Buy & Hold', type: 'scatter', mode: 'lines',
            line: { color: C.purple, width: 1.5, dash: 'dash' },
            hovertemplate: '%{x}<br><b>Buy & Hold:</b> $%{y:,.0f}<extra></extra>',
        },
    ], {
        ...plyBase,
        margin: { l: 72, r: 20, t: 12, b: 45 },
        autosize: true,
        xaxis: { ...axBase, type: 'date', rangeslider: { visible: false } },
        yaxis: { ...axBase, automargin: true, tickprefix: '$', hoverformat: ',.0f' },
    }, plyCfg);

    // ── Signal score chart ──
    const buyPtsDates  = [], buyPtsVals  = [];
    const sellPtsDates = [], sellPtsVals = [];
    d.trades.forEach(t => {
        if(t.action === 'BUY'){
            buyPtsDates.push(t.date);
            buyPtsVals.push(t.signal);
        } else if(t.action.includes('SELL')){
            sellPtsDates.push(t.date);
            sellPtsVals.push(t.signal);
        }
    });
    const signalDates = d.equity_curve.map(e=>e.date);
    const signalVals  = d.equity_curve.map(e=>e.signal);

    Plotly.react('chart-bt-signal', [
        {
            x: signalDates, y: signalVals,
            name: 'Signal Score', type: 'scatter', mode: 'lines',
            line: { color: C.blue, width: 2 },
            hovertemplate: '%{x}<br><b>Signal:</b> %{y:+.3f}<extra></extra>',
        },
        {
            x: [signalDates[0], signalDates[signalDates.length-1]], y: [buyT, buyT],
            name: `Buy threshold (${buyT})`, type: 'scatter', mode: 'lines',
            line: { color: C.green+'99', width: 1, dash: 'dot' },
            hoverinfo: 'skip', showlegend: true,
        },
        {
            x: [signalDates[0], signalDates[signalDates.length-1]], y: [sellT, sellT],
            name: `Sell threshold (${sellT})`, type: 'scatter', mode: 'lines',
            line: { color: C.red+'99', width: 1, dash: 'dot' },
            hoverinfo: 'skip', showlegend: true,
        },
        {
            x: buyPtsDates, y: buyPtsVals,
            name: 'Buy entry', type: 'scatter', mode: 'markers',
            marker: { color: C.green, symbol: 'triangle-up', size: 10, line: { width: 0 } },
            hovertemplate: '%{x}<br><b>BUY</b> score: %{y:+.3f}<extra></extra>',
        },
        {
            x: sellPtsDates, y: sellPtsVals,
            name: 'Sell exit', type: 'scatter', mode: 'markers',
            marker: { color: C.red, symbol: 'triangle-down', size: 10, line: { width: 0 } },
            hovertemplate: '%{x}<br><b>SELL</b> score: %{y:+.3f}<extra></extra>',
        },
    ], {
        ...plyBase,
        margin: { l: 60, r: 20, t: 12, b: 45 },
        autosize: true,
        xaxis: { ...axBase, type: 'date', rangeslider: { visible: false } },
        yaxis: { ...axBase, range: [-1.05, 1.05], automargin: true,
            tickvals: [-1,-0.75,-0.5,-0.25,0,0.25,0.5,0.75,1],
            ticktext: ['-1','-.75','-.5','-.25','0','+.25','+.5','+.75','+1'] },
    }, plyCfg);
}

/* ── Enter key handlers ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', ()=>{
    ['ticker','fund-ticker','news-ticker','signal-ticker'].forEach(id=>{
        const el = document.getElementById(id);
        if(el) el.addEventListener('keydown', e=>{
            if(e.key==='Enter'){
                e.preventDefault();
                if(id==='ticker') runTech();
                if(id==='fund-ticker') runFund();
                if(id==='news-ticker') runNews();
                if(id==='signal-ticker') runSignal();
            }
        });
    });
    const corrInput = document.getElementById('corr-tickers');
    if(corrInput) corrInput.addEventListener('keydown', e=>{if(e.key==='Enter'){e.preventDefault();runCorr();}});
    const btTicker = document.getElementById('bt-ticker');
    if(btTicker) btTicker.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); runBacktest(); }});
    // Listings Explorer
    const leInput = document.getElementById('le-query');
    if(leInput) leInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); leSearch(); }});
    // Load pref form values if on profile page
    if (document.getElementById('pref-lineColor')) {
        _loadPrefForm();
        // Call the profile page's ready hook if it defined one
        if (typeof _onPrefsPageReady === 'function') _onPrefsPageReady();
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   RESET FUNCTIONS  — called by the ↺ Reset button in each module
   ═══════════════════════════════════════════════════════════════════════════ */

function resetTech(){
    _clearState('tech');
    taData = null;
    _mdData = null; _mdTicker = '';
    const tickerEl=document.getElementById('ticker'); if(tickerEl) tickerEl.value='';
    const sc=document.getElementById('tech-content');  if(sc) sc.style.display='none';
    const sl=document.getElementById('tech-loading');  if(sl) sl.style.display='none';
    const ss=document.getElementById('tech-status');   if(ss){ ss.style.display='none'; ss.innerHTML=''; }
    const sg=document.getElementById('stats-grid');    if(sg) sg.innerHTML='';
    // Reset view to chart
    const vc=document.getElementById('ta-view-chart'); if(vc) vc.style.display='';
    const vm=document.getElementById('ta-view-moredata'); if(vm) vm.style.display='none';
    document.querySelectorAll('.ta-view-btn').forEach(b=>b.classList.toggle('active',b.dataset.view==='chart'));
    const mc=document.getElementById('moredata-content'); if(mc) mc.innerHTML='';
    ['dist'].forEach(destroyChart);
    const pc = document.getElementById('ta-plotly-chart');
    if (pc) { try { Plotly.purge('ta-plotly-chart'); } catch(_) {} pc.innerHTML=''; }
    _clearDrawingsOnNewTicker();
    techPeriod   = '1Y';
    techInterval = '1d';
    // Reset interval button
    document.querySelectorAll('.ta-interval-btn').forEach(b=>b.classList.toggle('active', b.dataset.interval==='1d'));
    // Reset period buttons to daily set
    const _pb = document.getElementById('taPeriodBtns');
    if(_pb) _pb.innerHTML = _DAILY_PERIODS.map(([val,lbl],i)=>
        `<button class="period-btn${val==='1Y'?' active':''}" data-period="${val}" onclick="setPeriod(this,'tech')">${lbl}</button>`
    ).join('');
    const _hint = document.getElementById('taIntervalHint');
    if(_hint) _hint.style.display='none';
    const cr = document.getElementById('ta-custom-range');
    if(cr) cr.style.display='none';
    const tf = document.getElementById('ta-from'); if(tf) tf.value='';
    const tt = document.getElementById('ta-to');   if(tt) tt.value='';
}

function resetFund(){
    _clearState('fund');
    const el=document.getElementById('fund-ticker'); if(el) el.value='';
    ['fund-content','fund-loading','fund-company-card'].forEach(id=>{const e=document.getElementById(id);if(e)e.style.display='none';});
    const fs=document.getElementById('fund-status');       if(fs) fs.textContent='';
    const fss=document.getElementById('fund-series-stats');if(fss)fss.style.display='none';
    const ff=document.getElementById('fund-filter');       if(ff) ff.value='';
    try { Plotly.purge('chart-fund-series'); } catch(_){}
    fundData=null; fundAllItems=[];
    fundOpts={ctype:'line',period:0,scale:'auto'};
    document.querySelectorAll('[data-ctype]').forEach(b=>b.classList.toggle('active',b.dataset.ctype==='line'));
    document.querySelectorAll('[data-cperiod]').forEach(b=>b.classList.toggle('active',b.dataset.cperiod==='0'));
    document.querySelectorAll('[data-scale]').forEach(b=>b.classList.toggle('active',b.dataset.scale==='auto'));
    const cmEl=document.getElementById('fund-compare-mode');if(cmEl){cmEl.checked=false;toggleFundCompare(cmEl);}
    const tlEl=document.getElementById('fund-trendline');   if(tlEl) tlEl.checked=false;
    const dlEl=document.getElementById('fund-datalabels');  if(dlEl) dlEl.checked=false;
}

function resetCorr(){
    _clearState('corr');
    const el=document.getElementById('corr-tickers'); if(el) el.value='AAPL,MSFT,GOOGL,AMZN,TSLA,SPY';
    ['corr-content','corr-loading'].forEach(id=>{const e=document.getElementById(id);if(e)e.style.display='none';});
    const ct=document.getElementById('corr-table'); if(ct) ct.innerHTML='';
    corrPeriod='1Y';
    document.querySelectorAll('[data-period]').forEach(b=>{
        if((b.getAttribute('onclick')||'').includes("'corr'"))
            b.classList.toggle('active', b.dataset.period==='1Y');
    });
}

function resetEcon(){
    _clearState('econ');
    _econRaw=null; _econYears=1; _econType='line'; _econYoY=false;
    _econMA=false; _econNorm=false; _econRec=true; _econPins=[];
    ['econ-content','econ-loading','econ-yoy-panel'].forEach(id=>{const e=document.getElementById(id);if(e)e.style.display='none';});
    try { Plotly.purge('chart-econ'); } catch(_){}
    try { Plotly.purge('chart-econ-yoy'); } catch(_){}
    ['econ-yoy-btn','econ-ma-btn','econ-norm-btn'].forEach(id=>{
        const b=document.getElementById(id); if(b) b.classList.remove('active');
    });
    const recBtn=document.getElementById('econ-rec-btn'); if(recBtn) recBtn.classList.add('active');
    const maLbl=document.getElementById('econ-ma-label'); if(maLbl) maLbl.style.display='none';
    document.querySelectorAll('.econ-period-btn').forEach(b=>b.classList.toggle('active', b.dataset.years==='1'));
    document.querySelectorAll('.econ-type-btn').forEach(b=>b.classList.toggle('active', b.textContent.trim()==='Line'));
    renderEconPins();
}

function resetNews(){
    _clearState('news');
    const el=document.getElementById('news-ticker'); if(el) el.value='';
    ['news-content','news-loading'].forEach(id=>{const e=document.getElementById(id);if(e)e.style.display='none';});
    const ns=document.getElementById('news-status');  if(ns) ns.textContent='';
    const nm=document.getElementById('news-summary'); if(nm) nm.innerHTML='';
    ['news-tl','news-dist','news-kw'].forEach(destroyChart);
}

function resetSignal(){
    _clearState('signal');
    const el=document.getElementById('signal-ticker'); if(el) el.value='';
    const sc=document.getElementById('signal-content'); if(sc){sc.style.display='none';sc.innerHTML='';}
    const sl=document.getElementById('signal-loading'); if(sl) sl.style.display='none';
}

function resetBt(){
    _clearState('bt');
    const el=document.getElementById('bt-ticker'); if(el) el.value='';
    ['bt-content','bt-loading'].forEach(id=>{const e=document.getElementById(id);if(e)e.style.display='none';});
    const cap=document.getElementById('bt-capital');     if(cap)  cap.value='10000';
    const buy=document.getElementById('bt-buy-thresh');  if(buy)  buy.value='0.15';
    const sell=document.getElementById('bt-sell-thresh');if(sell) sell.value='-0.15';
    const lb=document.getElementById('bt-lookback');     if(lb)   lb.value='120';
    try { Plotly.purge('chart-bt-equity'); } catch(_){}
    try { Plotly.purge('chart-bt-signal'); } catch(_){}
    _btStrategy='combined';
    document.querySelectorAll('.bt-strategy-card').forEach(c=>c.classList.toggle('active',c.dataset.strategy==='combined'));
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUTO-RESTORE — re-run the last analysis when the user navigates back
   ═══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', ()=>{

    /* ── Technical Analysis ── */
    initTAFromPrefs();
    if(document.getElementById('ticker')){
        const s=_loadState('tech');
        if(s?.ticker){
            document.getElementById('ticker').value=s.ticker;
            techPeriod   = s.period   || '1Y';
            techInterval = s.interval || '1d';
            // Restore interval button
            if(techInterval !== '1d'){
                const ivBtn = document.querySelector(`.ta-interval-btn[data-interval="${techInterval}"]`);
                if(ivBtn){ setTechInterval(ivBtn); }  // rebuilds period btns too
            }
            // Restore custom range inputs if saved
            if(techPeriod === 'CUSTOM'){
                const cr = document.getElementById('ta-custom-range');
                if(cr) cr.style.display='flex';
                if(s.customFrom){ const f=document.getElementById('ta-from'); if(f) f.value=s.customFrom; }
                if(s.customTo){   const t=document.getElementById('ta-to');   if(t) t.value=s.customTo;   }
            }
            document.querySelectorAll('[data-period]').forEach(b=>{
                if((b.getAttribute('onclick')||'').includes("'tech'"))
                    b.classList.toggle('active', b.dataset.period===techPeriod);
            });
            runTech();
        }
    }

    /* ── SEC Fundamentals — ticker restored now; item/opts restored inside runFund() ── */
    if(document.getElementById('fund-ticker')){
        const s=_loadState('fund');
        if(s?.ticker){
            document.getElementById('fund-ticker').value=s.ticker;
            if(s.opts) fundOpts={...fundOpts,...s.opts};
            window._fundRestoreItem=s;
            runFund();
        }
    }

    /* ── Correlation ── */
    if(document.getElementById('corr-tickers')){
        const s=_loadState('corr');
        if(s?.tickers){
            document.getElementById('corr-tickers').value=s.tickers;
            corrPeriod=s.period||'1Y';
            document.querySelectorAll('[data-period]').forEach(b=>{
                if((b.getAttribute('onclick')||'').includes("'corr'"))
                    b.classList.toggle('active',b.dataset.period===corrPeriod);
            });
            runCorr();
        }
    }

    /* ── Economic Data ── */
    if(document.getElementById('econ-cat')){
        const s=_loadState('econ');
        if(s?.series){
            if(s.cat){document.getElementById('econ-cat').value=s.cat; updateEconSeries();}
            document.getElementById('econ-series').value=s.series;
            if(s.years!==undefined){
                _econYears=s.years;
                document.querySelectorAll('.econ-period-btn').forEach(b=>
                    b.classList.toggle('active',+b.dataset.years===s.years));
            }
            if(s.type){
                _econType=s.type;
                document.querySelectorAll('.econ-type-btn').forEach(b=>
                    b.classList.toggle('active',b.textContent.trim().toLowerCase()===s.type));
            }
            if(s.yoy){
                _econYoY=s.yoy;
                const yoyBtn=document.getElementById('econ-yoy-btn');
                if(yoyBtn) yoyBtn.classList.toggle('active',s.yoy);
                const yoyPanel=document.getElementById('econ-yoy-panel');
                if(yoyPanel) yoyPanel.style.display=s.yoy?'':'none';
            }
            runEcon();
        }
    }

    /* ── News & Sentiment ── */
    if(document.getElementById('news-ticker')){
        const s=_loadState('news');
        if(s?.ticker){
            document.getElementById('news-ticker').value=s.ticker;
            const lim=document.getElementById('news-limit');
            if(lim&&s.limit) lim.value=s.limit;
            runNews();
        }
    }

    /* ── Signal Analysis ── */
    if(document.getElementById('signal-ticker')){
        const s=_loadState('signal');
        if(s?.ticker){
            document.getElementById('signal-ticker').value=s.ticker;
            runSignal();
        }
    }

    /* ── Backtesting ── */
    if(document.getElementById('bt-ticker')){
        const s=_loadState('bt');
        if(s?.ticker){
            document.getElementById('bt-ticker').value=s.ticker;
            if(s.start)    document.getElementById('bt-start').value=s.start;
            if(s.end)      document.getElementById('bt-end').value=s.end;
            if(s.capital)  document.getElementById('bt-capital').value=s.capital;
            if(s.buyT)     document.getElementById('bt-buy-thresh').value=s.buyT;
            if(s.sellT)    document.getElementById('bt-sell-thresh').value=s.sellT;
            if(s.lookback) document.getElementById('bt-lookback').value=s.lookback;
            if(s.strategy){
                _btStrategy=s.strategy;
                document.querySelectorAll('.bt-strategy-card').forEach(c=>
                    c.classList.toggle('active',c.dataset.strategy===s.strategy));
            }
            runBacktest();
        }
    }
});

/* ═══════════════════════════════════════════════════════════════════════════
   LISTINGS EXPLORER
   ═══════════════════════════════════════════════════════════════════════════ */

const LE = {
    page:         1,
    pageSize:     20,
    allResults:   [],
    sortCol:      'relevanceScore',
    sortDir:      'desc',
    lastQuery:    '',
    chartsLoaded: false,
    ipoAllData:   null,
};

let _leDebounce = null;
let _leAcTimer  = null;

/* ── Setup (runs when Listings tab is first visited) ─────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    const inp = document.getElementById('le-query');
    if (!inp) return;   // not on listings page — skip

    inp.addEventListener('input', () => {
        const val = inp.value.trim();
        document.getElementById('leClearBtn').style.display = val ? 'flex' : 'none';
        // Autocomplete — always fire, show "searching…" immediately so dropdown stays open
        clearTimeout(_leAcTimer);
        if (val.length >= 1) {
            _leDropdownSearching();
            _leAcTimer = setTimeout(() => _leAutocomplete(val), 200);
        } else {
            _leShowHistory();
        }
        // Live search debounce (main results table)
        clearTimeout(_leDebounce);
        if (val.length >= 2) _leDebounce = setTimeout(leSearch, 450);
    });

    inp.addEventListener('focus', () => {
        if (!inp.value.trim()) _leShowHistory();
        else if (inp.value.trim().length >= 1) _leAutocomplete(inp.value.trim());
    });

    // Close dropdown only when clicking outside the search controls block
    document.addEventListener('click', e => {
        if (!e.target.closest('.le-controls-block')) _leCloseDropdown();
    });

    // ── Restore previous search results (no network call needed) ──────────
    const saved = _loadState('le');
    if (saved && saved.results && saved.results.length > 0) {
        // Restore query input
        inp.value = saved.query || '';
        if (saved.query) {
            const clearBtn = document.getElementById('leClearBtn');
            if (clearBtn) clearBtn.style.display = 'flex';
        }
        // Restore filter dropdowns
        if (saved.filters) {
            const fm = { exchange:'le-exchange', assetType:'le-type', status:'le-status',
                         ipoAfter:'le-ipo-after', ipoBefore:'le-ipo-before' };
            for (const [k, id] of Object.entries(fm)) {
                const el = document.getElementById(id);
                if (el && saved.filters[k]) el.value = saved.filters[k];
            }
        }
        // Restore state and re-render without a network fetch
        LE.allResults = saved.results;
        LE.lastQuery  = saved.query || '';
        LE.page       = 1;
        LE.sortCol    = 'relevanceScore';
        LE.sortDir    = 'desc';
        const area = document.getElementById('le-results-area');
        if (area) area.style.display = '';
        _leRenderResults({
            results: saved.results,
            total:   saved.total || saved.results.length,
            intent:  saved.intent || {},
        });
    }
});

/* ── Search ──────────────────────────────────────────────────────────────── */
function leSearch() {
    const query = (document.getElementById('le-query')?.value || '').trim();
    const filters = {
        exchange:  document.getElementById('le-exchange')?.value  || '',
        assetType: document.getElementById('le-type')?.value      || '',
        status:    document.getElementById('le-status')?.value    || '',
        ipoAfter:  document.getElementById('le-ipo-after')?.value.trim()  || '',
        ipoBefore: document.getElementById('le-ipo-before')?.value.trim() || '',
    };
    const hasFilter = Object.values(filters).some(v => v);
    if (!query && !hasFilter) return;

    LE.lastQuery = query;
    LE.page      = 1;
    if (query) _leSaveHistory(query);

    // Show loading
    const area = document.getElementById('le-results-area');
    const load = document.getElementById('le-loading');
    if (area) area.style.display = 'none';
    if (load) load.style.display = 'flex';

    fetch('/api/listings/search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, filters, useLLM: true, fuzzyThreshold: 80, limit: 200 }),
    })
    .then(r => { if (!r.ok) throw new Error('Search failed'); return r.json(); })
    .then(data => {
        if (load) load.style.display = 'none';
        if (area) area.style.display = '';
        LE.allResults = data.results;
        LE.sortCol    = 'relevanceScore';
        LE.sortDir    = 'desc';
        _leRenderResults(data);
        // ── Persist state so results survive navigation ──
        try {
            _saveState('le', {
                query, filters,
                results: data.results,
                total:   data.total,
                intent:  data.intent || {},
            });
        } catch(_){}
    })
    .catch(err => {
        if (load) load.style.display = 'none';
        if (area) { area.style.display = ''; area.innerHTML = `<div class="le-no-results"><h4>Error</h4><p>${err.message}</p></div>`; }
    });
}

function leClearSearch() {
    const inp = document.getElementById('le-query');
    if (inp) inp.value = '';
    const btn = document.getElementById('leClearBtn');
    if (btn) btn.style.display = 'none';
    _leCloseDropdown();
    LE.allResults = [];
    LE.lastQuery  = '';
    _clearState('le');   // wipe persisted results
    const badge = document.getElementById('le-badge');
    if (badge) { badge.textContent = '0'; badge.style.display = 'none'; }
    const area = document.getElementById('le-results-area');
    if (area) area.innerHTML = _leEmptyState();
}

function leClearFilters() {
    ['le-exchange','le-type','le-status'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    ['le-ipo-after','le-ipo-before'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
}

function leUseExample(btn) {
    const inp = document.getElementById('le-query');
    if (!inp) return;
    inp.value = btn.textContent;
    document.getElementById('leClearBtn').style.display = 'flex';
    leSearch();
}

/* ── Empty state HTML ────────────────────────────────────────────────────── */
function _leEmptyState() {
    return `<div class="le-empty-state">
        <div class="le-empty-icon">🔭</div>
        <div class="le-empty-title">Search the Universe</div>
        <p style="color:var(--text-sec);margin:8px 0 20px;font-size:13px">
            Search across thousands of equities, ETFs, and funds by name, symbol, sector, or strategy.
        </p>
        <div class="le-examples">
            ${['Goldman Sachs ETFs','energy stocks on NYSE','tech IPOs after 2020','delisted NASDAQ stocks','healthcare ETFs']
              .map(ex=>`<button class="quick-btn" onclick="leUseExample(this)">${ex}</button>`).join('')}
        </div>
    </div>`;
}

/* ── Navigate to TA module pre-loaded with ticker ────────────────────────── */
function leAnalyseTicker(sym, e) {
    if (e) e.stopPropagation();
    _saveState('tech', { ticker: sym.toUpperCase(), period: '1Y' });
    window.location.href = '/technical';
}

/* ── Render results ──────────────────────────────────────────────────────── */
function _leRenderResults(data) {
    const area  = document.getElementById('le-results-area');
    const badge = document.getElementById('le-badge');
    if (!area) return;

    if (badge) { badge.textContent = data.total.toLocaleString(); badge.style.display = data.total > 0 ? 'inline' : 'none'; }

    if (!data.results.length) {
        area.innerHTML = _leBuildNoResults(data);
        return;
    }

    area.innerHTML = `
        ${_leBuildIntentTags(data.intent)}
        <div class="le-results-header">
            <div class="le-results-count">
                <strong>${data.total.toLocaleString()}</strong> result${data.total !== 1 ? 's' : ''}
                ${LE.lastQuery ? `<span class="le-results-query">for "${_leEsc(LE.lastQuery)}"</span>` : ''}
            </div>
            <div style="display:flex;gap:6px;align-items:center">
                <button class="le-action-btn" onclick="leDownloadCSV()">⬇ Export CSV</button>
            </div>
        </div>
        <div class="le-table-wrap">
            <table class="le-table">
                <thead id="le-thead"></thead>
                <tbody id="le-tbody"></tbody>
            </table>
        </div>
        <div class="le-pagination" id="le-pagination"></div>`;

    _leRenderTableFull();
}

const _LE_COLS = [
    { key: 'symbol',         label: 'Symbol'        },
    { key: 'name',           label: 'Company'       },
    { key: 'exchange',       label: 'Market'        },
    { key: 'ipoDate',        label: 'Listed'        },
    { key: 'status',         label: 'Status'        },
    { key: 'relevanceScore', label: 'Relevance'     },
    { key: '_actions',       label: '',  noSort:true },
];

function _leRenderTableFull() {
    _leRenderThead();
    _leRenderTbody();
    _leRenderPagination();
}

function _leRenderThead() {
    const el = document.getElementById('le-thead');
    if (!el) return;
    el.innerHTML = `<tr>${_LE_COLS.map(c => {
        if (c.noSort) return `<th class="le-th-actions"></th>`;
        const act   = LE.sortCol === c.key;
        const arrow = act ? (LE.sortDir === 'asc' ? '▲' : '▼') : '⇅';
        return `<th class="${act ? 'le-sorted' : ''}" onclick="leSortBy('${c.key}')">
                  ${c.label}<span class="le-sort-arrow">${arrow}</span>
                </th>`;
    }).join('')}</tr>`;
}

function _leRenderTbody() {
    const el = document.getElementById('le-tbody');
    if (!el) return;
    const start = (LE.page - 1) * LE.pageSize;
    const rows  = LE.allResults.slice(start, start + LE.pageSize);
    const rank0 = start + 1;  // rank of the first row on this page

    el.innerHTML = rows.map((r, i) => {
        const rank = rank0 + i;

        // Type badge
        const typeBadge = r.assetType === 'ETF'
            ? `<span class="le-b-type le-b-type--etf">ETF</span>`
            : `<span class="le-b-type le-b-type--stock">Stock</span>`;

        // Status
        const isActive = r.status === 'Active';
        const statusBadge = isActive
            ? `<span class="le-b-status le-b-status--active"><span class="le-status-dot"></span>Active</span>`
            : `<span class="le-b-status le-b-status--delisted"><span class="le-status-dot"></span>Delisted</span>`;

        // Exchange badge
        const exBadge = r.exchange
            ? `<span class="le-b-exchange">${_leEsc(r.exchange)}</span>`
            : '';

        // Highlighted company name
        const nameHtml = _leHighlight(r.name || '—', LE.lastQuery);

        // Relevance score bar
        const score = Math.min(100, Math.round(r.relevanceScore || 0));
        const scoreCol = score >= 80 ? 'var(--cyan)' : score >= 55 ? 'var(--blue)' : score >= 30 ? 'var(--gold)' : 'var(--text-dim)';

        return `<tr class="le-row${isActive ? '' : ' le-row--delisted'}" onclick="leOpenDetail('${_leAttr(r.symbol)}')">
            <td class="le-col-sym">
                <div class="le-sym-cell">
                    <span class="le-sym-rank">${rank}</span>
                    <span class="le-sym-ticker">${_leEsc(r.symbol)}</span>
                </div>
            </td>
            <td class="le-col-name">
                <div class="le-name-cell">
                    <span class="le-name-primary">${nameHtml}</span>
                </div>
            </td>
            <td class="le-col-market">
                <div class="le-market-cell">
                    ${exBadge}
                    ${typeBadge}
                </div>
            </td>
            <td class="le-col-ipo">
                <span class="le-ipo-val">${_leEsc(r.ipoDate || '—')}</span>
            </td>
            <td class="le-col-status">${statusBadge}</td>
            <td class="le-col-score">
                <div class="le-score-wrap">
                    <div class="le-score-track">
                        <div class="le-score-fill" style="width:${score}%;background:${scoreCol}"></div>
                    </div>
                    <span class="le-score-num" style="color:${scoreCol}">${score}</span>
                </div>
            </td>
            <td class="le-col-actions" onclick="event.stopPropagation()">
                <div class="le-row-actions">
                    <button class="le-row-btn le-row-btn--detail" onclick="leOpenDetail('${_leAttr(r.symbol)}')" title="View Details">
                        ⓘ Details
                    </button>
                    <button class="le-row-btn le-row-btn--ta" onclick="leAnalyseTicker('${_leAttr(r.symbol)}',event)" title="Open in Technical Analysis">
                        📈 Analyse
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function _leRenderPagination() {
    const el = document.getElementById('le-pagination');
    if (!el) return;
    const total      = LE.allResults.length;
    const totalPages = Math.ceil(total / LE.pageSize);
    if (totalPages <= 1) { el.innerHTML = ''; return; }

    const range = _lePageRange(LE.page, totalPages);
    let html = `<button class="le-pg-btn" onclick="leGoPage(${LE.page-1})" ${LE.page===1?'disabled':''}>← Prev</button>`;
    for (const p of range) {
        if (p === '…') html += `<span class="le-pg-ellipsis">…</span>`;
        else           html += `<button class="le-pg-btn ${p===LE.page?'le-pg-btn--active':''}" onclick="leGoPage(${p})">${p}</button>`;
    }
    html += `<button class="le-pg-btn" onclick="leGoPage(${LE.page+1})" ${LE.page===totalPages?'disabled':''}>Next →</button>`;
    html += `<span class="le-pg-info">${total.toLocaleString()} total</span>`;
    el.innerHTML = html;
}

function _lePageRange(cur, tot) {
    if (tot <= 7) return Array.from({length:tot},(_,i)=>i+1);
    if (cur <= 4)         return [1,2,3,4,5,'…',tot];
    if (cur >= tot - 3)   return [1,'…',tot-4,tot-3,tot-2,tot-1,tot];
    return [1,'…',cur-1,cur,cur+1,'…',tot];
}

function leGoPage(p) {
    const tot = Math.ceil(LE.allResults.length / LE.pageSize);
    if (p < 1 || p > tot) return;
    LE.page = p;
    _leRenderThead();
    _leRenderTbody();
    _leRenderPagination();
    const tabs = document.querySelector('.tabs');
    if (tabs) window.scrollTo({ top: tabs.offsetTop - 70, behavior: 'smooth' });
}

/* ── Sort ────────────────────────────────────────────────────────────────── */
function leSortBy(col) {
    LE.sortDir = LE.sortCol === col ? (LE.sortDir === 'asc' ? 'desc' : 'asc')
                                    : (col === 'relevanceScore' ? 'desc' : 'asc');
    LE.sortCol = col;
    LE.allResults.sort((a,b) => {
        let va = a[col] ?? '', vb = b[col] ?? '';
        if (typeof va === 'number' && typeof vb === 'number')
            return LE.sortDir === 'asc' ? va - vb : vb - va;
        va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
        return LE.sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    LE.page = 1;
    _leRenderTableFull();
}

/* ── Intent tags & no-results ────────────────────────────────────────────── */
function _leBuildIntentTags(intent) {
    if (!intent || !Object.keys(intent).length) return '';
    const tags = [];
    if (intent.symbol)        tags.push(['Symbol',  intent.symbol]);
    if (intent.exchange)      tags.push(['Exchange', intent.exchange]);
    if (intent.assetType)     tags.push(['Type',     intent.assetType]);
    if (intent.status)        tags.push(['Status',   intent.status]);
    if (intent.ipoDate_start) tags.push(['IPO ≥',    intent.ipoDate_start.slice(0,4)]);
    if (intent.ipoDate_end)   tags.push(['IPO ≤',    intent.ipoDate_end.slice(0,4)]);
    if (intent.industry_hint) tags.push(['Theme',    intent.industry_hint]);
    if (!tags.length) return '';
    return `<div class="le-intent-tags">${
        tags.map(([l,v]) =>
            `<span class="le-intent-tag"><span class="le-intent-tag__lbl">${l}:</span> ${_leEsc(String(v))}</span>`
        ).join('')
    }</div>`;
}

function _leBuildNoResults(data) {
    let html = `<div class="le-no-results">
        <h4>No results found</h4>
        <p>Try rephrasing your query or adjusting the filters</p>
    </div>`;
    if (data.suggestions && data.suggestions.length) {
        html += `<div class="le-suggestions"><h5>Did you mean?</h5>${
            data.suggestions.map(s => `
                <div class="le-sug-item" onclick="leUseSuggestion('${_leEsc(s.symbol)}')">
                    <span class="le-sug-sym">${_leEsc(s.symbol)}</span>
                    <span class="le-sug-name">${_leEsc(s.name)}</span>
                    <span class="le-sug-sc">${s.score.toFixed(0)}% match</span>
                </div>`).join('')
        }</div>`;
    }
    return html;
}

function leUseSuggestion(sym) {
    const inp = document.getElementById('le-query');
    if (inp) { inp.value = sym; document.getElementById('leClearBtn').style.display = 'flex'; }
    leSearch();
}

/* ── Autocomplete ────────────────────────────────────────────────────────── */

// Show a "searching…" placeholder so the dropdown never flickers closed while fetching
function _leDropdownSearching() {
    const dd = document.getElementById('le-dropdown');
    if (!dd) return;
    // Only flash the placeholder if the dropdown isn't already showing real results
    if (dd.style.display === 'none' || dd.innerHTML.includes('le-ac-searching')) {
        dd.innerHTML = `<div class="le-ac-searching">Searching…</div>`;
        dd.style.display = 'block';
    }
}

function _leAutocomplete(q) {
    // Guard: if input was cleared while we were waiting, close
    const inp = document.getElementById('le-query');
    if (!inp || inp.value.trim() !== q) { _leCloseDropdown(); return; }

    fetch(`/api/listings/autocomplete?q=${encodeURIComponent(q)}`)
    .then(r => r.json())
    .then(items => {
        // If user has already moved on (input changed), bail out
        const current = document.getElementById('le-query')?.value.trim();
        if (current !== q) return;

        const dd = document.getElementById('le-dropdown');
        if (!dd) return;

        if (!items.length) {
            dd.innerHTML = `<div class="le-dropdown-label">No matches</div>`;
            dd.style.display = 'block';   // stay visible — don't close
            return;
        }

        dd.innerHTML = `<div class="le-dropdown-label">Top matches — click to select</div>` +
            items.map(it => {
                const b = it.assetType === 'ETF'
                    ? `<span class="le-b-type le-b-type--etf">ETF</span>`
                    : `<span class="le-b-type le-b-type--stock">Stock</span>`;
                const scoreBar = it.score
                    ? `<div class="le-ac-score-bar"><div style="width:${Math.round(it.score)}%;background:var(--cyan)"></div></div>`
                    : '';
                return `<div class="le-ac-item" onclick="leSelectAC('${_leAttr(it.symbol)}','${_leAttr(it.name)}')">
                    <span class="le-ac-sym">${_leEsc(it.symbol)}</span>
                    <span class="le-ac-name">${_leEsc(it.name)}</span>
                    <span class="le-ac-meta">
                        ${b}
                        <span style="font-size:10px;color:var(--text-dim)">${_leEsc(it.exchange)}</span>
                        ${scoreBar}
                    </span>
                </div>`;
            }).join('');
        dd.style.display = 'block';
    })
    .catch(() => {
        // On error keep dropdown open with a soft message rather than closing
        const dd = document.getElementById('le-dropdown');
        if (dd && dd.style.display !== 'none') {
            dd.innerHTML = `<div class="le-dropdown-label">Could not load suggestions</div>`;
        }
    });
}

function leSelectAC(sym, name) {
    const inp = document.getElementById('le-query');
    // Put the full company name in the box so the main search uses it
    if (inp) {
        inp.value = name || sym;
        document.getElementById('leClearBtn').style.display = 'flex';
    }
    _leCloseDropdown();
    clearTimeout(_leDebounce);
    leSearch();
}

function _leCloseDropdown() {
    const dd = document.getElementById('le-dropdown');
    if (dd) dd.style.display = 'none';
}

/* ── History ─────────────────────────────────────────────────────────────── */
const _LE_HIST_KEY = 'finsuite_le_history';
function _leSaveHistory(q) {
    try {
        let h = JSON.parse(localStorage.getItem(_LE_HIST_KEY) || '[]');
        h = [q, ...h.filter(x => x !== q)].slice(0, 10);
        localStorage.setItem(_LE_HIST_KEY, JSON.stringify(h));
    } catch(_){}
}
function _leShowHistory() {
    try {
        const h  = JSON.parse(localStorage.getItem(_LE_HIST_KEY) || '[]');
        if (!h.length) return;
        const dd = document.getElementById('le-dropdown');
        if (!dd) return;
        dd.innerHTML = `<div class="le-dropdown-label">Recent searches</div>` +
            h.map(q => `<div class="le-ac-item" onclick="leUseHistory('${_leAttr(q)}')">
                <span class="le-ac-hist">🕐</span>
                <span class="le-ac-name" style="color:var(--text-sec)">${_leEsc(q)}</span>
            </div>`).join('');
        dd.style.display = 'block';
    } catch(_){}
}
function leUseHistory(q) {
    const inp = document.getElementById('le-query');
    if (inp) { inp.value = q; document.getElementById('leClearBtn').style.display = 'flex'; }
    _leCloseDropdown();
    leSearch();
}

/* ── Detail modal ────────────────────────────────────────────────────────── */
function leOpenDetail(sym) {
    fetch(`/api/listings/detail/${encodeURIComponent(sym)}`)
    .then(r => r.json())
    .then(d => {
        if (d.error) return;
        const isETF    = d.assetType === 'ETF';
        const isActive = d.status === 'Active';
        const tb = isETF
            ? `<span class="le-b-type le-b-type--etf">ETF</span>`
            : `<span class="le-b-type le-b-type--stock">Stock</span>`;
        const sb = isActive
            ? `<span class="le-b-status le-b-status--active"><span class="le-status-dot"></span>Active</span>`
            : `<span class="le-b-status le-b-status--delisted"><span class="le-status-dot"></span>Delisted</span>`;

        document.getElementById('leModalBody').innerHTML = `
            <div class="le-md-header">
                <div class="le-md-sym">${_leEsc(d.symbol)}</div>
                <div class="le-md-badges">${tb} ${sb}</div>
            </div>
            <div class="le-md-name">${_leEsc(d.name || '—')}</div>
            <div class="le-md-divider"></div>
            <div class="le-md-grid">
                <div class="le-md-field">
                    <div class="le-md-label">Exchange</div>
                    <div class="le-md-val">${d.exchange ? `<span class="le-b-exchange">${_leEsc(d.exchange)}</span>` : '—'}</div>
                </div>
                <div class="le-md-field">
                    <div class="le-md-label">Asset Type</div>
                    <div class="le-md-val">${tb}</div>
                </div>
                <div class="le-md-field">
                    <div class="le-md-label">Status</div>
                    <div class="le-md-val">${sb}</div>
                </div>
                <div class="le-md-field">
                    <div class="le-md-label">IPO Date</div>
                    <div class="le-md-val le-md-mono">${_leEsc(d.ipoDate || '—')}</div>
                </div>
                ${d.delistingDate ? `<div class="le-md-field"><div class="le-md-label">Delisting Date</div><div class="le-md-val le-md-mono">${_leEsc(d.delistingDate)}</div></div>` : ''}
                ${d.ipoYear ? `<div class="le-md-field"><div class="le-md-label">IPO Year</div><div class="le-md-val le-md-mono">${d.ipoYear}</div></div>` : ''}
            </div>
            <div class="le-md-actions">
                ${isActive ? `
                <button class="le-md-btn le-md-btn--primary" onclick="leAnalyseTicker('${_leAttr(d.symbol)}',event);leCloseModal()">
                    📈 Open Technical Analysis
                </button>` : ''}
                <button class="le-md-btn le-md-btn--secondary" onclick="leCloseModal()">
                    Close
                </button>
            </div>`;

        document.getElementById('leModalOverlay').classList.add('open');
        document.getElementById('leModal').classList.add('open');
    })
    .catch(()=>{});
}
function leCloseModal() {
    document.getElementById('leModalOverlay').classList.remove('open');
    document.getElementById('leModal').classList.remove('open');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') leCloseModal(); });

/* ── Analytics ───────────────────────────────────────────────────────────── */
function leLoadAnalytics() {
    if (LE.chartsLoaded) return;
    fetch('/api/listings/stats')
    .then(r => r.json())
    .then(d => {
        LE.ipoAllData  = d.ipoByYear;
        LE.chartsLoaded = true;
        _leRenderIpoChart(d.ipoByYear, 'all');
        _leRenderDoughnut('le-exchange-chart', d.exchangeDist, _leExColors(d.exchangeDist));
        _leRenderDoughnut('le-type-chart',     d.typeDist,     [C.blue, C.purple]);
        _leRenderDoughnut('le-status-chart',   d.statusDist,   [C.green, C.red, C.gold]);
    })
    .catch(()=>{});
}

function _leRenderIpoChart(data, range) {
    const ctx = document.getElementById('le-ipo-chart');
    if (!ctx) return;
    destroyChart('le-ipo-chart');
    const now   = new Date().getFullYear();
    const years = Object.keys(data).map(Number).sort((a,b)=>a-b);
    const vis   = range === 'all' ? years : years.filter(y => y >= now - range);
    charts['le-ipo-chart'] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: vis,
            datasets: [{ label: 'IPOs', data: vis.map(y=>data[y]||0),
                backgroundColor: C.blue+'55', borderColor: C.blue, borderWidth:1, borderRadius:3 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend:{display:false},
                tooltip:{ callbacks:{ title:i=>`Year ${i[0].label}`, label:i=>` ${i.raw.toLocaleString()} listings` } } },
            scales: {
                x: { grid:{color:C.grid}, ticks:{color:'#3E5870',maxTicksLimit:14,font:{size:10}} },
                y: { grid:{color:C.grid}, ticks:{color:'#3E5870',font:{size:10}} }
            }
        }
    });
}

function _leRenderDoughnut(canvasId, data, colors) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    destroyChart(canvasId);
    const labels = Object.keys(data);
    const values = Object.values(data);
    const total  = values.reduce((s,v)=>s+v,0);
    charts[canvasId] = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data: values,
                backgroundColor: colors.map(c=>c+'99'),
                borderColor: colors, borderWidth:1.5, hoverOffset:5 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, cutout:'62%',
            plugins: {
                legend:{ position:'bottom', labels:{color:'#3E5870',font:{size:10},boxWidth:10,padding:8} },
                tooltip:{ callbacks:{ label:i=>` ${i.label}: ${i.raw.toLocaleString()} (${((i.raw/total)*100).toFixed(1)}%)` } }
            }
        }
    });
}

function _leExColors(data) {
    const pal = [C.cyan, C.green, C.gold, C.purple, C.orange, C.blue, C.red];
    return Object.keys(data).map((_,i)=>pal[i%pal.length]);
}

function leSetIpoRange(range, btn) {
    btn.closest('div').querySelectorAll('.period-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    if (LE.ipoAllData) _leRenderIpoChart(LE.ipoAllData, range);
}

/* ── CSV Export ──────────────────────────────────────────────────────────── */
function leDownloadCSV() {
    if (!LE.allResults.length) return;
    const cols = ['symbol','name','exchange','assetType','ipoDate','delistingDate','status','relevanceScore'];
    const csv  = [cols.join(','),
        ...LE.allResults.map(r => cols.map(c=>`"${String(r[c]??'').replace(/"/g,'""')}"`).join(','))
    ].join('\n');
    const a = document.createElement('a');
    a.href     = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = `listings_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}

/* ── Utility ─────────────────────────────────────────────────────────────── */
function _leEsc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _leAttr(s) { return String(s).replace(/'/g,"\\'"); }
function _leEscRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function _leHighlight(text, q) {
    if (!q || q.length < 2) return _leEsc(text);
    let r = _leEsc(text);
    for (const w of q.split(/\s+/).filter(w=>w.length>=2)) {
        r = r.replace(new RegExp(`(${_leEscRe(w)})`, 'gi'), '<span class="le-hl">$1</span>');
    }
    return r;
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELP SYSTEM — per-module contextual help
   ═══════════════════════════════════════════════════════════════════════════ */
const HELP_CONTENT = {
    technical: {
        title: 'Technical Analysis — Help',
        color: 'var(--blue)',
        items: [
            { icon: '▶', head: 'Run Analysis', body: 'Enter a ticker symbol (e.g. AAPL, MSFT, BTC-USD) and click <strong>Run Analysis</strong>. Use Quick buttons for common symbols or press Enter.' },
            { icon: '🕯', head: 'Chart Types', body: '<strong>Candlestick</strong> & <strong>OHLC</strong> show open/high/low/close. <strong>Line</strong> & <strong>Area</strong> show closing price. <strong>Point & Figure</strong> filters noise — set box size % and reversal multiplier.' },
            { icon: '〰', head: 'Overlays', body: 'Toggle moving averages (SMA 20/50/200, EMA 9/20), <strong>Bollinger Bands</strong>, and <strong>VWAP</strong> directly on the price chart. Colors & widths are customizable in Profile → TA Preferences.' },
            { icon: '📊', head: 'Panels', body: 'Sub-charts below the price: <strong>Volume</strong> (bar), <strong>RSI</strong> (0–100 momentum), <strong>MACD</strong> (trend crossover), <strong>Stochastic</strong> (oscillator), <strong>OBV</strong> (volume momentum), <strong>ATR</strong> (volatility).' },
            { icon: '🖱', head: 'Chart Interaction', body: 'Scroll to zoom · Click-drag to pan · Double-click to reset view · Hover for crosshair tooltip · Use the toolbar (top-right) to export as PNG.' },
            { icon: '⚙', head: 'Preferences', body: 'Go to <strong>Profile & Settings → TA Preferences</strong> to customize every color, line width, and dash style, and set your default chart type, period, and active indicators.' },
        ]
    },
    economic: {
        title: 'Economic Data — Help',
        color: 'var(--red)',
        items: [
            { icon: '📈', head: 'Series Explorer', body: 'Pick a <strong>Category</strong> (GDP, Inflation, Labor, etc.) and a <strong>Series</strong> from the dropdown, then click <strong>Load</strong>. Over 80 curated FRED series across 9 categories.' },
            { icon: '📊', head: 'Macro Dashboard', body: 'Switch to <strong>Macro Dashboard</strong> for a 6-panel overview of key indicators (GDP, CPI, Fed Funds, Unemployment, 10Y Treasury, VIX) with sparkline charts. Click <strong>Load in Explorer →</strong> to drill into any series.' },
            { icon: '🔍', head: 'FRED Search', body: 'Switch to <strong>FRED Search</strong> to search all 800,000+ FRED series by keyword. Results show series ID, title, units, and frequency. Click <strong>Load</strong> on any result to chart it instantly.' },
            { icon: '📅', head: 'Time Periods', body: 'Use <strong>1Y / 5Y / 10Y / 20Y / MAX</strong> buttons to slice the chart window. MAX shows the full available history from 1990.' },
            { icon: '📌', head: 'Compare (Pin)', body: 'Click <strong>+ Compare</strong> to pin the active series, then load another and pin it too. Up to 4 series overlay on the same chart. A secondary Y-axis appears automatically when units differ.' },
            { icon: '⚙', head: 'Overlays & Tools', body: '<strong>YoY %</strong> — year-over-year change chart · <strong>MA</strong> — moving average (12/24/36-period) · <strong>Index 100</strong> — normalises all series to 100 at the period start for easy relative comparison · <strong>Recessions</strong> — toggle NBER recession shading.' },
            { icon: '⬇', head: 'Export', body: 'Click <strong>↓ CSV</strong> to download the active series as a comma-separated file.' },
        ]
    },
    fundamentals: {
        title: 'SEC Fundamentals — Help',
        color: 'var(--gold)',
        items: [
            { icon: '🔍', head: 'Load a Company', body: 'Enter a US-listed ticker (e.g. AAPL, MSFT) and press <strong>Load</strong>. Data is pulled from SEC EDGAR XBRL filings.' },
            { icon: '📊', head: 'Chart Line Items', body: 'Select any financial line item from the dropdown and click <strong>▶ Chart</strong>. Toggle <strong>Compare Items</strong> to overlay up to 3 metrics side-by-side.' },
            { icon: '📐', head: 'Chart Options', body: '<strong>Trend Line</strong> adds a linear regression line. <strong>Data Labels</strong> shows values on each data point. <strong>Scale</strong> forces Billions or Millions. <strong>Period</strong> filters by recency.' },
            { icon: '⚖', head: 'Ratio Analysis', body: 'Click <strong>Compute Ratios</strong> to auto-calculate P/E, P/B, EV/EBITDA, Gross Margin, ROE, Debt/Equity, and more — dynamically resolved from XBRL tags.' },
            { icon: '📋', head: 'Financial Statements', body: 'View full <strong>Income Statement</strong>, <strong>Balance Sheet</strong>, and <strong>Cash Flow</strong> tables. Toggle Annual / Quarterly.' },
        ]
    },
    correlation: {
        title: 'Correlation Matrix — Help',
        color: 'var(--orange)',
        items: [
            { icon: '✏', head: 'Input Tickers', body: 'Enter comma-separated tickers (e.g. <code>AAPL,MSFT,SPY,GLD</code>) in the input field. Up to 10 symbols recommended.' },
            { icon: '📅', head: 'Select Period', body: 'Choose 6M, 1Y, or 2Y of daily returns for the correlation calculation.' },
            { icon: '🎨', head: 'Reading the Heatmap', body: '<strong style="color:#00D4AA">+1.0</strong> = perfectly correlated (move together) · <strong style="color:#FF3D6B">−1.0</strong> = perfectly inverse · <strong>0</strong> = uncorrelated (independent). Diagonal is always 1.' },
            { icon: '💡', head: 'Interpretation', body: 'Low or negative correlations between assets reduce portfolio risk through diversification. High correlations mean the assets offer little diversification benefit.' },
        ]
    },
    news: {
        title: 'News & Sentiment — Help',
        color: 'var(--purple)',
        items: [
            { icon: '🔍', head: 'Fetch News', body: 'Enter a ticker, choose the number of articles (10–100), and click <strong>Fetch News</strong>. Articles are sourced from Polygon.io.' },
            { icon: '🤖', head: 'Sentiment Scoring', body: 'Each article is scored <strong style="color:#00D4AA">Bullish</strong>, <strong style="color:#FF3D6B">Bearish</strong>, or <strong style="color:#FFB347">Neutral</strong> by an LLM based on headline and summary.' },
            { icon: '📰', head: 'Feed Tab', body: 'Browse individual articles with sentiment badges, publisher, and publication date. Click any article to open the original source.' },
            { icon: '📈', head: 'Timeline & Charts', body: '<strong>Timeline</strong> shows sentiment polarity over time. <strong>Distribution</strong> shows the bullish/bearish/neutral breakdown. <strong>Keywords</strong> shows top recurring terms.' },
        ]
    },
    signal: {
        title: 'Signal Analysis — Help',
        color: 'var(--cyan)',
        items: [
            { icon: '◆', head: 'Live Signal', body: 'Enter a ticker to compute a real-time composite signal score from −1 (strong bear) to +1 (strong bull). The gauge and breakdown show each indicator\'s contribution.' },
            { icon: '🔄', head: 'Backtest', body: 'Switch to the <strong>Backtesting</strong> tab. Enter ticker, strategy, thresholds, and lookback period, then click <strong>Run Backtest</strong>.' },
            { icon: '📐', head: 'Strategies', body: '<strong>Combined</strong>: 8-indicator composite (RSI, MACD, BB, SMA, EMA, Stoch, Momentum). <strong>SMA Crossover</strong>: Golden/Death Cross. <strong>Momentum</strong>: RSI + Rate of Change + Stochastic.' },
            { icon: '📊', head: 'Results', body: 'The <strong>Equity Curve</strong> compares strategy returns vs Buy & Hold. The <strong>Signal chart</strong> shows entry (▲) and exit (▼) points. The trade log lists every transaction.' },
            { icon: '⚙', head: 'Thresholds', body: 'Buy threshold: score ≥ this value triggers a buy. Sell threshold: score ≤ this value triggers a sell. Wider thresholds = fewer, more confident trades.' },
        ]
    },
    listings: {
        title: 'Listings Explorer — Help',
        color: 'var(--green)',
        items: [
            { icon: '🔍', head: 'Search', body: 'Type in the search box to find symbols, company names, or industries. Results update as you type.' },
            { icon: '🔽', head: 'Filters', body: 'Use the filter dropdowns to narrow by <strong>Exchange</strong>, <strong>Sector</strong>, <strong>Market Cap</strong> range, and <strong>Asset Type</strong>.' },
            { icon: '📋', head: 'Results Table', body: 'Click any column header to sort. Click a row to open the company\'s Technical Analysis view directly.' },
            { icon: '📊', head: 'IPO Calendar', body: 'Switch to the IPO Calendar tab to see upcoming IPOs with expected pricing, exchange, and industry.' },
        ]
    },
    alerts: {
        title: 'Alert Center — Help',
        color: 'var(--gold)',
        items: [
            { icon: '🔔', head: 'Create Alerts', body: 'Set price alerts (above/below a level) or indicator-based alerts for any ticker. Alerts are checked periodically.' },
            { icon: '✅', head: 'Triggered Alerts', body: 'When a condition is met the alert appears in the Triggered section with timestamp and the value that triggered it.' },
            { icon: '🗑', head: 'Manage', body: 'Delete individual alerts or clear all triggered alerts using the controls next to each item.' },
        ]
    },
    dashboard: {
        title: 'Dashboard — Help',
        color: 'var(--cyan)',
        items: [
            { icon: '🏠', head: 'Overview', body: 'The dashboard shows your watchlist tickers with real-time prices, and provides quick-access cards to every module.' },
            { icon: '⭐', head: 'Watchlist', body: 'Add tickers to your watchlist in <strong>Profile & Settings</strong>. They\'ll appear here with live price data.' },
            { icon: '🧭', head: 'Navigation', body: 'Use the left sidebar to navigate between modules. The top bar shows the current date/time and your account.' },
        ]
    },
};

function showHelp(module) {
    const content = HELP_CONTENT[module];
    if (!content) return;
    const modal = document.getElementById('helpModal');
    const titleEl = document.getElementById('helpModalTitle');
    const bodyEl  = document.getElementById('helpModalBody');
    if (!modal) return;

    titleEl.textContent = content.title;
    titleEl.style.borderLeftColor = content.color;

    bodyEl.innerHTML = content.items.map(item => `
        <div class="help-item">
            <div class="help-item__icon" style="color:${content.color}">${item.icon}</div>
            <div class="help-item__text">
                <div class="help-item__head">${item.head}</div>
                <div class="help-item__body">${item.body}</div>
            </div>
        </div>
    `).join('');

    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeHelp() {
    const modal = document.getElementById('helpModal');
    if (modal) modal.classList.remove('show');
    document.body.style.overflow = '';
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeHelp(); });


// ═══════════════════════════════════════════════════════════════════════════════
//  TRADING JOURNAL
// ═══════════════════════════════════════════════════════════════════════════════

let _tjAllEntries  = [];
let _tjSortCol     = 'entry_date';
let _tjSortDir     = 'desc';

function openJournal() {
    document.getElementById('tjOverlay').classList.add('show');
    document.getElementById('tjDrawer').classList.add('show');
    document.body.style.overflow = 'hidden';
    _tjLoad();
}

function closeJournal() {
    document.getElementById('tjOverlay').classList.remove('show');
    document.getElementById('tjDrawer').classList.remove('show');
    document.body.style.overflow = '';
}

async function _tjLoad() {
    try {
        const [listRes, statsRes] = await Promise.all([
            fetch('/api/journal'),
            fetch('/api/journal/stats')
        ]);
        const list  = await listRes.json();
        const stats = await statsRes.json();
        _tjAllEntries = list.entries || [];
        _tjRenderStats(stats);
        _tjRenderTable();
    } catch(e) {
        console.error('Journal load error:', e);
    }
}

function _tjRenderStats(s) {
    const pnlColor = (s.total_pnl || 0) >= 0 ? '#00D478' : '#FF3348';
    document.getElementById('tjStatTrades').textContent = s.total_trades ?? '—';
    document.getElementById('tjStatOpen').textContent   = s.open_trades  ?? '—';
    document.getElementById('tjStatWR').textContent     = s.win_rate != null ? s.win_rate + '%' : '—';
    const pnlEl = document.getElementById('tjStatPnL');
    pnlEl.textContent = s.total_pnl != null ? (s.total_pnl >= 0 ? '+$' : '-$') + Math.abs(s.total_pnl).toFixed(2) : '—';
    pnlEl.style.color = pnlColor;
    document.getElementById('tjStatPF').textContent = s.profit_factor != null ? s.profit_factor + 'x' : '—';
    document.getElementById('tjStatRR').textContent = s.avg_rr != null ? '1:' + s.avg_rr : '—';
}

function tjSort(col) {
    if (_tjSortCol === col) { _tjSortDir = _tjSortDir === 'asc' ? 'desc' : 'asc'; }
    else { _tjSortCol = col; _tjSortDir = 'desc'; }
    document.querySelectorAll('.tj-sort-icon').forEach(el => {
        el.textContent = el.dataset.col === col ? (_tjSortDir === 'asc' ? '↑' : '↓') : '⇅';
    });
    _tjRenderTable();
}

function tjApplyFilters() { _tjRenderTable(); }

function _tjGetFiltered() {
    const ticker = (document.getElementById('tjFilterTicker')?.value || '').toUpperCase().trim();
    const status = document.getElementById('tjFilterStatus')?.value || 'all';
    const side   = document.getElementById('tjFilterSide')?.value || '';
    return _tjAllEntries.filter(e => {
        if (ticker && !e.ticker.toUpperCase().includes(ticker)) return false;
        if (status !== 'all' && e.status !== status) return false;
        if (side && e.side !== side) return false;
        return true;
    });
}

function _tjRenderTable() {
    const tbody = document.getElementById('tjTbody');
    if (!tbody) return;
    let rows = _tjGetFiltered();

    // Sort
    rows.sort((a, b) => {
        let av = a[_tjSortCol] ?? '';
        let bv = b[_tjSortCol] ?? '';
        if (typeof av === 'string') av = av.toLowerCase();
        if (typeof bv === 'string') bv = bv.toLowerCase();
        if (av < bv) return _tjSortDir === 'asc' ? -1 :  1;
        if (av > bv) return _tjSortDir === 'asc' ?  1 : -1;
        return 0;
    });

    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="10" class="tj-empty">No trades match the current filters.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(e => {
        const pnlPct  = e.pnl_pct != null ? e.pnl_pct.toFixed(2) : null;
        const pnlColor= (e.pnl || 0) >= 0 ? '#00D478' : '#FF3348';
        const statusCl= e.status === 'open' ? 'tj-badge--open' : 'tj-badge--closed';
        const sideCl  = e.side === 'long'   ? 'tj-badge--long' : 'tj-badge--short';
        const rr      = e.risk_reward != null ? '1:' + e.risk_reward : '—';
        return `<tr class="tj-row" onclick="viewTradeDetail(${e.id})">
            <td><span class="tj-ticker">${_tjEsc(e.ticker)}</span></td>
            <td><span class="tj-badge ${sideCl}">${e.side.toUpperCase()}</span></td>
            <td class="tj-cell-setup">${_tjEsc(e.setup_type || '—')}</td>
            <td>${_tjEsc(e.entry_date || '—')}</td>
            <td>$${(e.entry_price||0).toFixed(2)}</td>
            <td>${e.exit_price != null ? '$'+e.exit_price.toFixed(2) : '—'}</td>
            <td style="color:${pnlColor};font-weight:600">${pnlPct != null ? (e.pnl_pct >= 0 ? '+' : '') + pnlPct + '%' : '—'}</td>
            <td>${rr}</td>
            <td><span class="tj-badge ${statusCl}">${e.status}</span></td>
            <td onclick="event.stopPropagation()">
                <div class="tj-row-actions">
                    <button class="tj-act-btn" onclick="openTradeForm(${e.id})" title="Edit">✏️</button>
                    <button class="tj-act-btn tj-act-btn--del" onclick="deleteTrade(${e.id})" title="Delete">🗑</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function _tjEsc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Open form (new or edit) ──────────────────────────────────────────────────
async function openTradeForm(id) {
    const title = document.getElementById('tjFormTitle');
    const overlay = document.getElementById('tjFormOverlay');
    _tjFormClear();
    // Set today as default entry date for new trades
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('tjFEntryDate').value = today;

    if (id) {
        title.textContent = 'Edit Trade';
        document.getElementById('tjEditId').value = id;
        try {
            const res  = await fetch(`/api/journal/${id}`);
            const data = await res.json();
            _tjFormFill(data);
        } catch(e) { console.error(e); }
    } else {
        title.textContent = 'Log New Trade';
        document.getElementById('tjEditId').value = '';
    }
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeTradeForm() {
    document.getElementById('tjFormOverlay').classList.remove('show');
    document.body.style.overflow = 'hidden'; // drawer still open
}

function _tjFormClear() {
    ['tjFTicker','tjFCompany','tjFEntryDate','tjFExitDate','tjFEntryPrice','tjFExitPrice',
     'tjFQty','tjFSL','tjFTP','tjFSetup','tjFEntryRat','tjFExitRat','tjFMistakes',
     'tjFLessons','tjFTags'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const side = document.getElementById('tjFSide'); if(side) side.value = 'long';
    const asset= document.getElementById('tjFAsset'); if(asset) asset.value = 'equity';
    const stat = document.getElementById('tjFStatus'); if(stat) stat.value = 'open';
    const tf   = document.getElementById('tjFTimeframe'); if(tf) tf.value = '';
    const emo  = document.getElementById('tjFEmotion'); if(emo) emo.value = '';
    const conv = document.getElementById('tjFConviction'); if(conv) conv.value = 3;
    const convV= document.getElementById('tjConvVal'); if(convV) convV.textContent = '3';
}

function _tjFormFill(e) {
    const s = v => v != null ? v : '';
    document.getElementById('tjFTicker').value     = s(e.ticker);
    document.getElementById('tjFCompany').value    = s(e.company_name);
    document.getElementById('tjFSide').value       = s(e.side)        || 'long';
    document.getElementById('tjFAsset').value      = s(e.asset_type)  || 'equity';
    document.getElementById('tjFStatus').value     = s(e.status)      || 'open';
    document.getElementById('tjFTimeframe').value  = s(e.timeframe)   || '';
    document.getElementById('tjFSetup').value      = s(e.setup_type);
    document.getElementById('tjFEntryDate').value  = s(e.entry_date);
    document.getElementById('tjFEntryPrice').value = e.entry_price != null ? e.entry_price : '';
    document.getElementById('tjFExitDate').value   = s(e.exit_date);
    document.getElementById('tjFExitPrice').value  = e.exit_price  != null ? e.exit_price  : '';
    document.getElementById('tjFQty').value        = e.quantity     != null ? e.quantity    : '';
    document.getElementById('tjFSL').value         = e.stop_loss    != null ? e.stop_loss   : '';
    document.getElementById('tjFTP').value         = e.take_profit  != null ? e.take_profit : '';
    document.getElementById('tjFEmotion').value    = s(e.emotional_state);
    document.getElementById('tjFConviction').value = e.conviction || 3;
    document.getElementById('tjConvVal').textContent = e.conviction || 3;
    document.getElementById('tjFEntryRat').value   = s(e.entry_rationale);
    document.getElementById('tjFExitRat').value    = s(e.exit_rationale);
    document.getElementById('tjFMistakes').value   = s(e.mistakes);
    document.getElementById('tjFLessons').value    = s(e.lessons);
    document.getElementById('tjFTags').value       = s(e.tags);
}

async function submitTradeForm() {
    const ticker = (document.getElementById('tjFTicker')?.value || '').trim().toUpperCase();
    const ep     = document.getElementById('tjFEntryPrice')?.value;
    const ed     = document.getElementById('tjFEntryDate')?.value;
    if (!ticker || !ep || !ed) {
        alert('Ticker, entry date and entry price are required.');
        return;
    }
    const editId = document.getElementById('tjEditId')?.value;
    const payload = {
        ticker,
        company_name:    document.getElementById('tjFCompany')?.value || '',
        side:            document.getElementById('tjFSide')?.value || 'long',
        asset_type:      document.getElementById('tjFAsset')?.value || 'equity',
        status:          document.getElementById('tjFStatus')?.value || 'open',
        timeframe:       document.getElementById('tjFTimeframe')?.value || '',
        setup_type:      document.getElementById('tjFSetup')?.value || '',
        entry_date:      ed,
        entry_price:     ep,
        exit_date:       document.getElementById('tjFExitDate')?.value || null,
        exit_price:      document.getElementById('tjFExitPrice')?.value || null,
        quantity:        document.getElementById('tjFQty')?.value || 1,
        stop_loss:       document.getElementById('tjFSL')?.value || null,
        take_profit:     document.getElementById('tjFTP')?.value || null,
        conviction:      document.getElementById('tjFConviction')?.value || 3,
        emotional_state: document.getElementById('tjFEmotion')?.value || '',
        entry_rationale: document.getElementById('tjFEntryRat')?.value || '',
        exit_rationale:  document.getElementById('tjFExitRat')?.value || '',
        mistakes:        document.getElementById('tjFMistakes')?.value || '',
        lessons:         document.getElementById('tjFLessons')?.value || '',
        tags:            document.getElementById('tjFTags')?.value || '',
    };
    try {
        const url    = editId ? `/api/journal/${editId}` : '/api/journal';
        const method = editId ? 'PUT' : 'POST';
        const res  = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!data.ok) { alert('Error: ' + (data.error || 'Unknown error')); return; }
        closeTradeForm();
        _tjLoad();
    } catch(e) {
        alert('Network error: ' + e.message);
    }
}

async function deleteTrade(id) {
    if (!confirm('Delete this trade entry? This cannot be undone.')) return;
    try {
        await fetch(`/api/journal/${id}`, { method: 'DELETE' });
        _tjLoad();
    } catch(e) { console.error(e); }
}

async function viewTradeDetail(id) {
    // Open the edit form to view/edit full details
    openTradeForm(id);
}

// Close journal on Escape
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (document.getElementById('tjFormOverlay')?.classList.contains('show')) { closeTradeForm(); }
        else if (document.getElementById('tjDrawer')?.classList.contains('show'))  { closeJournal(); }
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  CHART DRAWING TOOLS (Technical Analysis only)
// ═══════════════════════════════════════════════════════════════════════════════

let _drawTool        = null;    // 'horizontal'|'vertical'|'support'|'resistance'|'trendline'
let _drawPending     = null;    // single-click pending { type, x, y }
let _chartDrawings   = [];      // committed drawings
let _drawIdCounter   = 0;

// Trendline two-click state machine
let _drawTrendState       = null;   // null | 'waiting_p2'
let _drawTrendP1          = null;   // { x, xTs, y } first anchor
let _drawTrendMoveHandler = null;   // ref for removing mousemove listener
let _drawTrendRafPending  = false;
let _drawTrendPendingP2   = null;   // second anchor waiting for label dialog
let _drawTrendColor       = '#FFB020';  // selected trendline color

// OHLC snap data (populated by buildTAChart)
let _taSnapData = null;

const _DRAW_COLORS = {
    horizontal: '#00C0FF',
    vertical:   '#8855FF',
    support:    '#00D478',
    resistance: '#FF3348',
    trendline:  '#FFB020',
};

// ── Tool Activation ──────────────────────────────────────────────────────────

function activateDrawTool(tool) {
    if (!document.getElementById('drawToolbar')) return;

    // Toggle off if same tool clicked again
    if (_drawTool === tool) {
        _deactivateAllDrawTools();
        return;
    }

    // If switching away from an in-progress trendline, abort it
    if (_drawTool === 'trendline' && _drawTrendState === 'waiting_p2') {
        _abortTrendline();
    }

    _drawTool = tool;
    _clearToolbarActive();

    const btnMap = {
        horizontal:'drawBtnH', vertical:'drawBtnV',
        support:'drawBtnS',    resistance:'drawBtnR',
        trendline:'drawBtnTL',
    };
    const btn = document.getElementById(btnMap[tool]);
    if (btn) btn.classList.add('active');

    const hints = {
        horizontal: 'Click chart to place a horizontal price level',
        vertical:   'Click chart to place a vertical date marker',
        support:    'Click chart to mark a support level',
        resistance: 'Click chart to mark a resistance level',
        trendline:  '① Click first anchor point on chart',
    };
    _setDrawHint(hints[tool] || '');
    _attachChartClickHandler();
}

function _deactivateAllDrawTools() {
    if (_drawTool === 'trendline' && _drawTrendState === 'waiting_p2') {
        _abortTrendline();
    }
    _drawTool = null;
    _clearToolbarActive();
    _setDrawHint('');
    _removeChartClickHandler();
}

function _clearToolbarActive() {
    ['drawBtnH','drawBtnV','drawBtnS','drawBtnR','drawBtnTL'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
}

function _setDrawHint(msg) {
    const el = document.getElementById('drawHint');
    if (el) el.textContent = msg;
}

function _attachChartClickHandler() {
    const el = document.getElementById('ta-plotly-chart');
    if (!el) return;
    el.removeEventListener('click', _drawChartClick);
    el.addEventListener('click', _drawChartClick);
}

function _removeChartClickHandler() {
    const el = document.getElementById('ta-plotly-chart');
    if (el) el.removeEventListener('click', _drawChartClick);
    _removeTrendMoveHandler();
}

// ── Shared pixel→data coordinate helper ──────────────────────────────────────

function _pixelToDataCoords(event) {
    const el = document.getElementById('ta-plotly-chart');
    if (!el) return null;
    let layout;
    try { layout = el._fullLayout; } catch(_) { return null; }
    if (!layout) return null;

    const rect = el.getBoundingClientRect();
    const xpx  = event.clientX - rect.left;
    const ypx  = event.clientY - rect.top;

    const xaxis = layout.xaxis;
    const yaxis = layout.yaxis;
    if (!xaxis || !yaxis || !xaxis.range || !yaxis.range) return null;

    const pl = xaxis._offset || 0;
    const pw = xaxis._length || (rect.width  - pl - 20);
    const pt = yaxis._offset || 0;
    const ph = yaxis._length || (rect.height - pt - 40);

    const xFrac = Math.max(0, Math.min(1, (xpx - pl) / pw));
    const yFrac = Math.max(0, Math.min(1, (ypx - pt) / ph));

    const yMin  = yaxis.range[0];
    const yMax  = yaxis.range[1];
    const yData = yMax + yFrac * (yMin - yMax);

    // Category axis: range is [startIdx, endIdx]; use _categories or snap data
    const cats = xaxis._categories || (_taSnapData ? _taSnapData.dates : []);
    const r0 = Number(xaxis.range[0]);
    const r1 = Number(xaxis.range[1]);
    const idxFloat = r0 + xFrac * (r1 - r0);
    const xIdx = Math.round(Math.max(0, Math.min(cats.length - 1, idxFloat)));
    const xData = cats[xIdx] || (xIdx < cats.length ? cats[xIdx] : '');
    // Approximate timestamp (handles both "YYYY-MM-DD" and "YYYY-MM-DD HH:MM")
    const xTs = new Date(xData.replace(' ', 'T')).getTime() || Date.now();

    return { x: xData, xTs, xIdx, y: yData, xPx: xpx, yPx: ypx, pl, pw, pt, ph, xaxis, yaxis };
}

// ── OHLC Magnetic Snap ────────────────────────────────────────────────────────

function _snapToOHLC(coords) {
    if (!_taSnapData || !_taSnapData.dates.length) return coords;
    const el = document.getElementById('ta-plotly-chart');
    if (!el) return coords;
    let layout;
    try { layout = el._fullLayout; } catch(_) { return coords; }
    const xaxis = layout.xaxis;
    const yaxis = layout.yaxis;
    if (!xaxis || !yaxis || !xaxis.range || !yaxis.range) return coords;

    const { pl, pw, pt, ph, xPx, yPx } = coords;
    // Category axis: range uses bar indices
    const r0   = Number(xaxis.range[0]);
    const r1   = Number(xaxis.range[1]);
    const yMin = yaxis.range[0];
    const yMax = yaxis.range[1];
    const SNAP_PX = 14;

    function idxToPx(idx)    { return pl + ((idx - r0) / (r1 - r0)) * pw; }
    function priceToPy(price) { return pt + ((yMax - price) / (yMax - yMin)) * ph; }

    let bestDist = SNAP_PX;
    let bestX = coords.x, bestY = coords.y, bestIdx = coords.xIdx ?? -1;

    for (let i = 0; i < _taSnapData.dates.length; i++) {
        const cx = idxToPx(i);
        if (Math.abs(cx - xPx) > SNAP_PX * 2) continue;
        for (const price of [_taSnapData.highs[i], _taSnapData.lows[i], _taSnapData.closes[i]]) {
            if (price == null) continue;
            const cy   = priceToPy(price);
            const dist = Math.sqrt((cx - xPx) ** 2 + (cy - yPx) ** 2);
            if (dist < bestDist) {
                bestDist = dist;
                bestX    = _taSnapData.dates[i];
                bestY    = price;
                bestIdx  = i;
            }
        }
    }
    return { ...coords, x: bestX, y: bestY, xIdx: bestIdx };
}

// ── Main click handler ────────────────────────────────────────────────────────

function _drawChartClick(event) {
    if (!_drawTool) return;
    // Prevent Plotly's own click from interfering
    event.stopPropagation();

    let coords = _pixelToDataCoords(event);
    if (!coords) return;
    coords = _snapToOHLC(coords);

    if (_drawTool === 'trendline') {
        _handleTrendlineClick(coords);
        return;
    }

    // Single-click tools
    _drawPending = { type: _drawTool, x: coords.x, y: coords.y };
    const typeLabels = {
        horizontal: 'Horizontal Line',
        vertical:   'Vertical Date Line',
        support:    'Support Level',
        resistance: 'Resistance Level',
    };
    const prefixes = { support: 'Support ', resistance: 'Resistance ' };
    const pfx = prefixes[_drawTool] || '';
    const defaultLbl = _drawTool === 'vertical'
        ? String(coords.x)
        : pfx + coords.y.toFixed(2);

    _showLabelDialog({
        title: 'Label this ' + (typeLabels[_drawTool] || 'line'),
        placeholder: defaultLbl,
        showTLOptions: false,
    });
}

// ── Trendline State Machine ────────────────────────────────────────────────────

function _handleTrendlineClick(coords) {
    if (_drawTrendState === null) {
        // First click — store P1, start live preview
        _drawTrendState = 'waiting_p2';
        _drawTrendP1    = coords;
        _setDrawHint('② Click second anchor point  |  Esc to cancel');

        // Attach mousemove for live rubber-band preview
        _drawTrendMoveHandler = _trendlineMouseMove;
        const chartEl = document.getElementById('ta-plotly-chart');
        if (chartEl) chartEl.addEventListener('mousemove', _drawTrendMoveHandler);

        // Place a dot marker at P1
        _updateTrendPreview(coords, coords);

    } else if (_drawTrendState === 'waiting_p2') {
        // Second click — store P2, show dialog
        _removeTrendMoveHandler();
        _drawTrendState   = null;
        _drawTrendPendingP2 = coords;

        // Compute slope info for display
        const p1 = _drawTrendP1;
        const p2 = coords;
        const deltaY   = p2.y - p1.y;
        const deltaTs  = p2.xTs - p1.xTs;
        const deltaDays = deltaTs / 86400000;
        const pctChg   = p1.y > 0 ? (deltaY / p1.y * 100) : 0;
        const slopePerDay = deltaDays !== 0 ? (deltaY / deltaDays) : 0;
        const infoHTML = `
            <div class="draw-tl-stat"><span class="draw-tl-stat__lbl">From</span><span class="draw-tl-stat__val">${p1.x} · $${p1.y.toFixed(2)}</span></div>
            <div class="draw-tl-stat"><span class="draw-tl-stat__lbl">To</span><span class="draw-tl-stat__val">${p2.x} · $${p2.y.toFixed(2)}</span></div>
            <div class="draw-tl-stat"><span class="draw-tl-stat__lbl">Δ Price</span><span class="draw-tl-stat__val ${deltaY>=0?'draw-tl-stat__val--up':'draw-tl-stat__val--dn'}">${deltaY>=0?'+':''}${deltaY.toFixed(2)} (${pctChg>=0?'+':''}${pctChg.toFixed(1)}%)</span></div>
            <div class="draw-tl-stat"><span class="draw-tl-stat__lbl">Days</span><span class="draw-tl-stat__val">${Math.abs(deltaDays).toFixed(0)}</span></div>
            <div class="draw-tl-stat"><span class="draw-tl-stat__lbl">Slope</span><span class="draw-tl-stat__val">$${slopePerDay.toFixed(3)}/day</span></div>`;

        const defaultLabel = `Trendline ${p1.x} → ${p2.x}`;
        _showLabelDialog({
            title:         'Configure Trendline',
            placeholder:   defaultLabel,
            showTLOptions: true,
            infoHTML,
        });
    }
}

function _trendlineMouseMove(event) {
    if (_drawTrendState !== 'waiting_p2') return;
    if (_drawTrendRafPending) return;
    _drawTrendRafPending = true;
    requestAnimationFrame(() => {
        _drawTrendRafPending = false;
        let coords = _pixelToDataCoords(event);
        if (!coords) return;
        coords = _snapToOHLC(coords);
        _updateTrendPreview(_drawTrendP1, coords);
    });
}

function _updateTrendPreview(p1, p2) {
    const el = document.getElementById('ta-plotly-chart');
    if (!el || !el._fullLayout) return;
    const { shapes, annotations } = _buildShapesAnnotations();

    const col = _drawTrendColor;
    // Live preview shape (dotted)
    shapes.push({
        type: 'line', xref: 'x', yref: 'y',
        x0: p1.x, y0: p1.y, x1: p2.x, y1: p2.y,
        line: { color: col, width: 1.5, dash: 'dot' },
        layer: 'above',
    });
    // Anchor dot at P1
    annotations.push({
        xref: 'x', yref: 'y',
        x: p1.x, y: p1.y,
        text: '●', showarrow: false,
        font: { color: col, size: 10 },
    });

    try { Plotly.relayout('ta-plotly-chart', { shapes, annotations }); } catch(_) {}
}

function _removeTrendMoveHandler() {
    const chartEl = document.getElementById('ta-plotly-chart');
    if (chartEl && _drawTrendMoveHandler) {
        chartEl.removeEventListener('mousemove', _drawTrendMoveHandler);
    }
    _drawTrendMoveHandler = null;
    _drawTrendRafPending  = false;
}

function _abortTrendline() {
    _removeTrendMoveHandler();
    _drawTrendState     = null;
    _drawTrendP1        = null;
    _drawTrendPendingP2 = null;
    _applyDrawingsToChart(); // remove preview
}

function selectTLColor(btn, color) {
    _drawTrendColor = color;
    document.querySelectorAll('.draw-color-swatch').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

// ── Label Dialog ──────────────────────────────────────────────────────────────

function _showLabelDialog({ title, placeholder, showTLOptions, infoHTML }) {
    const dialog  = document.getElementById('drawLabelDialog');
    const titleEl = document.getElementById('drawLabelTitle');
    const input   = document.getElementById('drawLabelInput');
    const tlOpts  = document.getElementById('drawTLOptions');
    const tlInfo  = document.getElementById('drawTLInfo');
    if (!dialog) return;

    titleEl.textContent   = title;
    input.placeholder     = placeholder;
    input.value           = '';
    if (tlOpts) tlOpts.style.display = showTLOptions ? '' : 'none';
    if (tlInfo && infoHTML) tlInfo.innerHTML = infoHTML;

    // Reset color swatches
    if (showTLOptions) {
        document.querySelectorAll('.draw-color-swatch').forEach(b => {
            b.classList.toggle('active', b.dataset.color === _drawTrendColor);
        });
        const extCb = document.getElementById('drawTLExtend');
        const rayCb = document.getElementById('drawTLRay');
        if (extCb) extCb.checked = true;
        if (rayCb) rayCb.checked = false;
    }

    dialog.style.display = 'flex';
    setTimeout(() => input.focus(), 50);
}

function confirmDrawLabel() {
    const dialog = document.getElementById('drawLabelDialog');
    const input  = document.getElementById('drawLabelInput');
    if (!dialog) return;

    const label = input.value.trim() || input.placeholder;

    if (_drawTrendPendingP2) {
        // Trendline confirmation
        const p1     = _drawTrendP1;
        const p2     = _drawTrendPendingP2;
        const extend = document.getElementById('drawTLExtend')?.checked ?? true;
        const ray    = document.getElementById('drawTLRay')?.checked    ?? false;
        _addDrawing({
            type: 'trendline', label,
            x1: p1.x, y1: p1.y, xTs1: p1.xTs, xIdx1: p1.xIdx ?? 0,
            x2: p2.x, y2: p2.y, xTs2: p2.xTs, xIdx2: p2.xIdx ?? 0,
            extend, ray,
            color: _drawTrendColor,
        });
        _drawTrendP1        = null;
        _drawTrendPendingP2 = null;
        _setDrawHint('① Click first anchor point on chart');
    } else if (_drawPending) {
        // Single-click line
        _addDrawing({ ..._drawPending, label });
        _drawPending = null;
    }

    dialog.style.display = 'none';
}

function cancelDrawLabel() {
    if (_drawTrendPendingP2 || (_drawTrendState === 'waiting_p2')) {
        _abortTrendline();
        if (_drawTool === 'trendline') _setDrawHint('① Click first anchor point on chart');
    }
    _drawPending        = null;
    _drawTrendPendingP2 = null;
    const dialog = document.getElementById('drawLabelDialog');
    if (dialog) dialog.style.display = 'none';
}

// Enter key in dialog
document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.getElementById('drawLabelDialog')?.style.display !== 'none') {
        e.preventDefault();
        confirmDrawLabel();
    }
    if (e.key === 'Escape') {
        if (document.getElementById('drawLabelDialog')?.style.display !== 'none') {
            cancelDrawLabel();
        } else if (_drawTrendState === 'waiting_p2') {
            _abortTrendline();
            if (_drawTool === 'trendline') _setDrawHint('① Click first anchor point on chart');
        }
    }
});

// ── Build shapes/annotations from _chartDrawings ─────────────────────────────

function _buildShapesAnnotations() {
    const shapes      = [];
    const annotations = [];

    _chartDrawings.forEach(d => {
        const col  = d.color || _DRAW_COLORS[d.type] || '#00C0FF';
        const dash = (d.type === 'support' || d.type === 'resistance') ? 'dash' : 'solid';

        if (d.type === 'trendline') {
            _buildTrendlineShape(d, shapes, annotations);
        } else if (d.type === 'vertical') {
            shapes.push({
                type: 'line', xref: 'x', yref: 'paper',
                x0: d.x, x1: d.x, y0: 0, y1: 1,
                line: { color: col, width: 1.5, dash },
            });
            annotations.push({
                xref: 'x', yref: 'paper', x: d.x, y: 0.98,
                text: d.label, showarrow: false, xanchor: 'left',
                font: { color: col, size: 11 },
                bgcolor: 'rgba(5,7,15,0.8)',
                bordercolor: col, borderwidth: 1, borderpad: 3,
            });
        } else {
            // horizontal, support, resistance
            shapes.push({
                type: 'line', xref: 'paper', yref: 'y',
                x0: 0, x1: 1, y0: d.y, y1: d.y,
                line: { color: col, width: 1.5, dash },
            });
            annotations.push({
                xref: 'paper', yref: 'y', x: 1, y: d.y,
                text: d.label, showarrow: false, xanchor: 'right',
                font: { color: col, size: 11 },
                bgcolor: 'rgba(5,7,15,0.8)',
                bordercolor: col, borderwidth: 1, borderpad: 3,
            });
        }
    });

    return { shapes, annotations };
}

function _buildTrendlineShape(d, shapes, annotations) {
    const col = d.color || '#FFB020';
    if (!_taSnapData) return;

    // Use bar indices for slope — accurate regardless of intraday gaps or weekends
    const allDates = _taSnapData.dates;
    let idx1 = d.xIdx1 ?? allDates.indexOf(d.x1);
    let idx2 = d.xIdx2 ?? allDates.indexOf(d.x2);
    if (idx1 < 0) idx1 = 0;
    if (idx2 < 0) idx2 = allDates.length - 1;
    const slopePerBar = (idx2 !== idx1) ? (d.y2 - d.y1) / (idx2 - idx1) : 0;

    let i0 = idx1, y0 = d.y1, i1 = idx2, y1 = d.y2;

    if (d.extend) {
        i0 = 0;
        i1 = allDates.length - 1;
        y0 = d.y1 + slopePerBar * (i0 - idx1);
        y1 = d.y1 + slopePerBar * (i1 - idx1);
    } else if (d.ray) {
        i1 = allDates.length - 1;
        y1 = d.y1 + slopePerBar * (i1 - idx1);
    }

    const x0 = allDates[Math.max(0, Math.min(i0, allDates.length-1))];
    const x1 = allDates[Math.max(0, Math.min(i1, allDates.length-1))];

    shapes.push({
        type: 'line', xref: 'x', yref: 'y',
        x0, y0, x1, y1,
        line: { color: col, width: 1.8, dash: 'solid' },
        layer: 'above',
    });

    // Mid-bar label
    const midIdx = Math.floor((i0 + i1) / 2);
    const midX   = allDates[Math.max(0, Math.min(midIdx, allDates.length-1))];
    const midY   = (y0 + y1) / 2;
    annotations.push({
        xref: 'x', yref: 'y', x: midX, y: midY,
        text: d.label, showarrow: false, xanchor: 'center', yanchor: 'bottom',
        font: { color: col, size: 11, family: "'DM Sans', sans-serif" },
        bgcolor: 'rgba(5,7,15,0.8)',
        bordercolor: col, borderwidth: 1, borderpad: 3,
        yshift: 6,
    });

    // Anchor dots at original P1/P2
    [{ x: d.x1, y: d.y1 }, { x: d.x2, y: d.y2 }].forEach(pt => {
        annotations.push({
            xref: 'x', yref: 'y', x: pt.x, y: pt.y,
            text: '◆', showarrow: false, xanchor: 'center',
            font: { color: col, size: 8 },
        });
    });
}

// ── Apply / add / clear ───────────────────────────────────────────────────────

function _addDrawing(d) {
    _drawIdCounter++;
    d.id = _drawIdCounter;
    _chartDrawings.push(d);
    _applyDrawingsToChart();
}

function clearDrawings() {
    _chartDrawings = [];
    _deactivateAllDrawTools();
    _abortTrendline();
    _applyDrawingsToChart();
}

function _applyDrawingsToChart() {
    const el = document.getElementById('ta-plotly-chart');
    if (!el || !el._fullLayout) return;
    const { shapes, annotations } = _buildShapesAnnotations();
    try {
        Plotly.relayout('ta-plotly-chart', { shapes, annotations });
    } catch(e) {
        console.warn('Drawing relayout error:', e);
    }
}

// Clear drawings when a new ticker is loaded
function _clearDrawingsOnNewTicker() {
    _chartDrawings   = [];
    _drawTool        = null;
    _clearToolbarActive();
    _setDrawHint('');
    _removeChartClickHandler();
    _abortTrendline();
    const dialog = document.getElementById('drawLabelDialog');
    if (dialog) dialog.style.display = 'none';
}
