'use strict';

/**
 * Collecte des métriques du SERVEUR HÔTE.
 *
 * L'application tourne dans un conteneur. Pour lire les vraies métriques de la
 * machine (et pas celles du conteneur), trois montages en lecture seule sont
 * attendus :
 *   /host/proc  <- /proc
 *   /host/sys   <- /sys
 *   /host/root  <- /
 *
 * Si ces montages sont absents, on retombe sur la vue du conteneur : /proc/stat
 * et /proc/meminfo ne sont pas « namespacés » par le noyau, ils reflètent donc
 * déjà le CPU et la RAM de l'hôte. Le disque, lui, reste celui du conteneur.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOST_PROC = process.env.HOST_PROC || '/host/proc';
const HOST_SYS = process.env.HOST_SYS || '/host/sys';
const HOST_ROOT = process.env.HOST_ROOT || '/host/root';

/**
 * Chaque source a un repli : si le montage hôte n'est pas là, on lit la vue du
 * conteneur. Les compteurs CPU et la mémoire de /proc ne sont pas namespacés
 * par le noyau, ils restent donc ceux de la machine.
 */
function pickBase(primary, fallback, probe) {
  try {
    fs.accessSync(path.join(primary, probe), fs.constants.R_OK);
    return primary;
  } catch {
    return fallback;
  }
}

const PROC = pickBase(HOST_PROC, '/proc', 'stat');
const SYS = pickBase(HOST_SYS, '/sys', 'class');
const ROOT = pickBase(HOST_ROOT, '/', 'etc/hostname');
const USING_HOST_MOUNTS = PROC === HOST_PROC && ROOT === HOST_ROOT;

const PAGE_SIZE = 4096;
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 2000);

const REAL_FS = new Set([
  'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs',
  'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'nfs', 'nfs4', 'cifs', 'smb3',
  'overlay', 'ecryptfs', 'bcachefs', 'ubifs',
]);

/* ------------------------------------------------------------------ utils */

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Résout un chemin de l'hôte (ex: /var/lib/docker) vers le chemin lisible ici. */
function hostPath(mountPoint) {
  if (mountPoint === '/') return ROOT;
  return path.join(ROOT, mountPoint);
}

function unescapeMount(s) {
  return s.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function clampPct(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/* -------------------------------------------------------------------- CPU */

function readCpuTimes() {
  const raw = readFile(path.join(PROC, 'stat'));
  if (!raw) return null;

  const lines = raw.split('\n');
  let aggregate = null;
  const perCore = [];

  for (const line of lines) {
    if (!line.startsWith('cpu')) continue;
    const parts = line.trim().split(/\s+/);
    const label = parts[0];
    const nums = parts.slice(1).map(Number);
    // user nice system idle iowait irq softirq steal
    const [user, nice, system, idle, iowait, irq, softirq, steal] = nums;
    const total = nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const idleAll = (idle || 0) + (iowait || 0);
    const entry = {
      total, idle: idleAll, user: user || 0, nice: nice || 0,
      system: system || 0, iowait: iowait || 0, irq: irq || 0,
      softirq: softirq || 0, steal: steal || 0,
    };
    if (label === 'cpu') aggregate = entry;
    else perCore.push(entry);
  }
  return { aggregate, perCore };
}

function cpuUsage(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return null;
  return {
    usage: clampPct(((dt - di) / dt) * 100),
    user: clampPct(((cur.user - prev.user) / dt) * 100),
    system: clampPct(((cur.system - prev.system) / dt) * 100),
    iowait: clampPct(((cur.iowait - prev.iowait) / dt) * 100),
    steal: clampPct(((cur.steal - prev.steal) / dt) * 100),
    idle: clampPct(di / dt * 100),
  };
}

function readCpuInfo() {
  const raw = readFile(path.join(PROC, 'cpuinfo'));
  if (!raw) return {};
  const model = /^model name\s*:\s*(.+)$/m.exec(raw);
  const mhz = /^cpu MHz\s*:\s*([\d.]+)$/m.exec(raw);
  return {
    model: model ? model[1].trim() : null,
    mhz: mhz ? Math.round(Number(mhz[1])) : null,
    cores: (raw.match(/^processor\s*:/gm) || []).length || null,
  };
}

/* ------------------------------------------------------------------- RAM */

function readMemory() {
  const raw = readFile(path.join(PROC, 'meminfo'));
  if (!raw) return null;

  const fields = {};
  for (const line of raw.split('\n')) {
    const m = /^([A-Za-z_()0-9]+):\s+(\d+)/.exec(line);
    if (m) fields[m[1]] = Number(m[2]) * 1024; // kB -> octets
  }

  const total = fields.MemTotal || 0;
  const free = fields.MemFree || 0;
  const buffers = fields.Buffers || 0;
  const cached = (fields.Cached || 0) + (fields.SReclaimable || 0) - (fields.Shmem || 0);
  const available = fields.MemAvailable != null ? fields.MemAvailable : free + buffers + cached;
  const used = Math.max(0, total - available);

  const swapTotal = fields.SwapTotal || 0;
  const swapFree = fields.SwapFree || 0;

  return {
    total, free, buffers, cached: Math.max(0, cached), available, used,
    usage: total ? clampPct((used / total) * 100) : 0,
    swapTotal, swapFree,
    swapUsed: Math.max(0, swapTotal - swapFree),
    swapUsage: swapTotal ? clampPct(((swapTotal - swapFree) / swapTotal) * 100) : 0,
    dirty: fields.Dirty || 0,
  };
}

/* ----------------------------------------------------------------- disque */

function readMounts() {
  const raw = readFile(path.join(PROC, 'mounts'));
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [device, mountRaw, fstype] = parts;
    out.push({ device, mount: unescapeMount(mountRaw), fstype });
  }
  return out;
}

function statDisk(mountPoint, device, fstype) {
  const target = hostPath(mountPoint);
  let st;
  try {
    st = fs.statfsSync(target, { bigint: false });
  } catch {
    return null;
  }
  const total = st.blocks * st.bsize;
  const free = st.bfree * st.bsize;
  const available = st.bavail * st.bsize;
  const used = total - free;
  const inodesTotal = st.files;
  const inodesFree = st.ffree;
  return {
    mount: mountPoint || '/',
    device,
    fstype,
    total,
    used,
    free,
    available,
    usage: total ? clampPct((used / total) * 100) : 0,
    inodesTotal,
    inodesFree,
    inodesUsed: inodesTotal ? inodesTotal - inodesFree : 0,
    inodesUsage: inodesTotal ? clampPct(((inodesTotal - inodesFree) / inodesTotal) * 100) : 0,
  };
}

function readDisks() {
  const mounts = readMounts();
  const candidates = [];
  const seenMounts = new Set();

  for (const m of mounts) {
    if (!REAL_FS.has(m.fstype)) continue;
    if (seenMounts.has(m.mount)) continue;
    seenMounts.add(m.mount);
    const d = statDisk(m.mount, m.device, m.fstype);
    if (!d || d.total === 0) continue;
    if (m.fstype === 'overlay') {
      // Les piles overlay de Docker sont innombrables : on garde un seul
      // représentant, étiqueté par son répertoire de stockage réel.
      d.mount = 'docker (overlay)';
      d.device = m.mount.replace('/merged', '');
    }
    candidates.push(d);
  }

  // Toujours exposer la racine, même si /proc/mounts est illisible.
  if (!candidates.some((d) => d.mount === '/')) {
    const root = statDisk('/', 'racine hôte', 'système de fichiers racine');
    if (root) candidates.push(root);
  }

  // Les montages liés d'un même périphérique renvoient les mêmes statistiques :
  // on privilégie « / », puis les chemins les plus courts.
  candidates.sort((a, b) => {
    if (a.mount === '/') return -1;
    if (b.mount === '/') return 1;
    return a.mount.length - b.mount.length;
  });

  const out = [];
  const signatures = new Set();
  for (const d of candidates) {
    const sig = `${d.total}|${d.used}|${d.available}`;
    if (signatures.has(sig)) continue;
    signatures.add(sig);
    out.push(d);
  }

  out.sort((a, b) => b.total - a.total);
  return out.slice(0, 12);
}

/* -------------------------------------------------------------- processus */

function readPids() {
  try {
    return fs.readdirSync(path.join(PROC))
      .filter((n) => /^\d+$/.test(n))
      .map(Number);
  } catch {
    return [];
  }
}

function readProcTable() {
  const table = new Map();
  for (const pid of readPids()) {
    const base = path.join(PROC, String(pid));
    const stat = readFile(path.join(base, 'stat'));
    if (!stat) continue;
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const name = stat.slice(stat.indexOf('(') + 1, close);
    const rest = stat.slice(close + 2).trim().split(/\s+/);
    const utime = Number(rest[11]) || 0;
    const stime = Number(rest[12]) || 0;
    const rss = Number(rest[21]) || 0; // rss en pages (field 24)
    const state = rest[0];
    table.set(pid, { pid, name, state, ticks: utime + stime, rssBytes: rss * PAGE_SIZE });
  }
  return table;
}

/* --------------------------------------------------------------- réseau */

function readNetDev() {
  const raw = readFile(path.join(PROC, 'net/dev'));
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n').slice(2)) {
    const m = /^\s*([^:]+):\s*(.+)$/.exec(line);
    if (!m) continue;
    const iface = m[1].trim();
    if (iface === 'lo') continue;
    const n = m[2].trim().split(/\s+/).map(Number);
    out.push({ iface, rxBytes: n[0], txBytes: n[8] });
  }
  return out;
}

/* ----------------------------------------------------------- températures */

function readTemps() {
  const out = [];
  const base = path.join(SYS, 'class/thermal');
  try {
    for (const zone of fs.readdirSync(base)) {
      const raw = readFile(path.join(base, zone, 'temp'));
      if (!raw) continue;
      const milli = Number(raw.trim());
      if (!Number.isFinite(milli)) continue;
      let label = readFile(path.join(base, zone, 'type'));
      label = label ? label.trim() : zone;
      out.push({ label, celsius: milli / 1000 });
    }
  } catch { /* pas de capteurs exposés */ }
  return out.filter((t) => t.celsius > -50 && t.celsius < 200).slice(0, 8);
}

/* ------------------------------------------------------------ assemblage */

const state = {
  prevCpuTimes: null,
  prevTotal: 0,
  prevProcs: new Map(),
  prevNet: new Map(),
  snapshot: null,
  lastError: null,
};

function totalJiffies(t) {
  if (!t) return 0;
  return t.aggregate.total;
}

function collect() {
  const warnings = [];
  const usingHostMounts = USING_HOST_MOUNTS;

  if (!usingHostMounts) {
    warnings.push(
      'Montages hôte absents (/host/proc) : métriques CPU/RAM de l’hôte lues via /proc, disques limités au conteneur.'
    );
  }

  const cpuTimes = readCpuTimes();
  const cpuDelta = cpuUsage(
    state.prevCpuTimes && state.prevCpuTimes.aggregate,
    cpuTimes && cpuTimes.aggregate
  );
  const prevPerCore = state.prevPerCore || [];
  const perCore = (cpuTimes ? cpuTimes.perCore : []).map((cur, i) => {
    const d = cpuUsage(prevPerCore[i], cur);
    return d ? Number(d.usage.toFixed(1)) : null;
  });

  const info = readCpuInfo();
  const loadRaw = readFile(path.join(PROC, 'loadavg'));
  const load = loadRaw ? loadRaw.trim().split(/\s+/).slice(0, 3).map(Number) : [0, 0, 0];

  // Processus : deltas de ticks par rapport à l'échantillon précédent.
  const procs = readProcTable();
  const totalDelta = totalJiffies(cpuTimes) - state.prevTotal;
  const processes = [];
  if (totalDelta > 0) {
    for (const [pid, p] of procs) {
      const prev = state.prevProcs.get(pid);
      if (!prev) continue;
      const d = p.ticks - prev.ticks;
      if (d <= 0) continue;
      processes.push({
        pid,
        name: p.name,
        cpu: Number(((d / totalDelta) * 100).toFixed(1)),
        rss: p.rssBytes,
      });
    }
    processes.sort((a, b) => b.cpu - a.cpu);
  }

  // Réseau : débit depuis le dernier échantillon.
  const net = readNetDev().map((n) => {
    const prev = state.prevNet.get(n.iface);
    const dt = SAMPLE_MS / 1000;
    return {
      iface: n.iface,
      rxTotal: n.rxBytes,
      txTotal: n.txBytes,
      rxRate: prev ? Math.max(0, (n.rxBytes - prev.rxBytes) / dt) : 0,
      txRate: prev ? Math.max(0, (n.txBytes - prev.txBytes) / dt) : 0,
    };
  });

  const uptimeRaw = readFile(path.join(PROC, 'uptime'));
  const uptime = uptimeRaw ? Number(uptimeRaw.trim().split(/\s+/)[0]) : os.uptime();

  let hostname = readFile(path.join(ROOT, 'etc/hostname'));
  hostname = hostname ? hostname.trim() : os.hostname();

  const mem = readMemory();
  if (!mem) warnings.push('Mémoire illisible (/proc/meminfo).');

  const snapshot = {
    ts: Date.now(),
    sampleMs: SAMPLE_MS,
    source: usingHostMounts ? 'hôte (montages dédiés)' : 'conteneur (repli)',
    warnings,
    host: {
      hostname,
      kernel: os.release(),
      platform: `${os.platform()} ${os.arch()}`,
      uptime,
      cpuModel: info.model || os.cpus()[0]?.model || 'inconnu',
      cpuMhz: info.mhz,
      cores: cpuTimes ? cpuTimes.perCore.length : os.cpus().length,
      load,
    },
    cpu: {
      usage: cpuDelta ? Number(cpuDelta.usage.toFixed(1)) : null,
      user: cpuDelta ? Number(cpuDelta.user.toFixed(1)) : null,
      system: cpuDelta ? Number(cpuDelta.system.toFixed(1)) : null,
      iowait: cpuDelta ? Number(cpuDelta.iowait.toFixed(1)) : null,
      steal: cpuDelta ? Number(cpuDelta.steal.toFixed(1)) : null,
      perCore,
    },
    memory: mem,
    disks: readDisks(),
    network: net,
    temps: readTemps(),
    processes: processes.slice(0, 8),
  };

  state.prevCpuTimes = cpuTimes;
  state.prevPerCore = cpuTimes ? cpuTimes.perCore : [];
  state.prevTotal = totalJiffies(cpuTimes);
  state.prevProcs = procs;
  state.prevNet = new Map(net.map((n) => [n.iface, { rxBytes: n.rxTotal, txBytes: n.txTotal }]));
  state.snapshot = snapshot;
  state.lastError = null;
  return snapshot;
}

function latest() {
  if (!state.snapshot) return collect();
  return state.snapshot;
}

function start() {
  collect(); // échantillon 1 (les deltas seront nuls)
  setTimeout(() => collect(), 900); // échantillon 2 : premiers débits exploitables
  const timer = setInterval(() => {
    try {
      collect();
    } catch (err) {
      state.lastError = err.message;
    }
  }, SAMPLE_MS);
  timer.unref?.();
  return timer;
}

module.exports = {
  start,
  latest,
  collect,
  paths: { PROC, SYS, ROOT, HOST_PROC, HOST_SYS, HOST_ROOT, usingHostMounts: USING_HOST_MOUNTS },
};
