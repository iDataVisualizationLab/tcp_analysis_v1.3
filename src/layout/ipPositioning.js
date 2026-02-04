// src/layout/ipPositioning.js
// IP ordering and positioning logic for TimeArcs visualization

import { ROW_GAP, TOP_PAD } from '../config/constants.js';

/**
 * Count packets per IP address.
 * @param {Array} packets - Array of packet objects with src_ip and dst_ip
 * @returns {Map<string, number>} Map of IP -> packet count
 */
export function computeIPCounts(packets) {
    const ipCounts = new Map();
    packets.forEach(p => {
        if (p.src_ip) ipCounts.set(p.src_ip, (ipCounts.get(p.src_ip) || 0) + 1);
        if (p.dst_ip) ipCounts.set(p.dst_ip, (ipCounts.get(p.dst_ip) || 0) + 1);
    });
    return ipCounts;
}

/**
 * Count unique IP pairs per source IP (for row height calculation).
 * @param {Array} packets - Array of packet objects with src_ip and dst_ip
 * @returns {Map<string, number>} Map of IP -> count of unique destination IPs
 */
export function computeIPPairCounts(packets) {
    // For each source IP, track unique destination IPs
    const srcToDstMap = new Map(); // srcIp -> Set of dstIps

    packets.forEach(p => {
        if (p.src_ip && p.dst_ip) {
            if (!srcToDstMap.has(p.src_ip)) {
                srcToDstMap.set(p.src_ip, new Set());
            }
            srcToDstMap.get(p.src_ip).add(p.dst_ip);
        }
    });

    // Convert to pair counts
    const pairCounts = new Map();
    srcToDstMap.forEach((dstSet, srcIp) => {
        pairCounts.set(srcIp, dstSet.size);
    });

    return pairCounts;
}

/**
 * Compute IP ordering and vertical positions for TimeArcs visualization.
 * Each row's height is dynamic based on how many unique destination IPs that source IP has.
 *
 * @param {Array} packets - Array of packet objects with src_ip and dst_ip
 * @param {Object} options - Configuration options
 * @param {Object} options.state - Global state object with layout and timearcs properties
 * @param {number} [options.rowGap=ROW_GAP] - Base vertical gap between IP rows
 * @param {number} [options.topPad=TOP_PAD] - Top padding for first row
 * @param {Array<string>} [options.timearcsOrder] - Optional TimeArcs IP order to use
 * @param {number} [options.dotRadius=40] - Dot radius for height calculation
 * @returns {Object} { ipOrder, ipPositions, ipRowHeights, yDomain, height, ipCounts, ipPairCounts }
 */
export function computeIPPositioning(packets, options = {}) {
    const {
        state,
        rowGap = ROW_GAP,
        topPad = TOP_PAD,
        timearcsOrder = null,
        dotRadius = 40
    } = options;

    // Count packets per IP
    const ipCounts = computeIPCounts(packets);
    const ipList = Array.from(new Set(Array.from(ipCounts.keys())));

    // Count IP pairs per source IP for dynamic row heights
    const ipPairCounts = computeIPPairCounts(packets);

    // Calculate row height for each IP based on its pair count
    // Each pair needs ~12px of vertical space, minimum is base rowGap
    const SUB_ROW_HEIGHT = 12;
    const ipRowHeights = new Map();

    ipList.forEach(ip => {
        const pairCount = ipPairCounts.get(ip) || 1;
        // Height = base gap + extra for additional pairs
        const height = Math.max(rowGap, pairCount * SUB_ROW_HEIGHT + 8);
        ipRowHeights.set(ip, height);
    });

    // Initialize result containers
    let ipOrder = [];
    const ipPositions = new Map();

    // Determine IP order based on available information
    const effectiveTimearcsOrder = timearcsOrder || (state?.timearcs?.ipOrder);

    if (effectiveTimearcsOrder && effectiveTimearcsOrder.length > 0) {
        // Use TimeArcs vertical order - filter to only IPs present in data
        const ipSet = new Set(ipList);
        ipOrder = effectiveTimearcsOrder.filter(ip => ipSet.has(ip));

        // Add any IPs in data but not in TimeArcs order at the end
        ipList.forEach(ip => {
            if (!effectiveTimearcsOrder.includes(ip)) {
                ipOrder.push(ip);
            }
        });

        // Assign vertical positions with per-IP row heights
        let currentY = topPad;
        ipOrder.forEach((ip) => {
            ipPositions.set(ip, currentY);
            currentY += ipRowHeights.get(ip) || rowGap;
        });
    } else if (!state?.layout?.ipOrder?.length ||
               !state?.layout?.ipPositions?.size ||
               state?.layout?.ipOrder?.length !== ipList.length) {
        // No TimeArcs order and force layout hasn't run - use simple sort by count
        const sortedIPs = ipList.slice().sort((a, b) => {
            const ca = ipCounts.get(a) || 0;
            const cb = ipCounts.get(b) || 0;
            if (cb !== ca) return cb - ca;
            return a.localeCompare(b);
        });

        // Initialize positions and order with per-IP row heights
        ipOrder = sortedIPs;
        let currentY = topPad;
        sortedIPs.forEach((ip) => {
            ipPositions.set(ip, currentY);
            currentY += ipRowHeights.get(ip) || rowGap;
        });
    } else {
        // Use existing force layout computed positions
        ipOrder = state.layout.ipOrder.slice();
        state.layout.ipPositions.forEach((pos, ip) => {
            ipPositions.set(ip, pos);
        });
    }

    // Compute yDomain from order
    const yDomain = ipOrder.length > 0 ? ipOrder : ipList;
    const yRange = yDomain.map(ip => ipPositions.get(ip));
    const [minY, maxY] = yRange.length > 0
        ? [Math.min(...yRange), Math.max(...yRange)]
        : [0, 0];

    // Get the last IP's row height for final padding
    const lastIp = ipOrder[ipOrder.length - 1];
    const lastRowHeight = ipRowHeights.get(lastIp) || rowGap;

    // Compute height
    const height = Math.max(500, (maxY ?? 0) + lastRowHeight + dotRadius + topPad);

    return {
        ipOrder,
        ipPositions,
        ipRowHeights,
        yDomain,
        yRange,
        minY,
        maxY,
        height,
        ipCounts,
        ipPairCounts
    };
}

/**
 * Update state with computed IP positioning.
 * @param {Object} state - Global state object to update
 * @param {Object} positioning - Result from computeIPPositioning
 */
export function applyIPPositioningToState(state, positioning) {
    const { ipOrder, ipPositions, ipRowHeights, ipPairCounts } = positioning;

    state.layout.ipOrder = ipOrder;
    state.layout.ipPositions.clear();
    ipPositions.forEach((pos, ip) => {
        state.layout.ipPositions.set(ip, pos);
    });

    // Store per-IP row heights and pair counts for rendering
    state.layout.ipRowHeights = ipRowHeights || new Map();
    state.layout.ipPairCounts = ipPairCounts || new Map();
}
