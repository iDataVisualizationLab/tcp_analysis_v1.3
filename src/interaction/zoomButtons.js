// src/interaction/zoomButtons.js
// Zoom in/out button controls for quick navigation

import { ZOOM_STEP, MIN_ZOOM_RANGE_US } from '../config/constants.js';

/**
 * Setup zoom in/out button event handlers.
 *
 * @param {Object} options - Configuration options
 * @param {Function} options.getXScale - Returns current xScale
 * @param {Function} options.getTimeExtent - Returns [min, max] time extent
 * @param {Function} options.applyZoomDomain - Function to apply new zoom domain
 * @param {Function} options.setIsHardResetInProgress - Sets hard reset flag
 */
export function setupZoomButtons(options) {
    const {
        getXScale,
        getTimeExtent,
        applyZoomDomain,
        setIsHardResetInProgress
    } = options;

    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');

    if (!zoomInBtn || !zoomOutBtn) return;

    // Zoom In Button - reduce visible range by ZOOM_STEP factor, centered
    zoomInBtn.addEventListener('click', () => {
        const xScale = getXScale();
        const timeExtent = getTimeExtent();
        if (!xScale || !timeExtent) return;

        const currentDomain = xScale.domain();
        const currentRange = currentDomain[1] - currentDomain[0];
        const center = (currentDomain[0] + currentDomain[1]) / 2;

        // Already at minimum range
        if (currentRange <= MIN_ZOOM_RANGE_US) return;

        // New range is 1/ZOOM_STEP of current
        const newRange = Math.max(MIN_ZOOM_RANGE_US, currentRange / ZOOM_STEP);
        const newStart = center - newRange / 2;
        const newEnd = center + newRange / 2;

        // Don't set isHardResetInProgress - we're zooming in, not resetting to full view
        applyZoomDomain([newStart, newEnd], 'zoomButton');
        updateZoomButtonStates({ getXScale, getTimeExtent });
    });

    // Zoom Out Button - expand visible range by ZOOM_STEP factor, centered
    zoomOutBtn.addEventListener('click', () => {
        const xScale = getXScale();
        const timeExtent = getTimeExtent();
        if (!xScale || !timeExtent) return;

        const currentDomain = xScale.domain();
        const currentRange = currentDomain[1] - currentDomain[0];
        const center = (currentDomain[0] + currentDomain[1]) / 2;
        const [min, max] = timeExtent;
        const fullRange = max - min;

        // Already at full range
        if (currentRange >= fullRange * 0.99) return;

        // New range is ZOOM_STEP times current
        const newRange = Math.min(fullRange, currentRange * ZOOM_STEP);
        let newStart = center - newRange / 2;
        let newEnd = center + newRange / 2;

        // Clamp to full data extent
        if (newStart < min) {
            newStart = min;
            newEnd = Math.min(max, newStart + newRange);
        }
        if (newEnd > max) {
            newEnd = max;
            newStart = Math.max(min, newEnd - newRange);
        }

        // Only set isHardResetInProgress if zooming out to full extent
        const zoomingToFullExtent = (newStart <= min && newEnd >= max);
        if (zoomingToFullExtent) {
            setIsHardResetInProgress(true);
        }
        applyZoomDomain([newStart, newEnd], 'zoomButton');
        updateZoomButtonStates({ getXScale, getTimeExtent });
    });
}

/**
 * Update zoom button enabled/disabled states based on current zoom level.
 * Call this after any zoom operation to keep button states in sync.
 *
 * @param {Object} options - Configuration options
 * @param {Function} options.getXScale - Returns current xScale
 * @param {Function} options.getTimeExtent - Returns [min, max] time extent
 */
export function updateZoomButtonStates(options) {
    const { getXScale, getTimeExtent } = options;

    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');

    const xScale = getXScale();
    const timeExtent = getTimeExtent();

    if (!zoomInBtn || !zoomOutBtn || !xScale || !timeExtent) return;

    const currentDomain = xScale.domain();
    const currentRange = currentDomain[1] - currentDomain[0];
    const [min, max] = timeExtent;
    const fullRange = max - min;

    // Disable zoom out if already showing full range
    zoomOutBtn.disabled = currentRange >= fullRange * 0.99;

    // Disable zoom in if range is at minimum
    zoomInBtn.disabled = currentRange <= MIN_ZOOM_RANGE_US;
}
