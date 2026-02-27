// src/data/binning.js
// Packet binning and aggregation for visualization

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
