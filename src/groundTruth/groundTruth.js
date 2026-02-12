// src/groundTruth/groundTruth.js
// Ground truth event data handling

import { utcToEpochMicroseconds, epochMicrosecondsToUTC } from '../utils/formatters.js';

/**
 * Load ground truth data from CSV file.
 * @param {string} url - URL to CSV file
 * @returns {Promise<Array>} Ground truth events
 */
export async function loadGroundTruthData(url = 'GroundTruth_UTC_naive.csv') {
    try {
        const response = await fetch(url);
        const csvText = await response.text();
        const lines = csvText.split('\n');

        const groundTruthData = [];

        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim()) {
                const values = lines[i].split(',');
                if (values.length >= 8) {
                    groundTruthData.push({
                        eventType: values[0],
                        c2sId: values[1],
                        source: values[2],
                        sourcePorts: values[3],
                        destination: values[4],
                        destinationPorts: values[5],
                        startTime: values[6],
                        stopTime: values[7],
                        startTimeMicroseconds: utcToEpochMicroseconds(values[6]),
                        stopTimeMicroseconds: utcToEpochMicroseconds(values[7])
                    });
                }
            }
        }

        console.log(`Loaded ${groundTruthData.length} ground truth events`);
        return groundTruthData;
    } catch (error) {
        console.warn('Could not load ground truth data:', error);
        return [];
    }
}

/**
 * Filter ground truth events by selected IPs.
 * @param {Array} groundTruthData - All events
 * @param {Array} selectedIPs - Selected IP addresses
 * @returns {Array} Filtered events
 */
export function filterGroundTruthByIPs(groundTruthData, selectedIPs) {
    if (!groundTruthData || groundTruthData.length === 0 || selectedIPs.length < 2) {
        return [];
    }

    return groundTruthData.filter(event => {
        return selectedIPs.includes(event.source) && selectedIPs.includes(event.destination);
    });
}

/**
 * Compute box y and height for a ground truth overlay on one IP row,
 * targeting only the sub-row that matches the event's IP pair.
 *
 * @param {string} ip - The IP address for this box
 * @param {number} baseY - Base y position from ipPositions
 * @param {string} pairKey - Canonical IP pair key (alphabetically sorted "A<->B")
 * @param {Object} subRowLayout - {ipPairOrderByRow, ipRowHeights, rowGap}
 * @returns {{y: number, height: number, pairIndex: number}}
 */
function computeSubRowBox(ip, baseY, pairKey, subRowLayout) {
    const defaultHeight = 20;
    const SUB_ROW_GAP = 2;

    if (!subRowLayout) {
        return { y: baseY - defaultHeight / 2, height: defaultHeight, pairIndex: -1 };
    }

    const { ipPairOrderByRow, ipRowHeights, rowGap } = subRowLayout;
    const pairInfo = ipPairOrderByRow && ipPairOrderByRow.get(baseY);

    if (!pairInfo || pairInfo.count <= 1) {
        return { y: baseY - defaultHeight / 2, height: defaultHeight, pairIndex: -1 };
    }

    // Row is expanded — find the specific sub-row for this IP pair
    const pairIndex = pairInfo.order.has(pairKey) ? pairInfo.order.get(pairKey) : 0;
    const rh = (ipRowHeights && ipRowHeights.get(ip)) || rowGap || 30;
    const availableHeight = Math.max(20, rh - 6);
    const totalGaps = Math.max(0, pairInfo.count - 1) * SUB_ROW_GAP;
    const subRowHeight = Math.max(4, (availableHeight - totalGaps) / pairInfo.count);
    const centerY = baseY + pairIndex * (subRowHeight + SUB_ROW_GAP);

    return { y: centerY - subRowHeight / 2, height: subRowHeight, pairIndex };
}

/**
 * Create a canonical IP pair key (alphabetically sorted).
 */
function makePairKey(a, b) {
    return a < b ? `${a}<->${b}` : `${b}<->${a}`;
}

/**
 * Prepare ground truth box data for visualization.
 * @param {Array} events - Filtered events
 * @param {Object} options - {xScale, findIPPosition, pairs, ipPositions, eventColors, subRowLayout}
 *   subRowLayout (optional): {ipPairOrderByRow, ipRowHeights, rowGap} for expanded sub-row support
 * @returns {Array} Box data for D3
 */
export function prepareGroundTruthBoxData(events, options) {
    const { xScale, findIPPosition, pairs, ipPositions, eventColors, subRowLayout } = options;

    const boxData = [];

    events.forEach(event => {
        const sourceY = findIPPosition(event.source, event.source, event.destination, pairs, ipPositions);
        const destY = findIPPosition(event.destination, event.source, event.destination, pairs, ipPositions);

        if (sourceY === 0 || destY === 0) return;

        // Add 59 seconds to stop time for all events
        const adjustedStopMicroseconds = event.stopTimeMicroseconds + 59 * 1_000_000;

        const startX = xScale(event.startTimeMicroseconds);
        const endX = xScale(adjustedStopMicroseconds);
        const width = Math.max(1, endX - startX);

        const pairKey = makePairKey(event.source, event.destination);
        const srcBox = computeSubRowBox(event.source, sourceY, pairKey, subRowLayout);
        const dstBox = computeSubRowBox(event.destination, destY, pairKey, subRowLayout);

        // Source box — positioned at the specific sub-row for this pair
        boxData.push({
            event,
            ip: event.source,
            x: startX,
            y: srcBox.y,
            width,
            height: srcBox.height,
            color: eventColors[event.eventType] || '#666',
            isSource: true,
            pairIndex: srcBox.pairIndex,
            adjustedStartMicroseconds: event.startTimeMicroseconds,
            adjustedStopMicroseconds,
            wasExpanded: true
        });

        // Destination box — positioned at the specific sub-row for this pair
        boxData.push({
            event,
            ip: event.destination,
            x: startX,
            y: dstBox.y,
            width,
            height: dstBox.height,
            color: eventColors[event.eventType] || '#666',
            isSource: false,
            pairIndex: dstBox.pairIndex,
            adjustedStartMicroseconds: event.startTimeMicroseconds,
            adjustedStopMicroseconds,
            wasExpanded: true
        });
    });

    return boxData;
}

/**
 * Update ground truth statistics display.
 * @param {Array} groundTruthData - All events
 * @param {Array} selectedIPs - Selected IPs
 * @param {Object} eventColors - Event color map
 * @returns {Object} Stats object {html, hasMatches}
 */
export function calculateGroundTruthStats(groundTruthData, selectedIPs, eventColors) {
    if (!groundTruthData || groundTruthData.length === 0) {
        return { html: 'Ground truth data not loaded', hasMatches: false };
    }

    if (selectedIPs.length < 2) {
        return {
            html: `Loaded ${groundTruthData.length} total events<br>Select 2+ IPs to view matching events`,
            hasMatches: false
        };
    }

    const matchingEvents = filterGroundTruthByIPs(groundTruthData, selectedIPs);

    if (matchingEvents.length === 0) {
        return {
            html: `No ground truth events found for selected IPs<br>Total events: ${groundTruthData.length}`,
            hasMatches: false
        };
    }

    // Group events by type
    const eventTypeCounts = {};
    matchingEvents.forEach(event => {
        eventTypeCounts[event.eventType] = (eventTypeCounts[event.eventType] || 0) + 1;
    });

    let statsHTML = `<strong>${matchingEvents.length} matching events found</strong><br>`;
    Object.entries(eventTypeCounts).forEach(([type, count]) => {
        const color = eventColors[type] || '#666';
        statsHTML += `<span style="color: ${color}; font-weight: bold;">${type}: ${count}</span><br>`;
    });

    return { html: statsHTML, hasMatches: true };
}