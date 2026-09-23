'use strict';

/* Tableau de bord « Mon serveur » — client sans dépendance. */

const CIRC = 2 * Math.PI * 52;
const HIST = 60;

const cpuHistory = [];
const ramHistory = [];
let failures = 0;
let refreshing = false;

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------ formatage */

function pct(v, digits = 0) {
  return v == null ? '—' : `${v.toFixed(digits)} %`;
}

function bytes(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  const n = v / 1024 ** i;
  return `${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

function rate(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${bytes(v)}/s`;
}

function duration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

function level(v, warn = 75, danger = 90) {
  if (v == null) return '';
  if (v >= danger) return 'danger';
  if (v >= warn) return 'warn';
  return 'ok';
}

function applyLevel(el, lvl) {
  el.classList.remove('level-warn', 'level-danger');
  if (lvl === 'warn') el.classList.add('level-warn');
  if (lvl === 'danger') el.classList.add('level-danger');
}

/* ------------------------------------------------------------ sparkline */

function drawSpark(canvas, data, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = 40;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (h / 4) * i + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  if (data.length < 2) return;

  const step = w / (HIST - 1);
  const offset = w - (data.length - 1) * step;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `${color}55`);
  grad.addColorStop(1, `${color}00`);

  ctx.beginPath();
  data.forEach((v, i) => {
    const x = offset + i * step;
    const y = h - (Math.max(0, Math.min(100, v)) / 100) * (h - 3) - 1.5;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo(offset + (data.length - 1) * step, h);
  ctx.lineTo(offset, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

function setGauge(arcEl, pctEl, value) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  arcEl.style.strokeDasharray = `${CIRC}`;
  arcEl.style.strokeDashoffset = `${CIRC * (1 - v / 100)}`;
  const lvl = level(v);
  arcEl.classList.remove('stroke-warn', 'stroke-danger');
  if (lvl === 'warn') arcEl.classList.add('stroke-warn');
  if (lvl === 'danger') arcEl.classList.add('stroke-danger');
  pctEl.textContent = value == null ? '—' : `${Math.round(v)}%`;
  applyLevel(pctEl, lvl);
}

/* -------------------------------------------------------------- rendu */

function renderDisks(disks) {
  const host = $('disks');
  if (!disks || !disks.length) {
    host.innerHTML = '<p class="muted">Aucun système de fichiers détecté.</p>';
    return;
  }
  const worst = Math.max(...disks.map((d) => d.usage || 0));
  const pill = $('disk-pill');
  pill.textContent = disks.length > 1 ? `${disks.length} volumes` : '1 volume';
  pill.className = `pill ${level(worst) === 'danger' ? 'level-danger' : level(worst) === 'warn' ? 'level-warn' : ''}`;

  const total = disks.reduce((a, d) => a + d.total, 0);
  const used = disks.reduce((a, d) => a + d.used, 0);
  const free = disks.reduce((a, d) => a + d.available, 0);
  const summary = `
    <div class="disk-summary">
      <div><span>Capacité totale</span><b>${bytes(total)}</b></div>
      <div><span>Utilisé</span><b class="${level((used / total) * 100) === 'warn' ? 'level-warn' : level((used / total) * 100) === 'danger' ? 'level-danger' : ''}">${bytes(used)}</b></div>
      <div><span>Libre</span><b>${bytes(free)}</b></div>
    </div>`;

  host.innerHTML = summary + disks.map((d) => {
    const lvl = level(d.usage);
    return `
      <div class="disk-row">
        <div class="disk-top">
          <span class="path">${escapeHtml(d.mount)} <small class="muted">${escapeHtml(d.fstype || '')}</small></span>
          <span class="meta ${lvl === 'warn' ? 'level-warn' : lvl === 'danger' ? 'level-danger' : ''}">
            ${bytes(d.used)} / ${bytes(d.total)} · ${pct(d.usage, 1)}
          </span>
        </div>
        <div class="bar"><i class="${lvl === 'warn' ? 'bg-warn' : lvl === 'danger' ? 'bg-danger' : ''}" style="width:${Math.min(100, d.usage)}%"></i></div>
        <div class="disk-foot muted">
          <span>${bytes(d.available)} libres</span>
          <span>inodes : ${pct(d.inodesUsage, 0)} de ${(d.inodesTotal || 0).toLocaleString('fr-FR')}</span>
        </div>
      </div>`;
  }).join('');
}

function renderNetwork(net) {
  const host = $('network');
  if (!net || !net.length) {
    host.innerHTML = '<p class="muted">Aucune interface réseau active.</p>';
    return;
  }
  host.innerHTML = net.map((n) => `
    <div class="net-row">
      <div>
        <div class="if">${escapeHtml(n.iface)}</div>
        <small class="muted">cumul ↓ ${bytes(n.rxTotal)} · ↑ ${bytes(n.txTotal)}</small>
      </div>
      <div class="rates">
        <span class="down">↓ ${rate(n.rxRate)}</span>
        <span class="up">↑ ${rate(n.txRate)}</span>
      </div>
    </div>`).join('');
}

function renderProcs(procs) {
  const body = $('procs').querySelector('tbody');
  if (!procs || !procs.length) {
    body.innerHTML = '<tr><td colspan="4" class="muted">Pas encore d’échantillon exploitable.</td></tr>';
    return;
  }
  body.innerHTML = procs.map((p) => `
    <tr>
      <td class="muted">${p.pid}</td>
      <td class="name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
      <td class="num">${p.cpu.toFixed(1)} %</td>
      <td class="num muted">${bytes(p.rss)}</td>
    </tr>`).join('');
}

function renderTemps(temps) {
  const host = $('temps');
  if (!temps || !temps.length) { host.innerHTML = ''; return; }
  host.innerHTML = temps.map((t) => {
    const lvl = t.celsius >= 80 ? 'level-danger' : t.celsius >= 65 ? 'level-warn' : '';
    return `<span class="temp"><span class="muted">${escapeHtml(t.label)}</span><b class="${lvl}">${t.celsius.toFixed(0)} °C</b></span>`;
  }).join('');
}

function renderMounts(mounts) {
  const host = $('mounts');
  if (!mounts || !mounts.length) {
    host.innerHTML = '<p class="muted small">Aucun montage /host/* — repli sur la vue du conteneur.</p>';
    return;
  }
  host.innerHTML = `<p class="muted small">Montages hôte reçus</p>` + mounts.map((m) => `
    <span class="temp">
      <span class="muted">${escapeHtml(m.path)}</span>
      <b class="${m.readOnly ? '' : 'level-warn'}">${m.readOnly ? 'ro' : 'rw'}</b>
    </span>`).join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function render(data) {
  document.title = `${data.host.hostname} — supervision`;
  $('hostname').textContent = data.host.hostname;
  $('systemline').textContent =
    `${data.host.cores} cœurs · ${data.memory ? bytes(data.memory.total) + ' de RAM' : ''} · noyau ${data.host.kernel}`;
  $('source').textContent = data.source;
  $('uptime').textContent = duration(data.host.uptime);
  $('updated').textContent = new Date(data.ts).toLocaleTimeString('fr-FR');
  $('interval').textContent = (data.sampleMs / 1000).toFixed(0);

  /* CPU */
  setGauge($('cpu-arc'), $('cpu-pct'), data.cpu.usage);
  cpuHistory.push(data.cpu.usage == null ? 0 : data.cpu.usage);
  if (cpuHistory.length > HIST) cpuHistory.shift();
  drawSpark($('cpu-spark'), cpuHistory, '#4ade80');

  $('load').textContent = (data.host.load || []).map((n) => n.toFixed(2)).join(' · ');
  $('cores').textContent = data.host.cores + (data.host.cpuMhz ? ` @ ${data.host.cpuMhz} MHz` : '');
  $('cpumodel').textContent = data.host.cpuModel;
  $('cpudetail').textContent =
    data.cpu.usage == null ? '—' : `E/S ${data.cpu.iowait.toFixed(1)} % · vol ${data.cpu.steal.toFixed(1)} %`;

  const cpuLvl = level(data.cpu.usage);
  const cpuPill = $('cpu-pill');
  cpuPill.textContent = data.cpu.usage == null ? '—' : `${data.cpu.usage.toFixed(1)} %`;
  cpuPill.className = `pill ${cpuLvl === 'warn' ? 'level-warn' : cpuLvl === 'danger' ? 'level-danger' : ''}`;

  $('percore').innerHTML = (data.cpu.perCore || [])
    .map((v) => {
      const val = v == null ? 0 : v;
      const lvl = level(val);
      return `<span class="core" title="${val.toFixed(0)} %"><i class="${lvl === 'warn' ? 'bg-warn' : lvl === 'danger' ? 'bg-danger' : ''}" style="height:${Math.max(2, Math.min(100, val))}%"></i></span>`;
    }).join('');

  /* RAM */
  const mem = data.memory;
  setGauge($('ram-arc'), $('ram-pct'), mem ? mem.usage : null);
  ramHistory.push(mem ? mem.usage : 0);
  if (ramHistory.length > HIST) ramHistory.shift();
  drawSpark($('ram-spark'), ramHistory, '#60a5fa');

  if (mem) {
    $('ram-used').textContent = `${bytes(mem.used)} / ${bytes(mem.total)}`;
    $('ram-avail').textContent = bytes(mem.available);
    $('ram-cache').textContent = bytes(mem.cached + mem.buffers);
    $('swap').textContent = mem.swapTotal
      ? `${bytes(mem.swapUsed)} / ${bytes(mem.swapTotal)} (${pct(mem.swapUsage, 0)})`
      : 'aucun';
    const ramLvl = level(mem.usage);
    const ramPill = $('ram-pill');
    ramPill.textContent = `${bytes(mem.used)} utilisés`;
    ramPill.className = `pill ${ramLvl === 'warn' ? 'level-warn' : ramLvl === 'danger' ? 'level-danger' : ''}`;
  } else {
    for (const id of ['ram-used', 'ram-avail', 'ram-cache', 'swap']) $(id).textContent = '—';
  }

  renderDisks(data.disks);
  renderNetwork(data.network);
  renderProcs(data.processes);
  renderTemps(data.temps);
  renderMounts(data.hostMounts);

  $('kernel').textContent = data.host.kernel;
  $('platform').textContent = data.host.platform;
  $('booted').textContent = new Date(data.ts - data.host.uptime * 1000).toLocaleString('fr-FR');

  const banner = $('banner');
  if (data.warnings && data.warnings.length) {
    banner.hidden = false;
    banner.textContent = data.warnings.join(' ');
  } else {
    banner.hidden = true;
  }
}

/* --------------------------------------------------------------- boucle */

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const res = await fetch('/api/metrics', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    failures = 0;
    $('live').className = 'dot on';
  } catch (err) {
    failures += 1;
    $('live').className = 'dot off';
    const banner = $('banner');
    banner.hidden = false;
    banner.textContent = `Connexion au collecteur perdue (${failures}) : ${err.message}`;
  } finally {
    refreshing = false;
  }
}

refresh();
setInterval(refresh, 2000);
window.addEventListener('resize', () => {
  drawSpark($('cpu-spark'), cpuHistory, '#4ade80');
  drawSpark($('ram-spark'), ramHistory, '#60a5fa');
});
