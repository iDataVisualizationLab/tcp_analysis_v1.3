// src/data/aggregation.js
// Link and relationship aggregation logic

/**
 * Build pairwise relationships with per-minute aggregation.
 * @param {Object[]} data - Processed records
 * @returns {Map}
 */
export function buildRelationships(data) {
  const pairKey = (a, b) => (a < b ? `${a}__${b}` : `${b}__${a}`);
  const rel = new Map();
  for (const row of data) {
    const key = pairKey(row.src_ip, row.dst_ip);
    let rec = rel.get(key);
    if (!rec) {
      rec = { counts: new Map(), max: 0, maxTime: null, a: row.src_ip, b: row.dst_ip };
      rel.set(key, rec);
    }
    const m = row.timestamp;
    const newVal = (rec.counts.get(m) || 0) + (row.count || 1);
    rec.counts.set(m, newVal);
    if (newVal > rec.max) { rec.max = newVal; rec.maxTime = m; }
  }
  return rel;
}

/**
 * Compute connectivity from relationships.
 */
export function computeConnectivityFromRelationships(relationships, threshold, allIps) {
  const res = new Map();
  for (const rec of relationships.values()) {
    if ((rec.max || 0) < threshold) continue;
    const { a, b, max, maxTime } = rec;
    const ra = res.get(a) || { max: -Infinity, time: null };
    const rb = res.get(b) || { max: -Infinity, time: null };
    if (max > ra.max || (max === ra.max && (maxTime ?? 0) < (ra.time ?? Infinity))) res.set(a, { max, time: maxTime });
    if (max > rb.max || (max === rb.max && (maxTime ?? 0) < (rb.time ?? Infinity))) res.set(b, { max, time: maxTime });
  }
  if (allIps) {
    for (const ip of allIps) if (!res.has(ip)) res.set(ip, { max: 0, time: null });
  }
  return res;
}

/**
 * Compute aggregated links per (src, dst, minute).
 * @param {Object[]} data - Processed records
 * @returns {Object[]}
 */
export function computeLinks(data) {
  const keyOf = (src, dst, m) => `${src}__${dst}__${m}`;
  const agg = new Map();
  for (const row of data) {
    const src = row.src_ip, dst = row.dst_ip, m = row.timestamp;
    const k = keyOf(src, dst, m);
    let rec = agg.get(k);
    if (!rec) {
      rec = { source: src, target: dst, minute: m, count: 0, attackCounts: new Map(), attackGroupCounts: new Map() };
      agg.set(k, rec);
    }
    const c = (row.count || 1);
    rec.count += c;
    const att = (row.attack || 'normal');
    rec.attackCounts.set(att, (rec.attackCounts.get(att) || 0) + c);
    const attg = (row.attack_group || 'normal');
    rec.attackGroupCounts.set(attg, (rec.attackGroupCounts.get(attg) || 0) + c);
  }

  const links = [];
  for (const rec of agg.values()) {
    let bestAttack = 'normal', bestCnt = -1;
    for (const [att, c] of rec.attackCounts.entries()) {
      if (c > bestCnt) { bestCnt = c; bestAttack = att; }
    }
    let bestGroup = 'normal', bestGroupCnt = -1;
    for (const [attg, c] of rec.attackGroupCounts.entries()) {
      if (c > bestGroupCnt) { bestGroupCnt = c; bestGroup = attg; }
    }
    links.push({ source: rec.source, target: rec.target, minute: rec.minute, count: rec.count, attack: bestAttack, attack_group: bestGroup });
  }

  links.sort((a, b) => (a.minute - b.minute) || (b.count - a.count) || a.source.localeCompare(b.source));
  return links;
}

/**
 * Find connected components.
 */
export function findConnectedComponents(nodes, links) {
  const ipToIndex = new Map();
  nodes.forEach((n, i) => ipToIndex.set(n.id, i));

  const adj = Array(nodes.length).fill(0).map(() => []);
  for (const link of links) {
    const srcIdx = ipToIndex.get(link.source);
    const tgtIdx = ipToIndex.get(link.target);
    if (srcIdx !== undefined && tgtIdx !== undefined) {
      adj[srcIdx].push(tgtIdx);
      adj[tgtIdx].push(srcIdx);
    }
  }

  const visited = new Set();
  const components = [];

  function dfs(nodeIdx, component) {
    visited.add(nodeIdx);
    component.push(nodeIdx);
    for (const neighbor of adj[nodeIdx]) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, component);
      }
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    if (!visited.has(i)) {
      const component = [];
      dfs(i, component);
      components.push(component.map(idx => nodes[idx].id));
    }
  }

  return components;
}
