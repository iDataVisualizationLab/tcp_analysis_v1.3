// src/interaction/zoom.js
// Zoom behavior for bar diagram

/**
 * Create D3 zoom behavior with custom filter.
 * @param {Object} options - {d3, scaleExtent, onZoom}
 * @returns {Object} D3 zoom behavior
 */
export function createZoomBehavior(options) {
    const { d3, scaleExtent = [1, 1e9], onZoom } = options;

    return d3.zoom()
        .filter((event) => {
            if (!event) return true;
            // Only zoom on wheel with modifier key
            if (event.type === 'wheel') {
                return event.ctrlKey || event.metaKey || event.shiftKey;
            }
            return true;
        })
        .scaleExtent(scaleExtent)
        .on('zoom', onZoom);
}

/**
 * Apply zoom domain to scale (programmatic zoom).
 * @param {Array} newDomain - [start, end] time domain
 * @param {Object} options - {zoom, zoomTarget, xScale, timeExtent, width, d3}
 * @param {string} source - Source of zoom ('brush', 'flow', 'reset', 'program')
 */
export function applyZoomDomain(newDomain, options, source = 'program') {
    const { zoom, zoomTarget, xScale, timeExtent, width, d3 } = options;

    if (!zoom || !zoomTarget || !xScale || !timeExtent || timeExtent.length !== 2) return;

    let [a, b] = newDomain;
    const [min, max] = timeExtent;

    // Clamp and normalize
    a = Math.max(min, Math.min(max, Math.floor(a)));
    b = Math.max(min, Math.min(max, Math.floor(b)));
    if (b <= a) b = Math.min(max, a + 1);

    const fullRange = max - min;
    const selectedRange = b - a;
    const k = fullRange / selectedRange;

    const originalScale = d3.scaleLinear().domain(timeExtent).range([0, width]);
    // Correct transform math: x = -k * S0(a)
    const tx = -k * originalScale(a);

    zoomTarget.call(zoom.transform, d3.zoomIdentity.translate(tx, 0).scale(k));
}
