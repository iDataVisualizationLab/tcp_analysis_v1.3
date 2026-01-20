// src/layout/barForceLayout.js
// Force layout for IP positioning in bar diagram

import { TOP_PAD, ROW_GAP } from '../config/constants.js';

/**
 * Build force layout data from packets.
 * @param {Array} packets - Packet data
 * @param {Array} selectedIPs - Selected IP addresses
 * @param {Object} options - {width, height}
 * @returns {{nodes: Array, links: Array}}
 */
export function buildForceLayoutData(packets, selectedIPs, options = {}) {
    const { width = 800, height = 600 } = options;

    if (!packets || packets.length === 0 || !selectedIPs || selectedIPs.length === 0) {
        return { nodes: [], links: [] };
    }

    const ipSet = new Set(selectedIPs);

    // Calculate connectivity
    const ipConnectivity = new Map();
    selectedIPs.forEach(ip => ipConnectivity.set(ip, new Set()));

    packets.forEach(packet => {
        if (!packet.src_ip || !packet.dst_ip) return;
        if (packet.src_ip === packet.dst_ip) return;
        if (!ipSet.has(packet.src_ip) || !ipSet.has(packet.dst_ip)) return;

        ipConnectivity.get(packet.src_ip).add(packet.dst_ip);
        ipConnectivity.get(packet.dst_ip).add(packet.src_ip);
    });

    // Create nodes
    const nodes = selectedIPs.map((ip, idx) => ({
        id: ip,
        ip: ip,
        index: idx,
        degree: ipConnectivity.get(ip).size,
        x: width / 2,
        y: TOP_PAD + idx * ROW_GAP,
        vx: 0,
        vy: 0
    }));

    // Build links
    const linkMap = new Map();
    packets.forEach(packet => {
        if (!packet.src_ip || !packet.dst_ip) return;
        if (packet.src_ip === packet.dst_ip) return;
        if (!ipSet.has(packet.src_ip) || !ipSet.has(packet.dst_ip)) return;

        const key = packet.src_ip < packet.dst_ip
            ? `${packet.src_ip}|${packet.dst_ip}`
            : `${packet.dst_ip}|${packet.src_ip}`;

        if (!linkMap.has(key)) {
            linkMap.set(key, { count: 0, bytes: 0 });
        }
        const link = linkMap.get(key);
        link.count++;
        link.bytes += (packet.length || 0);
    });

    const links = [];
    linkMap.forEach((data, key) => {
        const [src, dst] = key.split('|');
        links.push({
            source: src,
            target: dst,
            count: data.count,
            bytes: data.bytes
        });
    });

    return { nodes, links };
}

/**
 * Compute force layout positions for IPs.
 * @param {Array} packets
 * @param {Array} selectedIPs
 * @param {Object} options - {d3, width, height, onComplete}
 * @returns {Object|null} D3 force simulation or null
 */
export function computeForceLayoutPositions(packets, selectedIPs, options) {
    const { d3, width = 800, height = 600, onComplete } = options;

    const { nodes, links } = buildForceLayoutData(packets, selectedIPs, { width, height });

    if (nodes.length === 0) {
        if (onComplete) onComplete({ ipOrder: [], ipPositions: new Map() });
        return null;
    }

    const simulation = d3.forceSimulation(nodes)
        .force('charge', d3.forceManyBody().strength(-120))
        .force('link', d3.forceLink(links)
            .id(d => d.id)
            .distance(80)
            .strength(0.5))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .alphaDecay(0.02)
        .velocityDecay(0.1)
        .alpha(0.3)
        .on('end', () => {
            const result = applyForceLayoutPositions(nodes);
            if (onComplete) onComplete(result);
        });

    return simulation;
}

/**
 * Apply computed force layout positions.
 * @param {Array} nodes - Simulation nodes with computed positions
 * @returns {{ipOrder: Array, ipPositions: Map}}
 */
export function applyForceLayoutPositions(nodes) {
    if (!nodes || nodes.length === 0) {
        return { ipOrder: [], ipPositions: new Map() };
    }

    // Sort by Y position
    const sortedNodes = nodes.slice().sort((a, b) => a.y - b.y);

    const ipOrder = sortedNodes.map(n => n.ip);
    const ipPositions = new Map();

    ipOrder.forEach((ip, idx) => {
        ipPositions.set(ip, TOP_PAD + idx * ROW_GAP);
    });

    return { ipOrder, ipPositions };
}
