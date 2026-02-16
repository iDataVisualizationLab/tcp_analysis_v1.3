// src/data/binning.js
// Packet binning and aggregation for visualization

import { classifyFlags, getFlagType } from '../tcp/flags.js';

/**
 * Calculate zoom level from scale and time extent.
 * @param {Function} xScale - D3 scale function
 * @param {Array} timeExtent - [min, max] time in microseconds
 * @returns {number} Zoom level (1 = full view, higher = zoomed in)
 */
export function calculateZoomLevel(xScale, timeExtent) {
    const domain = xScale.domain();
    const originalRange = timeExtent[1] - timeExtent[0];
    const currentRange = domain[1] - domain[0];
    return originalRange / currentRange;
}

/**
 * Calculate bin size based on zoom level and time range.
 * @param {number} zoomLevel
 * @param {number} timeRangeMicroseconds
 * @param {number} binCount - Target number of bins
 * @param {boolean} useBinning - Whether binning is enabled
 * @returns {number} Bin size in microseconds (0 = no binning)
 */
export function getBinSize(zoomLevel, timeRangeMicroseconds, binCount, useBinning = true) {
    if (!useBinning) return 0;
    const timeRangeSeconds = Math.max(1, timeRangeMicroseconds / 1000000);
    const binSeconds = timeRangeSeconds / binCount;
    return Math.max(1, Math.floor(binSeconds * 1000000));
}

/**
 * Get packets visible in current scale domain.
 * @param {Array} packets - All packets
 * @param {Function} xScale - D3 scale with current domain
 * @returns {Array} Visible packets
 */
export function getVisiblePackets(packets, xScale) {
    if (!packets || packets.length === 0) return [];
    const [minTime, maxTime] = xScale.domain();
    return packets.filter(d => {
        const timestamp = Math.floor(d.timestamp);
        return timestamp >= minTime && timestamp <= maxTime;
    });
}

/**
 * Bin packets for efficient visualization.
 * @param {Array} packets - Packets to bin
 * @param {Object} options - Binning options
 * @returns {Array} Binned packet data
 */
export function binPackets(packets, options) {
    const {
        xScale,
        timeExtent,
        findIPPosition,
        ipPositions,
        pairs,
        binCount = 300,
        useBinning = true,
        width = 800,
        isPreBinned = false  // Skip binning for pre-binned data
    } = options;

    if (!packets || packets.length === 0) return [];

    // If data is already pre-binned (from multi-resolution), just add yPos and return
    if (isPreBinned) {
        return packets.map(p => {
            const yPos = findIPPosition(p.src_ip, p.src_ip, p.dst_ip, pairs, ipPositions);
            return {
                ...p,
                yPos,
                binned: p.binned !== false,
                flagType: p.flagType || p.flag_type || 'OTHER',
                binCenter: p.binCenter || p.bin_start || p.timestamp,
                originalPackets: p.originalPackets || [p]
            };
        });
    }

    const zoomLevel = calculateZoomLevel(xScale, timeExtent);
    const currentDomain = xScale.domain();
    const currentTimeRange = currentDomain[1] - currentDomain[0];
    const relevantTimeRange = Math.max(1, currentTimeRange);

    const binSize = getBinSize(zoomLevel, relevantTimeRange, binCount, useBinning);
    const microsPerPixel = Math.max(1, Math.floor(relevantTimeRange / Math.max(1, width)));
    const estBins = Math.max(1, Math.min(binCount, Math.floor(width)));
    const expectedPktsPerBin = packets.length / estBins;
    const disableBinning = (binSize === 0) || (binSize <= microsPerPixel) || (expectedPktsPerBin < 1.15);

    if (disableBinning) {
        return groupByPosition(packets, { findIPPosition, ipPositions, pairs });
    }

    return binByTime(packets, binSize, { findIPPosition, ipPositions, pairs });
}

/**
 * Group overlapping packets by position (no time binning).
 * @private
 */
function groupByPosition(packets, { findIPPosition, ipPositions, pairs }) {
    const positionGroups = new Map();

    packets.forEach(packet => {
        const timestamp = Math.floor(packet.timestamp);
        const yPos = findIPPosition(packet.src_ip, packet.src_ip, packet.dst_ip, pairs, ipPositions);
        const flagType = getFlagType(packet);
        const positionKey = `${timestamp}_${yPos}_${flagType}`;

        if (!positionGroups.has(positionKey)) {
            positionGroups.set(positionKey, {
                timestamp: packet.timestamp,
                src_ip: packet.src_ip,
                dst_ip: packet.dst_ip,
                flags: packet.flags,
                flagType,
                yPos,
                count: 0,
                originalPackets: [],
                binned: false,
                totalBytes: 0,
                allIPs: new Set()
            });
        }

        const group = positionGroups.get(positionKey);
        group.count++;
        group.originalPackets.push(packet);
        group.totalBytes += (packet.length || 0);
        group.allIPs.add(packet.src_ip);
        group.allIPs.add(packet.dst_ip);
    });

    return Array.from(positionGroups.values());
}

/**
 * Bin packets by time intervals.
 * @private
 */
function binByTime(packets, binSize, { findIPPosition, ipPositions, pairs }) {
    // Analyze sparsity to adjust bin size
    const connectionCounts = new Map();
    packets.forEach(packet => {
        const key = `${packet.src_ip}-${packet.dst_ip}`;
        connectionCounts.set(key, (connectionCounts.get(key) || 0) + 1);
    });

    const totalConnections = connectionCounts.size;
    const sparseConnections = Array.from(connectionCounts.values()).filter(count => count <= 3).length;
    const sparseRatio = totalConnections > 0 ? sparseConnections / totalConnections : 0;

    let adjustedBinSize = binSize;
    if (sparseRatio > 0.7) adjustedBinSize = Math.max(binSize / 4, 100000);
    else if (sparseRatio > 0.5) adjustedBinSize = Math.max(binSize / 2, 200000);

    const bins = new Map();

    packets.forEach(packet => {
        const timestamp = Math.floor(packet.timestamp);
        const timeBin = Math.floor(timestamp / adjustedBinSize) * adjustedBinSize;
        const yPos = findIPPosition(packet.src_ip, packet.src_ip, packet.dst_ip, pairs, ipPositions);
        const flagType = getFlagType(packet);
        const binKey = `${timeBin}_${yPos}_${flagType}`;

        if (!bins.has(binKey)) {
            bins.set(binKey, {
                timestamp: packet.timestamp,
                binTimestamp: timeBin,
                binCenter: timeBin + Math.floor(adjustedBinSize / 2),
                src_ip: packet.src_ip,
                dst_ip: packet.dst_ip,
                flags: packet.flags,
                flagType,
                yPos,
                count: 0,
                originalPackets: [],
                binned: true,
                totalBytes: 0,
                allIPs: new Set()
            });
        }

        const bin = bins.get(binKey);
        bin.count++;
        bin.originalPackets.push(packet);
        bin.totalBytes += (packet.length || 0);
        bin.allIPs.add(packet.src_ip);
        bin.allIPs.add(packet.dst_ip);
    });

    const binnedData = Array.from(bins.values());

    // Mark single-packet bins as unbinned
    binnedData.forEach(bin => {
        if (bin.count === 1) {
            bin.binned = false;
            bin.originalPackets = [bin.originalPackets[0]];
        }
    });

    return binnedData;
}

/**
 * Compute bar width in pixels from binned data.
 * @param {Array} binned - Binned packet data
 * @param {Function} xScale - D3 scale
 * @param {number} binCount - Target bin count
 * @returns {number} Bar width in pixels
 */
export function computeBarWidthPx(binned, xScale, binCount = 300) {
    try {
        if (!Array.isArray(binned) || binned.length === 0 || !xScale) return 4;

        const centers = Array.from(new Set(
            binned.filter(d => d.binned && Number.isFinite(d.binCenter))
                .map(d => Math.floor(d.binCenter))
        )).sort((a, b) => a - b);

        let gap = 0;
        for (let i = 1; i < centers.length; i++) {
            const d = centers[i] - centers[i - 1];
            if (d > 0) gap = (gap === 0) ? d : Math.min(gap, d);
        }

        if (gap <= 0) {
            const domain = xScale.domain();
            const microRange = Math.max(1, domain[1] - domain[0]);
            gap = Math.floor(microRange / Math.max(1, binCount));
        }

        const half = Math.max(1, Math.floor(gap / 2));
        const px = Math.max(2, xScale(centers[0] + half) - xScale(centers[0] - half));
        return Math.max(2, Math.min(24, px));
    } catch (_) {
        return 4;
    }
}

/**
 * Get effective bin count based on render mode and config.
 * @param {Object|number} globalBinCount - Config value
 * @param {string} renderMode - 'circles' or 'bars'
 * @returns {number}
 */
export function getEffectiveBinCount(globalBinCount, renderMode = 'bars') {
    if (typeof globalBinCount === 'object' && globalBinCount) {
        return globalBinCount.BAR || globalBinCount.BARS || 300;
    }
    return (typeof globalBinCount === 'number' ? globalBinCount : 300);
}
