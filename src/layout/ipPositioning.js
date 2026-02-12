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
 * Compute the timestamp of the first packet for each IP.
 * @param {Array} packets - Array of packet objects with src_ip, dst_ip, and timestamp
 * @returns {Map<string, number>} Map of IP -> earliest timestamp
 */
export function computeIPFirstPacketTime(packets) {
    const ipFirstTime = new Map();
    packets.forEach(p => {
        const ts = p.timestamp || p.time || 0;
        if (p.src_ip) {
            const current = ipFirstTime.get(p.src_ip);
            if (current === undefined || ts < current) {
                ipFirstTime.set(p.src_ip, ts);
            }
        }
        if (p.dst_ip) {
            const current = ipFirstTime.get(p.dst_ip);
            if (current === undefined || ts < current) {
                ipFirstTime.set(p.dst_ip, ts);
            }
        }
    });
    return ipFirstTime;
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
 * Create canonical IP pair key (alphabetically ordered).
 * @param {string} srcIp - Source IP
 * @param {string} dstIp - Destination IP
 * @returns {string} Canonical IP pair key
 */
function makeIpPairKey(srcIp, dstIp) {
    if (!srcIp || !dstIp) return 'unknown';
    return srcIp < dstIp ? `${srcIp}<->${dstIp}` : `${dstIp}<->${srcIp}`;
}

/**
 * Compute stable IP pair ordering per row from ALL packets.
 * This ordering stays fixed across zoom levels so rows don't jump.
 *
 * @param {Array} packets - Array of ALL packet objects
 * @param {Map<string, number>} ipPositions - Map of IP -> y position
 * @returns {Map<number, {order: Map<string, number>, count: number}>} yPos -> pair ordering
 */
export function computeIPPairOrderByRow(packets, ipPositions) {
    const ipPairsByRow = new Map(); // yPos -> Map(ipPairKey -> earliestTimestamp)

    for (const p of packets) {
        if (!p.src_ip || !p.dst_ip) continue;
        const yPos = ipPositions.get(p.src_ip);
        if (yPos === undefined) continue;
        const ipPairKey = makeIpPairKey(p.src_ip, p.dst_ip);
        if (!ipPairsByRow.has(yPos)) {
            ipPairsByRow.set(yPos, new Map());
        }
        const pairMap = ipPairsByRow.get(yPos);
        const timestamp = p.bin_start || p.timestamp || p.time || Infinity;
        if (!pairMap.has(ipPairKey) || timestamp < pairMap.get(ipPairKey)) {
            pairMap.set(ipPairKey, timestamp);
        }
    }

    const ipPairOrderByRow = new Map();
    for (const [yPos, pairTimestamps] of ipPairsByRow) {
        const orderedPairs = Array.from(pairTimestamps.entries())
            .sort((a, b) => a[1] - b[1])
            .map(([pair]) => pair);
        const orderMap = new Map();
        orderedPairs.forEach((pair, idx) => orderMap.set(pair, idx));
        ipPairOrderByRow.set(yPos, { order: orderMap, count: orderedPairs.length });
    }

    return ipPairOrderByRow;
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
 * @returns {Object} { ipOrder, ipPositions, ipRowHeights, ipPairOrderByRow, yDomain, height, ipCounts, ipPairCounts, ipFirstTime }
 */
export function computeIPPositioning(packets, options = {}) {
    const {
        state,
        rowGap = ROW_GAP,
        topPad = TOP_PAD,
        timearcsOrder = null,
        dotRadius = 40,
        collapsedIPs = null
    } = options;

    // Count packets per IP
    const ipCounts = computeIPCounts(packets);
    const ipList = Array.from(new Set(Array.from(ipCounts.keys())));

    // Compute first packet time for each IP (for sorting)
    const ipFirstTime = computeIPFirstPacketTime(packets);

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

    // Override row heights for collapsed IPs (single-row height)
    if (collapsedIPs && collapsedIPs.size > 0) {
        for (const ip of collapsedIPs) {
            if (ipRowHeights.has(ip)) {
                ipRowHeights.set(ip, rowGap);
            }
        }
    }

    // Initialize result containers
    let ipOrder = [];
    const ipPositions = new Map();

    // Determine IP order based on available information
    const effectiveTimearcsOrder = timearcsOrder || (state?.timearcs?.ipOrder);

    if (effectiveTimearcsOrder && effectiveTimearcsOrder.length > 0) {
        // Use TimeArcs IPs but re-sort by actual first packet time at current resolution
        // (TimeArcs uses minute resolution, but packet data may have finer timestamps)
        const ipSet = new Set(ipList);
        const timearcsIPs = effectiveTimearcsOrder.filter(ip => ipSet.has(ip));

        // Add any IPs in data but not in TimeArcs order
        ipList.forEach(ip => {
            if (!effectiveTimearcsOrder.includes(ip)) {
                timearcsIPs.push(ip);
            }
        });

        // Re-sort by actual first packet time from packet data
        ipOrder = timearcsIPs.slice().sort((a, b) => {
            const ta = ipFirstTime.get(a) || Infinity;
            const tb = ipFirstTime.get(b) || Infinity;
            if (ta !== tb) return ta - tb;  // Earliest first
            return a.localeCompare(b);
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
        // No TimeArcs order and force layout hasn't run - sort by first packet time
        const sortedIPs = ipList.slice().sort((a, b) => {
            const ta = ipFirstTime.get(a) || Infinity;
            const tb = ipFirstTime.get(b) || Infinity;
            if (ta !== tb) return ta - tb;  // Earliest first
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

    // Compute stable IP pair ordering per row (used during zoom to prevent row jumping)
    const ipPairOrderByRow = computeIPPairOrderByRow(packets, ipPositions);

    // Override pair ordering for collapsed IPs: all pairs → index 0, count 1
    if (collapsedIPs && collapsedIPs.size > 0) {
        for (const ip of collapsedIPs) {
            const yPos = ipPositions.get(ip);
            if (yPos === undefined) continue;
            const pairInfo = ipPairOrderByRow.get(yPos);
            if (pairInfo) {
                const collapsedOrder = new Map();
                for (const key of pairInfo.order.keys()) collapsedOrder.set(key, 0);
                ipPairOrderByRow.set(yPos, { order: collapsedOrder, count: 1 });
            }
        }
    }

    return {
        ipOrder,
        ipPositions,
        ipRowHeights,
        ipPairOrderByRow,
        yDomain,
        yRange,
        minY,
        maxY,
        height,
        ipCounts,
        ipPairCounts,
        ipFirstTime
    };
}

/**
 * Update state with computed IP positioning.
 * @param {Object} state - Global state object to update
 * @param {Object} positioning - Result from computeIPPositioning
 */
export function applyIPPositioningToState(state, positioning) {
    const { ipOrder, ipPositions, ipRowHeights, ipPairCounts, ipPairOrderByRow } = positioning;

    state.layout.ipOrder = ipOrder;
    state.layout.ipPositions.clear();
    ipPositions.forEach((pos, ip) => {
        state.layout.ipPositions.set(ip, pos);
    });

    // Store per-IP row heights and pair counts for rendering
    state.layout.ipRowHeights = ipRowHeights || new Map();
    state.layout.ipPairCounts = ipPairCounts || new Map();
    // Store stable IP pair ordering (prevents row jumping on zoom)
    state.layout.ipPairOrderByRow = ipPairOrderByRow || new Map();
}
